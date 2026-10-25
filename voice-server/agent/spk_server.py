"""Speaker embedding service (station1tuf). POST /embed with raw 16 kHz mono int16 PCM -> {"emb": [...192 floats]}.
Voices are compared by the agent; nothing is stored or logged here."""
import json, os, sys
import numpy as np
import sherpa_onnx
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=os.path.join(os.path.dirname(os.path.abspath(__file__)), "campplus.onnx"), num_threads=2, provider=os.environ.get("SPK_PROVIDER", "cpu")))

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/embed": return self.send_error(404)
        n = int(self.headers.get("Content-Length", 0))
        if not 0 < n <= 16000 * 2 * 30: return self.send_error(413)
        pcm = np.frombuffer(self.rfile.read(n), np.int16).astype(np.float32) / 32768
        s = ex.create_stream(); s.accept_waveform(16000, pcm); s.input_finished()
        b = json.dumps({"emb": [float(x) for x in ex.compute(s)]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8002), H).serve_forever()
