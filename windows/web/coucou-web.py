#!/usr/bin/env python3
"""Coucou web: the phone/PWA side of Coucou, served from the hub over Tailscale.
Binds 127.0.0.1 only; `tailscale serve --https=8443 http://127.0.0.1:8765` exposes it (tailnet only, HTTPS).
Every /api call needs the token in ~/.config/coucou/web-token (header X-Token). Stdlib only.
ponytail: one process per chat message (hermes cold start ~8 s); polling for Say cards, no web push.
"""
import json, os, re, subprocess, sys, secrets, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

HOME = Path.home()
HERE = Path(__file__).parent
PORT = int(os.environ.get("COUCOU_WEB_PORT", 8765))
TOKEN_FILE = HOME / ".config/coucou/web-token"
INBOX = HOME / ".local/share/coucou/inbox.jsonl"
HERMES = HOME / ".local/bin/hermes"
NOTEBOOK = ("You are the user's notebook assistant for their Obsidian vault (the current folder). "
            "Answer from the notes and cite them as [[Note name]]; if the notes do not say, say so. "
            "Never create, edit, move or delete a note unless the user clearly asks, and say what you changed. "
            "Reply in the user's language, briefly.\n\n")

def token():
    if not TOKEN_FILE.exists():
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(secrets.token_urlsafe(24))
        TOKEN_FILE.chmod(0o600)
    return TOKEN_FILE.read_text().strip()

def vault():
    p = os.environ.get("COUCOU_VAULT")
    if p: return Path(p).expanduser()
    cfg = json.load(open(HOME / ".config/obsidian/obsidian.json"))["vaults"].values()
    v = next((x for x in cfg if x.get("open")), next(iter(cfg)))
    return Path(v["path"])

TASK = re.compile(r"^\s*[-*] \[([ xX])\] (.+?)\s*$")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

def tasks():
    root, out = vault(), []
    for p in root.rglob("*.md"):
        if any(part.startswith(".") for part in p.relative_to(root).parts): continue
        try: lines = p.read_text().split("\n")
        except Exception: continue
        for i, l in enumerate(lines):
            m = TASK.match(l)
            if not m: continue
            due = re.search(r"📅\s*(\d{4}-\d{2}-\d{2})", m[2])
            day = due[1] if due else (p.stem if DATE.fullmatch(p.stem) else "")
            out.append({"file": str(p.relative_to(root)), "line": i, "text": m[2], "done": m[1] != " ", "day": day})
    return out

def toggle(file, line, text):
    root = vault().resolve(); p = (root / file).resolve()
    assert p.is_relative_to(root) and p.suffix == ".md", "not a note"
    lines = p.read_text().split("\n"); m = TASK.match(lines[line])
    assert m and m[2] == text.strip(), "note changed"
    at = lines[line].index("[") + 1
    lines[line] = lines[line][:at] + (" " if m[1] != " " else "x") + lines[line][at + 1:]
    p.write_text("\n".join(lines))

def add(text, day):
    assert DATE.fullmatch(day), "bad date"
    text = " ".join(text.split())
    if not text: return
    root = vault(); dailies = [p for p in root.rglob("*.md") if DATE.fullmatch(p.stem)]
    d = dailies[0].parent if dailies else root
    p = d / f"{day}.md"
    s = p.read_text() if p.exists() else f"---\ntags: [daily-note]\ndate: {day}\n---\n\n# {day}\n\n## Task\n"
    p.write_text(s + ("" if s.endswith("\n") else "\n") + f"- [ ] {text}\n")

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def authed(self):
        ok = secrets.compare_digest(self.headers.get("X-Token", ""), token())
        if not ok: self.send(401, {"error": "token"})
        return ok
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"): return self.send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/manifest.json": return self.send(200, (HERE / "manifest.json").read_bytes(), "application/manifest+json")
        if path == "/icon.png": return self.send(200, (HERE / "icon.png").read_bytes(), "image/png")
        if not self.authed(): return
        if path.startswith("/api/live/"): return self.live("GET")
        if path == "/api/tasks": return self.send(200, tasks())
        if path == "/api/inbox":
            rows = INBOX.read_text().splitlines()[-30:] if INBOX.exists() else []
            return self.send(200, [json.loads(r) for r in rows])
        self.send(404, {"error": "not found"})
    def do_POST(self):
        if not self.authed(): return
        path = urlparse(self.path).path
        if path.startswith("/api/live/"): return self.live("POST")
        try: body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except Exception: return self.send(400, {"error": "json"})
        try:
            if path == "/api/toggle": toggle(body["file"], int(body["line"]), body["text"]); return self.send(200, {})
            if path == "/api/add": add(body["text"], body["day"]); return self.send(200, {})
            if path == "/api/chat": return self.chat(body.get("text", ""), body.get("session") or "")
        except (AssertionError, KeyError, ValueError, IndexError) as e:
            return self.send(400, {"error": str(e) or "bad request"})
        self.send(404, {"error": "not found"})
    def live(self, method):
        """The Coucou app's gateway (phone_link/web.rs, 127.0.0.1:8766): sessions, approvals, OpenCode, voice."""
        import urllib.request, urllib.error
        n = int(self.headers.get("Content-Length", 0)) if method == "POST" else 0
        req = urllib.request.Request("http://127.0.0.1:8766/api/" + self.path[len("/api/live/"):], data=self.rfile.read(n) if n else (b"{}" if method == "POST" else None),
                                     method=method, headers={"X-Token": token(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return self.send(r.status, r.read())
        except urllib.error.HTTPError as e: return self.send(e.code, e.read())
        except Exception: return self.send(503, {"error": "Coucou app is not running"})
    def chat(self, text, session):
        """NDJSON stream: {"delta": whole text so far} ... then {"done": text, "session": id} or {"error": ...}."""
        self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        def out(o): self.wfile.write((json.dumps(o) + "\n").encode()); self.wfile.flush()
        if not text.strip() or len(text) > 8000: return out({"error": "empty or too long"})
        cmd = [str(HERMES), "chat", "--query-file", "-", "--oneshot", "--format", "stream-json", "-s", "obsidian"]
        if session: cmd += ["--resume", session]
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=vault(), text=True)
            p.stdin.write(text if session else NOTEBOOK + text); p.stdin.close()
            shown, sid = "", session
            for line in p.stdout:
                try: v = json.loads(line)
                except ValueError: continue
                if v.get("type") == "text":
                    shown = (shown + "\n" if shown else "") + v.get("text", ""); out({"delta": shown})
                elif v.get("type") == "result":
                    sid = v.get("session_id") or sid; shown = v.get("text") or shown
            p.wait()
            out({"done": shown, "session": sid} if shown.strip() else {"error": "Hermes gave no answer."})
        except BrokenPipeError: pass
        except Exception as e: out({"error": str(e)})

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        import tempfile
        d = Path(tempfile.mkdtemp()); os.environ["COUCOU_VAULT"] = str(d)
        add("write essay 📅 2026-10-30", "2026-10-26")
        t = tasks(); assert len(t) == 1 and t[0]["day"] == "2026-10-30" and not t[0]["done"], t
        toggle(t[0]["file"], t[0]["line"], t[0]["text"]); assert tasks()[0]["done"]
        try: toggle("../x.md", 0, "a"); assert False
        except AssertionError as e: assert "not a note" in str(e)
        print("ok"); sys.exit()
    print("token:", token())
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
