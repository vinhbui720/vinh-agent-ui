#!/usr/bin/env python3
"""Benchmark the vinh-voice server. stdlib only. Usage: STT=https://.. TTS=https://.. python3 bench.py [quick]"""
import io, json, os, re, statistics as st, subprocess, sys, time, unicodedata, urllib.request, uuid, wave
from concurrent.futures import ThreadPoolExecutor
STT = os.environ.get("STT", "https://station1tuf.tail17c1ee.ts.net:8444")
TTS = os.environ.get("TTS", "https://station1tuf.tail17c1ee.ts.net:8445")
SM, TM, VOICE = "Systran/faster-whisper-large-v3", "vieneu-v3-turbo", "Mỹ Duyên"
N = 3 if "quick" in sys.argv else 10
NS = 3 if "quick" in sys.argv else 5
TEXT = {
 ("vi", "short"): "Xin chào, hôm nay trời đẹp lắm.",
 ("vi", "mid"): "Hôm nay mình đi chợ mua rau, thịt và trái cây, sau đó về nhà nấu cơm cho cả gia đình ăn tối.",
 ("vi", "long"): "Buổi sáng, mình thức dậy sớm, pha một ly cà phê rồi ngồi đọc tin tức. Sau đó mình mở máy tính, kiểm tra thư điện tử và lên kế hoạch cho cả ngày làm việc. Buổi trưa mình ăn cơm với đồng nghiệp, chiều họp nhóm để bàn về dự án mới, và tối về nhà tập thể dục.",
 ("en", "short"): "Hello, the weather is nice today.",
 ("en", "mid"): "Today I went to the market to buy vegetables, meat and fruit, then came home to cook dinner for the whole family.",
 ("en", "long"): "In the morning I wake up early, make a cup of coffee and read the news. Then I open my computer, check my email and plan the whole day of work. At noon I have lunch with my colleagues, in the afternoon we hold a team meeting about the new project, and in the evening I go home to exercise.",
 ("mix", "short"): "Mình đang test voice bằng English.",
 ("mix", "mid"): "Hôm nay mình có meeting lúc ba giờ chiều, nhớ gửi file report cho team trước khi họp nhé.",
 ("mix", "long"): "Sáng nay mình deploy bản mới lên server, sau đó check log thì thấy một vài warning về memory. Mình đã tạo ticket trên board để team backend review, và nhắc mọi người cập nhật document trước khi release vào cuối tuần này.",
}
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(round(p / 100 * (len(a) - 1))))] if a else float("nan")
def row(name, a, unit="s"): return f"| {name} | {len(a)} | {pct(a,50):.3f}{unit} | {pct(a,95):.3f}{unit} |" if a else f"| {name} | 0 | - | - |"
def tts(text, fmt="wav"):
    r = urllib.request.Request(TTS + "/v1/audio/speech", json.dumps({"model": TM, "voice": VOICE, "input": text, "response_format": fmt}).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=180) as f:
            first = f.read(1); ttfa = time.time() - t0; body = first + f.read()
    except urllib.error.HTTPError as e: return None, None, e.code
    return ttfa, body, time.time() - t0
def dur(wavb):  # the server streams WAV with a 0xFFFFFFFF size in the header: use the byte count
    sr = int.from_bytes(wavb[24:28], "little"); return (len(wavb) - 44) / (sr * 2)
def stt(wavb, lang):
    b = uuid.uuid4().hex; parts = b""
    for k, v in (("model", SM), ("language", lang)): parts += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    parts += f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + wavb + f"\r\n--{b}--\r\n".encode()
    r = urllib.request.Request(STT + "/v1/audio/transcriptions", parts, {"Content-Type": f"multipart/form-data; boundary={b}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=300) as f: txt = json.load(f)["text"]
    except urllib.error.HTTPError as e: return None, e.code
    return time.time() - t0, txt
def norm(s, vi):
    s = s.lower()
    if vi: s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.findall(r"[a-z0-9]+", s)
def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        p, d[0] = d[0], i
        for j, h in enumerate(hyp, 1): p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (r != h))
    return d[-1] / max(1, len(ref))
out = ["# voice bench", f"STT={STT} TTS={TTS} N={N}/{NS}", ""]
try: out.append("tailscale ping: " + subprocess.run(["tailscale", "ping", "-c", "3", "station1tuf"], capture_output=True, text=True, timeout=20).stdout.strip().replace("\n", " ; "))
except Exception as e: out.append(f"tailscale ping: n/a ({e})")
out += ["", "## TTS (pcm TTFA, wav total, RTF)", "| case | n | p50 | p95 |", "|---|---|---|---|"]
wavs = {}
for (lang, ln), text in TEXT.items():
    ttfa = [t for t in (tts(text, "pcm")[0] for _ in range(N)) if t]
    tot, rtf = [], []
    for _ in range(N):
        _, b, t = tts(text, "wav")
        if b: tot.append(t); d = dur(b); rtf.append(t / d); wavs[(lang, ln)] = b
    out += [row(f"{lang}/{ln} TTFA", ttfa), row(f"{lang}/{ln} total", tot), row(f"{lang}/{ln} RTF", rtf, "x")]
    print("tts", lang, ln, flush=True)
out += ["", "## TTS concurrency (mid vi text, pcm TTFA)", "| par | n | p50 | p95 | 429 |", "|---|---|---|---|---|"]
for par in (1, 4, 8, 16):
    with ThreadPoolExecutor(par) as ex: rs = list(ex.map(lambda _: tts(TEXT[("vi", "mid")], "pcm"), range(par * 2)))
    ok = [r[0] for r in rs if r[0]]; out.append(f"| {par} | {len(ok)} | {pct(ok,50):.3f}s | {pct(ok,95):.3f}s | {sum(1 for r in rs if r[2]==429)} |")
    print("conc", par, flush=True)
out += ["", "## STT (audio made by TTS; WER, accents stripped for vi)", "| case | n | p50 | p95 | RTF p50 | WER avg |", "|---|---|---|---|---|---|"]
def cat(ws, secs):
    ps = []; 
    while sum(dur(w) for w in ws[:len(ps)+1]) < secs and len(ps) < 40: ps.append(ws[len(ps) % len(ws)])
    return ps
sttsets = {}
for lang in ("vi", "en"):
    ws = [wavs[(lang, k)] for k in ("short", "mid", "long")]; txts = [TEXT[(lang, k)] for k in ("short", "mid", "long")]
    for k, w, t in zip(("short", "mid", "long"), ws, txts): sttsets[f"{lang}/{k} ({dur(w):.1f}s)"] = (lang, w, t)
for name, (lang, w, ref) in sttsets.items():
    ts, ws_ = [], []
    for _ in range(NS):
        t, txt = stt(w, lang)
        if t: ts.append(t); ws_.append(wer(norm(ref, lang == "vi"), norm(txt, lang == "vi")))
    d = dur(w); out.append(f"| {name} | {len(ts)} | {pct(ts,50):.3f}s | {pct(ts,95):.3f}s | {pct(ts,50)/d:.2f}x | {st.mean(ws_) if ws_ else float('nan'):.2f} |")
    print("stt", name, flush=True)
out += ["", "## STT concurrency (vi mid)", "| par | n | p50 | p95 |", "|---|---|---|---|"]
w = wavs[("vi", "mid")]
for par in (1, 2, 4):
    with ThreadPoolExecutor(par) as ex: rs = [r[0] for r in ex.map(lambda _: stt(w, "vi"), range(par * 2)) if r[0]]
    out.append(f"| {par} | {len(rs)} | {pct(rs,50):.3f}s | {pct(rs,95):.3f}s |")
out += ["", "## Round trip (record end -> first TTS audio byte)", "| lang | n | p50 | p95 |", "|---|---|---|---|"]
for lang, rep in (("vi", "Mình nghe rồi nhé."), ("en", "Got it.")):
    rt = []
    for _ in range(NS):
        t0 = time.time(); _, txt = stt(wavs[(lang, "short")], lang)
        if _ is None: continue
        tf, _, _ = tts(rep, "pcm"); rt.append(time.time() - t0) if tf else 0
    out.append(row(lang, rt))
print("\n".join(out)); open("bench-result.md", "w").write("\n".join(out) + "\n")
