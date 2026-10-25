// Replaces Tauri's invoke/listen with HTTP + a server-sent event stream to the desktop app
// (phone_link/web.rs). No token: the tailnet is the lock.
const w = window as any;
w.__COUCOU_WEB__ = true;
document.documentElement.classList.add("web");
history.replaceState(null, "", location.pathname); // old links carried a token in the hash
const headers = () => ({ "Content-Type": "application/json" });

let nextId = 1;
const lastState = new Map<string, unknown>(); // latest web-state, for late listeners
const cbs = new Map<number, (e: unknown) => void>();
const listeners = new Map<string, Map<number, number>>(); // event -> eventId -> callback id

w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "island" }, currentWebview: { windowLabel: "island", label: "island" } },
  transformCallback(cb: (e: unknown) => void) {
    const id = nextId++;
    cbs.set(id, cb);
    return id;
  },
  unregisterCallback: (id: number) => cbs.delete(id),
  convertFileSrc: (p: string) => p,
  async invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === "plugin:event|listen") {
      const eid = nextId++;
      const m = listeners.get(args.event as string) ?? new Map();
      m.set(eid, args.handler as number);
      listeners.set(args.event as string, m);
      // The stream may have delivered this before anyone listened: hand over the latest.
      const late = lastState.get(args.event as string);
      if (late !== undefined) setTimeout(() => { try { cbs.get(args.handler as number)?.({ event: args.event, id: eid, payload: late }); } catch {} }, 0);
      return eid;
    }
    if (cmd.startsWith("plugin:")) return null;
    if (cmd === "open_url" && String(args.url).startsWith("obsidian://")) {
      // iOS cannot open obsidian://: show the note in the app's own Notes panel.
      const f = new URL(String(args.url)).searchParams.get("file");
      w.__openNotes?.(f);
      return null;
    }
    if (cmd === "open_url") {
      window.open(String(args.url), "_blank");
      return null;
    }
    const r = await fetch("/api/rpc", { method: "POST", headers: headers(), body: JSON.stringify({ cmd, args }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
    return j;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event: string, eid: number) {
    listeners.get(event)?.delete(eid);
  },
};

async function stream() {
  for (;;) {
    try {
      const r = await fetch("/api/events", { headers: headers() });
      const rd = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!chunk.startsWith("data: ")) continue;
          const { event, payload } = JSON.parse(chunk.slice(6));
          if (event === "web-state") lastState.set(event, payload);
          for (const [eid, cid] of listeners.get(event) ?? []) try { cbs.get(cid)?.({ event, id: eid, payload }); } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}
void stream();

// Offline: the app shell loads from cache, so the notes work with no network.
if ("serviceWorker" in navigator) {
  // Old tabs and Home Screen apps follow the newest files: update on every start/return, reload when a new worker takes over.
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((r) => {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void r.update(); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had) location.reload(); });
}

// Boot: the phone has no global cursor and its own screen.
const real = w.__TAURI_INTERNALS__.invoke;
w.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: Record<string, unknown>) => {
  const v = await real(cmd, args);
  if (cmd === "boot" && v) {
    v.cursorPoll = false;
    v.screen = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scale: 1 };
  }
  return v;
};
// iOS audio needs a tap.
addEventListener("touchstart", () => new AudioContext().resume().catch(() => {}), { once: true });
// iPhone keyboard: it shrinks the visual viewport, not the page. Follow it so the header
// stays on screen and the composer sits right above the keys.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty("--vvt", `${vv.offsetTop}px`);
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("resize"));
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
}
// Coming back to the app after a while: reload, so the hello scene plays again (also on a bfcache restore).
let away = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) away = Date.now();
  else if (away && Date.now() - away > 5_000) w.__greet?.();
});
window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
export {};
