"""
Independently re-measure the reference reel against docs/studio/01_REFERENCE_ANALYSIS.md.

The doc's numbers ARE the acceptance criteria for Milestone 2 (G1-G3 in 07_QUALITY_GATES),
so before any agent builds to them, they need to reproduce from the source file.

Reports measured-vs-claimed for: shot count, cuts/min, median shot, tempo, beat-lock ratio.
"""
import sys, statistics, json
import numpy as np
import librosa
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector

SRC = sys.argv[1] if len(sys.argv) > 1 else "/Users/sathvik/Downloads/08f77252a39a4dec9296f15ba4d17865.MP4"

# --- shots: PySceneDetect ContentDetector(27), the threshold 04_STYLE_TRANSFER §2 names
video = open_video(SRC)
sm = SceneManager()
sm.add_detector(ContentDetector(threshold=27))
sm.detect_scenes(video, show_progress=False)
scenes = sm.get_scene_list()
shots = [(s.get_seconds(), e.get_seconds()) for s, e in scenes]
durations = [round(e - s, 2) for s, e in shots]
cut_times = [s for s, _ in shots][1:]  # every shot start except the first is a cut

# --- beats: librosa (soundfile can't open MP4; demux to WAV with ffmpeg first)
import subprocess, tempfile, os
WAV = os.path.join(tempfile.gettempdir(), "ref_audio.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", SRC,
                "-ac", "1", "-ar", "22050", WAV], check=True)
y, sr = librosa.load(WAV, sr=22050, mono=True)
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
beat_times = librosa.frames_to_time(beat_frames, sr=sr)
tempo = float(np.atleast_1d(tempo)[0])

# --- beat lock: distance from each cut to its nearest beat
deltas = [float(np.min(np.abs(beat_times - t))) for t in cut_times] if cut_times else []
within_150 = sum(1 for d in deltas if d <= 0.150)
total_dur = shots[-1][1] if shots else 0.0

claimed = {
    "shots": 30, "cuts_per_min": 32.8, "median_shot_s": 1.44, "mean_shot_s": 1.83,
    "tempo_bpm": 112.3, "n_beats": 97, "median_cut_to_beat_s": 0.086,
    "beat_lock_ratio": 25 / 29, "duration_s": 54.87,
}
measured = {
    "shots": len(shots),
    "cuts_per_min": round(len(cut_times) / (total_dur / 60), 1) if total_dur else 0,
    "median_shot_s": round(statistics.median(durations), 2) if durations else 0,
    "mean_shot_s": round(statistics.mean(durations), 2) if durations else 0,
    "tempo_bpm": round(tempo, 1),
    "n_beats": len(beat_times),
    "median_cut_to_beat_s": round(statistics.median(deltas), 3) if deltas else None,
    "beat_lock_ratio": round(within_150 / len(deltas), 3) if deltas else None,
    "duration_s": round(total_dur, 2),
}

print(f"{'metric':<22} {'claimed':>10} {'measured':>10}   verdict")
print("-" * 60)
for k in claimed:
    c, m = claimed[k], measured[k]
    if isinstance(c, float) and isinstance(m, (int, float)) and c:
        drift = abs(m - c) / c
        verdict = "match" if drift <= 0.12 else f"OFF by {drift*100:.0f}%"
    else:
        verdict = "match" if c == m else "differs"
    cs = f"{c:.3f}" if isinstance(c, float) else str(c)
    ms = f"{m:.3f}" if isinstance(m, float) else str(m)
    print(f"{k:<22} {cs:>10} {ms:>10}   {verdict}")

print(f"\ncuts within 150ms of a beat: {within_150}/{len(deltas)}")
print(f"shot durations: {durations}")
json.dump({"claimed": claimed, "measured": measured, "shot_durations": durations,
           "cut_to_beat_deltas": [round(d, 3) for d in deltas]},
          open("reference_measured.json", "w"), indent=1)
