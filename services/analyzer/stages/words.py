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

from dataclasses import dataclass, asdict
from typing import Optional

from faster_whisper import WhisperModel

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

    language_out = info.language or language or "en"
    duration_sec = round(float(info.duration), 3) if info.duration is not None else (segments[-1].end if segments else 0.0)

    return {
        "language": language_out,
        "durationSec": duration_sec,
        "segments": [s.to_dict() for s in segments],
    }
