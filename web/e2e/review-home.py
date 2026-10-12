"""Build a throwaway WTS_HOME for the review page's browser test (web/e2e/review.spec.ts).

Run from web/:  uv run --project ../pipeline python e2e/review-home.py <dir>

<dir> is deleted and recreated. It gets state.db with one episode (number 1) that is
transcribed and chunked by the real `chunk_episode`, its transcript JSON, a silent WAV as the
audio, and a corrections.yaml (the test edits this copy, never the repo's).

The transcript has 40 words in three sentences. They are spread over 90 s so that the real
chunker, which closes a chunk at about 30 s, makes three chunks (0 s, 38 s and 80 s); two words
have probability 0.2 ("sets", and the small word "Then") and the rest 0.9. The sentence at 38 s
holds "tight bond".
"""

import json
import os
import shutil
import sys
import wave
from pathlib import Path

DURATION_S = 90

# (first start in seconds, seconds between word starts, text)
SENTENCES = [
    (0.0, 0.625, "Today we are talking about glue and how a good clamp helps every project."),
    (38.0, 0.65, "Honestly a tight bond is what you want when the glue sets up quickly."),
    (80.0, 0.6, "Then I let it cure overnight before taking the clamps off again."),
]
# "Then" is a small word at the start of a sentence: Whisper doubts those all the time, and the
# page does not mark them.
LOW_WORDS = {"sets", "Then"}

CORRECTIONS = """\
# Whole-word transcript fixes for the review page's browser test.
global:
  # A harmless rule that matches nothing in the transcript.
  zzyzx: Zzyzx
"""


def main(target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    os.environ["WTS_HOME"] = str(target)

    from wts.chunking import chunk_episode
    from wts.db import connect
    from wts.paths import resolve_paths

    paths = resolve_paths()
    paths.transcripts_dir.mkdir(parents=True)
    paths.audio_dir.mkdir(parents=True)

    stem = "2020-01-01_ep001_review-test"
    segments = []
    for start, step, text in SENTENCES:
        words = []
        for i, token in enumerate(text.split()):
            low = token in LOW_WORDS
            words.append(
                {
                    "start": round(start + i * step, 3),
                    "end": round(start + i * step + 0.5, 3),
                    "word": f" {token}",
                    "probability": 0.2 if low else 0.9,
                }
            )
        segments.append(
            {
                "start": words[0]["start"],
                "end": words[-1]["end"],
                "text": f" {text}",
                "no_speech_prob": 0.01,
                "avg_logprob": -0.2,
                "words": words,
            }
        )
    transcript = paths.transcripts_dir / f"{stem}.json"
    transcript.write_text(
        json.dumps({"meta": {"guid": "g", "title": "Review test", "duration_s": DURATION_S},
                    "segments": segments})
    )

    audio = paths.audio_dir / f"{stem}.wav"
    rate = 8000
    with wave.open(str(audio), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * rate * DURATION_S)

    conn = connect(paths.state_db)
    cur = conn.execute(
        "insert into episodes (guid, number, title, published_at, duration_s, audio_url, "
        "page_url, stem, status, audio_path, transcript_path, updated_at) "
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "guid-1", 1, "The review test episode", "2020-01-01T00:00:00+00:00", DURATION_S,
            "https://cdn.example/ep1.mp3", "https://woodtalkshow.com/ep1", stem, "chunked",
            str(audio), str(transcript), "2020-01-01T00:00:00+00:00",
        ),
    )
    conn.commit()
    row = conn.execute("select * from episodes where id = ?", (cur.lastrowid,)).fetchone()
    chunk_episode(conn, row, [])
    conn.close()

    (target / "corrections.yaml").write_text(CORRECTIONS)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: review-home.py <dir>")
    main(Path(sys.argv[1]).resolve())
