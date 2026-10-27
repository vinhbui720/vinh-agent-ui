"""Supertonic 3 on the GPU behind POST /v1/audio/speech (OpenAI shape, same as the old VieNeu server).

  model            ignored (reported back)
  input            text; split into sentences, each synthesized and sent as soon as it is ready
  voice            F1..F5 / M1..M5; anything else (old VieNeu names) -> SUPERTONIC_VOICE (F1)
  lang             optional "vi" | "en"; default: Vietnamese if the text has Vietnamese letters, else English
  response_format  "wav" (header, unknown length) | "pcm" (s16le mono)
  sample_rate      default 44100; any rate is resampled (24000 is what the Coucou island asks for)
  stream_format    accepted ("audio"); the body is always chunked raw audio
GET /v1/voices lists the voices. HOST/PORT from env (default 127.0.0.1:8001).
"""
import json, os, re, struct, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from scipy.signal import resample_poly
from math import gcd
import supertonic.loader as L

L.DEFAULT_ONNX_PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]
from supertonic import TTS

tts = TTS()
RATE = tts.sample_rate
VOICES = list(tts.voice_style_names)
DEFAULT = os.environ.get("SUPERTONIC_VOICE", "F1")
STYLES = {v: tts.get_voice_style(v) for v in VOICES}
GPU = threading.Lock()  # one synthesis at a time; each takes ~0.1 s
VI = re.compile(r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]", re.I)
SENT = re.compile(r"[^.!?…。！？\n]+[.!?…。！？]*[\"')\]]*\s*")
for _l in ("en", "vi"): tts.synthesize("warm up", voice_style=STYLES[DEFAULT], lang=_l)


def sentences(text, cap=300):
    out = []
    for s in SENT.findall(text) or [text]:
        if out and len(out[-1]) < 40 and len(out[-1]) + len(s) <= cap: out[-1] += s
        else: out.append(s)
    res = []
    for s in out:
        s = s.strip()
        while len(s) > cap:
            at = s.rfind(" ", 0, cap); at = at if at > 60 else cap
            res.append(s[:at].strip()); s = s[at:].strip()
        if s: res.append(s)
    return res


PAD = 0.08  # seconds of quiet kept at each end of a sentence; the model pads ~0.5 s, which is a long gap between sentences


def trim(a):
    loud = np.flatnonzero(np.abs(a) > 0.02)
    if loud.size == 0: return a
    k = int(PAD * RATE)
    return a[max(0, loud[0] - k): loud[-1] + k + 1]


def pcm16(wav, rate):
    a = trim(np.asarray(wav, dtype=np.float32).reshape(-1))
    if rate != RATE:
        g = gcd(RATE, rate); a = resample_poly(a, rate // g, RATE // g)
    return (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()


def wav_header(rate):  # unknown length, plays as it streams
    return b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a): pass  # never log request text

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/voices", "/v1/models", "/health", ""):
            return self.reply(200, {"object": "list", "data": [{"id": v, "name": v, "gender": "female" if v[0] == "F" else "male"} for v in VOICES]})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/audio/speech": return self.reply(404, {"error": "not found"})
        try:
            r = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            text = str(r["input"]).strip()
            if not text: raise ValueError("empty input")
            fmt = r.get("response_format", "wav")
            if fmt not in ("wav", "pcm"): raise ValueError("response_format must be wav or pcm")
            rate = int(r.get("sample_rate") or RATE)
            if not 8000 <= rate <= 48000: raise ValueError("sample_rate out of range")
            lang = r.get("lang") or ("vi" if VI.search(text) else "en")
            if lang not in ("vi", "en"): raise ValueError("lang must be vi or en")
            voice = r.get("voice") if r.get("voice") in STYLES else DEFAULT
        except Exception as e:
            return self.reply(400, {"error": str(e)})
        parts = sentences(text[:6000])
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav" if fmt == "wav" else "audio/pcm")
        self.send_header("Transfer-Encoding", "chunked"); self.end_headers()

        def chunk(b):
            self.wfile.write(b"%x\r\n" % len(b) + b + b"\r\n"); self.wfile.flush()
        try:
            if fmt == "wav": chunk(wav_header(rate))
            for p in parts:
                with GPU: w, _ = tts.synthesize(p, voice_style=STYLES[voice], lang=lang)
                chunk(pcm16(w, rate))  # a closed connection raises here: the rest is never synthesized
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8001"))), H).serve_forever()
