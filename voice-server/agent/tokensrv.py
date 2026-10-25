"""Join-token endpoint on loopback (reached via the SSH tunnel; the API secret never leaves this box).
GET /token?room=voice&who=vinh -> {"token": ...}"""
import json, os
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from livekit import api

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/token":
            return self.send_error(404)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        t = (api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]).with_identity(q.get("who", "vinh")[:40])
             .with_attributes({"machine": "server" if q.get("machine") == "server" else "host"}).with_grants(api.VideoGrants(room_join=True, room=q.get("room", "voice")[:40])).with_ttl(timedelta(hours=12)).to_jwt())
        b = json.dumps({"token": t}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass

ThreadingHTTPServer(("127.0.0.1", 7890), H).serve_forever()
