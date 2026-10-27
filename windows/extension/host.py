#!/usr/bin/env python3
# Chrome native host: keeps the latest tab list, serves it on a Unix socket to Coucou (one JSON line in, one out).
import json, os, socket, struct, sys, threading
SOCK = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "coucou-tabs.sock")
tabs = []
out = sys.stdout.buffer
def send(o):
    b = json.dumps(o).encode(); out.write(struct.pack("<I", len(b)) + b); out.flush()
def serve(srv):
    while True:
        c, _ = srv.accept()
        try:
            r = json.loads(c.makefile().readline())
            if r.get("cmd") == "select": send({"select": r["id"]}); c.sendall(b'{"ok":true}\n')
            else: c.sendall(json.dumps({"tabs": tabs}).encode() + b"\n")
        except Exception: pass
        c.close()
try: os.unlink(SOCK)
except FileNotFoundError: pass
srv = socket.socket(socket.AF_UNIX); srv.bind(SOCK); os.chmod(SOCK, 0o600); srv.listen(4)
threading.Thread(target=serve, args=(srv,), daemon=True).start()
while True:
    h = sys.stdin.buffer.read(4)
    if len(h) < 4: break
    tabs = json.loads(sys.stdin.buffer.read(struct.unpack("<I", h)[0])).get("tabs", [])
