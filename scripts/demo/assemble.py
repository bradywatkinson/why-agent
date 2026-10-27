#!/usr/bin/env python3
"""Assemble media/demo.mp4 from cards, the recorded app session and Piper narration."""
import json, subprocess, os
B = "/workspace/demo-build"; OUT = "/workspace/openagent/media/demo.mp4"
segs = {s["id"]: s for s in json.load(open(f"{B}/segments.json"))}
mk = {m["id"]: m["t"] for m in json.load(open(f"{B}/markers.json"))}
order = ["s02_live", "s03_ask", "s04_guard", "s05_scan", "s06_answer", "s07_cite", "s08_checks", "s09_memory", "s10_inject"]
nxt = {k: (order[i + 1] if i + 1 < len(order) else "end") for i, k in enumerate(order)}
VF = "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p"
run = lambda a: subprocess.run(a, check=True, capture_output=True)
os.makedirs(f"{B}/parts", exist_ok=True)
parts = []

def audio_args(seg_id, dur, delay=0.35):
    # narration (if any) delayed slightly and padded/trimmed to the segment duration
    if seg_id is None:
        return ["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=22050:cl=mono"], "[1:a]aresample=48000,atrim=0:%.3f[a]" % dur
    d = int(delay * 1000)
    return ["-i", f"{B}/audio/{seg_id}.wav"], "[1:a]adelay=%d,apad,atrim=0:%.3f,aresample=48000[a]" % (d, dur)

def card(name, png, seg_id, dur, fade_in=True):
    out = f"{B}/parts/{name}.mp4"
    ain, af = audio_args(seg_id, dur)
    vf = f"[0:v]{VF},fade=t=in:st=0:d=0.5,fade=t=out:st={dur-0.5:.2f}:d=0.5[v]" if fade_in else f"[0:v]{VF}[v]"
    run(["ffmpeg", "-y", "-loop", "1", "-t", str(dur), "-i", png, *ain, "-filter_complex", f"{vf};{af}", "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-t", str(dur), out])
    parts.append(out)

def clip(seg_id):
    a, b = mk[seg_id], mk[nxt[seg_id]]
    src = b - a
    if seg_id == "s05_scan":
        dur = segs[seg_id]["dur"] + 1.0
        speed = src / dur
        v = f"[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{speed:.4f},{VF}[v]"
    else:
        dur = src
        v = f"[0:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS,{VF}[v]"
    ain, af = audio_args(seg_id, dur)
    out = f"{B}/parts/{seg_id}.mp4"
    run(["ffmpeg", "-y", "-i", f"{B}/app.webm", *ain, "-filter_complex", f"{v};{af}", "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-t", f"{dur:.3f}", out])
    parts.append(out)
    return dur

card("c0_title", f"{B}/card_title.png", "s00_title", round(segs["s00_title"]["dur"] + 1.3, 2))
p1 = segs["s01_proof"]["dur"] + 1.0
card("c1_proof1", f"{B}/card_proof1.png", "s01_proof", round(p1 * 0.5, 2))
# second half of the proof narration continues over the Zetaris UI shot
run(["ffmpeg", "-y", "-ss", f"{p1*0.5 - 0.35:.3f}", "-i", f"{B}/audio/s01_proof.wav", f"{B}/audio/s01b.wav"])
card("c1_proof2", f"{B}/card_proof2.png", "s01b", round(p1 * 0.5 + 0.8, 2))
for s in order: clip(s)
card("c9_end", f"{B}/card_end.png", "s11_end", round(segs["s11_end"]["dur"] + 2.0, 2))

with open(f"{B}/parts/list.txt", "w") as f:
    for p in parts: f.write(f"file '{p}'\n")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", f"{B}/parts/list.txt", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
     "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", OUT])
print(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height", "-of", "compact", OUT]).decode())
