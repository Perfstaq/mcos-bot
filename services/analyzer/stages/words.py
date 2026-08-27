"""words.py — word-level ASR (the `words` stage).

ARCHITECTURE.md §10 doc correction: "WhisperX word-level timestamps" in the
spec docs means, in the actual founder-journey code, faster-whisper + Silero
VAD via scripts/whisperx_run.py — WhisperX itself is a thin wrapper that adds
a SEPARATE wav2vec2 forced-alignment pass on top of faster-whisper's own
transcription, which pulls in torch + transformers (~1GB+) for alignment
faster-whisper already does natively via `word_timestamps=True` (its own
DTW alignment against the model's cross-attention, no extra model to load).

This stage uses faster-whisper directly rather than the `whisperx` package:
same word-level output contract (word/start/end, WordSchema-compatible), no
torch dependency at all (services/analyzer/requirements.txt has none — see
its header comment). Flagged as a deliberate, disk-motivated deviation from
literally porting whisperx_run.py, not a silent one.

VAD: faster-whisper's built-in `vad_filter=True` uses a bundled Silero ONNX
model (onnxruntime, already a transitive dep via faster-whisper/ctranslate2's
tokenizer stack) — matching "faster-whisper+Silero" without pyannote or any
torch-based VAD.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from typing import Optional

import librosa
import numpy as np
from faster_whisper import WhisperModel

from .beats import SAMPLE_RATE, demux_to_wav

_model_cache: dict[tuple[str, str, str], WhisperModel] = {}


def _get_model(model_size: str, device: str, compute_type: str) -> WhisperModel:
    key = (model_size, device, compute_type)
    if key not in _model_cache:
        _model_cache[key] = WhisperModel(model_size, device=device, compute_type=compute_type)
    return _model_cache[key]


@dataclass
class Word:
    word: str
    start: float
    end: float
    score: Optional[float]
    rms: Optional[float] = None  # librosa RMS energy over [start, end) — 02_MOTION_SYSTEM §3's emphasis scorer input

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word]

    def to_dict(self) -> dict:
        return {**{k: v for k, v in asdict(self).items() if k != "words"}, "words": [w.to_dict() for w in self.words]}


def _attach_rms(input_path: str, segments: list[Segment]) -> None:
    """RMS energy per word span, in place. 02_MOTION_SYSTEM §3's emphasis
    scorer weights `audio_energy_zscore(word)` at 1.5, and 03_RENDER_PIPELINE
    §1 promises "RMS/word" from librosa — this is that stage. Reuses the
    same demux config as the `beats` stage (SAME sample rate; ARCHITECTURE
    doesn't pin RMS the way it pins beat_track, but there is no reason to
    introduce a second decode configuration for one extra number).

    Deliberately a SECOND decode of the audio, not a shared one with the
    `beats` stage: threading a pre-loaded (y, sr) array between two
    independently-dispatched CLI stage runners would mean restructuring
    analyzer.py's stage-runner architecture for the sake of skipping one
    redundant few-hundred-ms decode on typical clip lengths — not a good
    complexity trade at this point in the milestone. Flagged, not silent."""
    wav_path = demux_to_wav(input_path)
    try:
        y, sr = librosa.load(wav_path, sr=SAMPLE_RATE, mono=True)
    finally:
        os.remove(wav_path)

    for seg in segments:
        for w in seg.words:
            i0 = max(0, int(w.start * sr))
            i1 = min(len(y), int(w.end * sr))
            clip = y[i0:i1]
            w.rms = round(float(np.sqrt(np.mean(clip.astype(np.float64) ** 2))), 6) if len(clip) else 0.0


def analyze_words(
    input_path: str,
    model_size: str = "base",
    device: str = "cpu",
    compute_type: str = "int8",
    language: Optional[str] = None,
    vad_filter: bool = True,
) -> dict:
    """Transcribe `input_path` to word-level segments. Every emitted word has
    guaranteed-numeric, monotonic start/end (falls back to the segment's own
    bounds when a word's timing is missing) so downstream boundary-snapping
    (G10, schema.ts's `wordEdges`/`snapToEdge`) never sees a null — the same
    guarantee whisperx_run.py made."""
    model = _get_model(model_size, device, compute_type)
    raw_segments, info = model.transcribe(
        input_path,
        word_timestamps=True,
        vad_filter=vad_filter,
        language=language,
    )

    segments: list[Segment] = []
    last_end = 0.0
    for seg in raw_segments:
        words: list[Word] = []
        seg_words = seg.words or []
        for w in seg_words:
            ws = float(w.start) if w.start is not None else last_end
            we = float(w.end) if w.end is not None else ws
            if we < ws:
                we = ws
            words.append(Word(word=w.word.strip(), start=round(ws, 3), end=round(we, 3), score=round(float(w.probability), 4) if w.probability is not None else None))
            last_end = we
        segments.append(Segment(start=round(float(seg.start), 3), end=round(float(seg.end), 3), text=seg.text.strip(), words=words))

    if segments:
        _attach_rms(input_path, segments)

    language_out = info.language or language or "en"
    duration_sec = round(float(info.duration), 3) if info.duration is not None else (segments[-1].end if segments else 0.0)

    return {
        "language": language_out,
        "durationSec": duration_sec,
        "segments": [s.to_dict() for s in segments],
    }
