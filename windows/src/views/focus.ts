// Focus pill card: pick minutes + one tab/window, then a countdown. Off target: red card, angry Mochi, bell (host: src-tauri/src/focus.rs).
import { h } from "./dom";
import { State } from "../core/state";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { angry } from "../mochi/anims/angry";
import { drawVectorAnim } from "../mochi/vector-anim";
import { N_ } from "../i18n/i18n";

export const FOCUS_PILL = "integration_focus";
interface T { kind: string; id: string; title: string }
interface Snap { phase?: string; remaining?: number; total?: number; targets?: T[]; violations?: number; closeIn?: number }

let minutes = 25, picked: T[] = [], targets: { tabs: T[]; windows: T[] } | null = null, loading = false;
let bell = 0, hold = 0, open = false, err = "";
/** Card cache key: the card is rebuilt on a phase change only; local picks repaint in place. */
export const focusRev = () => focusSnap().phase ?? "idle";
let root: HTMLElement | null = null;
const redraw = () => { if (root?.isConnected) paint(root); };

export const focusSnap = (): Snap => (State.integrations[FOCUS_PILL]?.data ?? {}) as Snap;

/** Bell every 2 s while the alert lasts, one happy chime at the end. Called from the integration handler. */
export function onFocusUpdate(data: Snap, reveal: () => void) {
  for (const e of document.querySelectorAll<HTMLElement>(".fc-time[data-t]")) e.textContent = mmss(data.remaining);
  for (const e of document.querySelectorAll<HTMLElement>(".fc-close")) e.textContent = `${N_("Closing in")} ${Math.max(0, data.closeIn ?? 0)}s`;
  if (data.phase === "alert" && !bell) {
    reveal(); State.setFocus(FOCUS_PILL);
    Sound.play("error");
    bell = window.setInterval(() => Sound.play("error"), 2000);
  } else if (data.phase !== "alert" && bell) { clearInterval(bell); bell = 0; }
  if (data.phase === "done") { Sound.play("finish"); reveal(); State.setFocus(FOCUS_PILL); }
}

const same = (a: T, b: T) => a.id === b.id && a.kind === b.kind;
const isPicked = (t: T) => picked.some((p) => same(p, t));
const mmss = (s = 0) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function mochi(size: number) {
  const dpr = Math.min(2, devicePixelRatio || 1), c = document.createElement("canvas");
  c.width = 300 * dpr; c.height = 260 * dpr; c.style.width = `${size}px`; c.style.height = `${size * 260 / 300}px`;
  const x = c.getContext("2d")!, t0 = performance.now();
  const tick = () => {
    if (!c.isConnected && performance.now() - t0 > 500) return;
    x.clearRect(0, 0, c.width, c.height);
    drawVectorAnim(x, angry, (performance.now() - t0) / 1000, 150 * dpr, 130 * dpr, dpr);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return c;
}

async function load() {
  if (loading) return; loading = true;
  try { targets = await Bridge.focusTargets(); } catch (e) { err = String(e); targets = { tabs: [], windows: [] }; }
  loading = false; redraw();
}

const chip = (text: string, on: boolean, f: () => void) => h("button", { class: "fc-chip" + (on ? " on" : ""), text, onclick: f });

function endEarly(label: unknown) {
  const b = h("button", { class: "fc-end", text: label as string });
  b.addEventListener("pointerdown", () => {
    b.classList.add("holding");
    hold = window.setTimeout(() => void Bridge.focusStop(), 2000);
  });
  const up = () => { clearTimeout(hold); b.classList.remove("holding"); };
  b.addEventListener("pointerup", up); b.addEventListener("pointerleave", up);
  return b;
}

export function focusCard(): HTMLElement {
  root = h("div", { class: "fc-root" });
  paint(root);
  return root;
}

function paint(host: HTMLElement) {
  host.replaceChildren(build());
}

function build(): HTMLElement {
  const s = focusSnap(), phase = s.phase ?? "idle";
  if (phase === "run" || phase === "alert") {
    const alert = phase === "alert";
    return h("div", { class: "fc fc-run" + (alert ? " fc-alert" : "") },
      alert ? mochi(110) : null,
      h("div", { class: "fc-main" },
        h("div", { class: "fc-time", "data-t": "1", text: mmss(s.remaining) }),
        h("div", { class: "fc-sub", text: alert ? `${N_("Back to")}: ${(s.targets ?? []).map((t) => t.title).join(", ")}` : (s.targets ?? []).map((t) => t.title).join(", ") }),
        alert ? h("div", { class: "fc-sub fc-close", text: `${N_("Closing in")} ${Math.max(0, (s.closeIn ?? 0))}s` }) : null,
        endEarly(N_("Hold to end early"))));
  }
  if (phase === "done") {
    return h("div", { class: "fc fc-done" },
      h("div", { class: "fc-time", text: N_("Focus complete") }),
      h("div", { class: "fc-sub", text: `${Math.round((s.total ?? 0) / 60)} min · ${s.violations ?? 0} ${N_("distractions")}` }),
      h("button", { class: "fc-chip on", text: N_("OK"), onclick: () => void Bridge.focusStop() }));
  }
  if (!targets && !loading) void load(); // ready before the user opens the list
  const all = [...(targets?.tabs ?? []), ...(targets?.windows ?? [])];
  if (open) {
    return h("div", { class: "fc" },
      h("div", { class: "fc-row" },
        chip(N_("‹ Back"), false, () => { open = false; redraw(); }),
        chip(N_("Refresh"), false, () => { err = ""; void load(); redraw(); }),
        picked.length ? chip(`${N_("OK")} (${picked.length})`, true, () => { open = false; redraw(); }) : null),
      h("div", { class: "fc-list" }, ...(all.length ? all.map((t) => h("button", {
        class: "fc-opt" + (isPicked(t) ? " on" : ""),
        onclick: () => { picked = isPicked(t) ? picked.filter((p) => !same(p, t)) : [...picked, t]; redraw(); } },
        h("i", { text: isPicked(t) ? "✓" : t.kind === "tab" ? "TAB" : "APP" }), h("span", { text: t.title })))
        : [h("div", { class: "fc-sub", text: loading ? "…" : err || N_("Nothing found") })])));
  }
  return h("div", { class: "fc" },
    h("div", { class: "fc-row" }, ...[15, 25, 45, 60].map((m) => chip(`${m}m`, minutes === m, () => { minutes = m; redraw(); }))),
    h("button", { class: "fc-pick", onclick: () => { open = true; err = ""; void load(); redraw(); } },
      h("span", { text: picked.length ? picked.map((t) => t.title).join(", ") : N_("Pick tabs or apps") }), h("b", { text: "▾" })),
    h("div", { class: "fc-row" },
      h("button", { class: "fc-chip go", text: N_("Start"), disabled: !picked.length, onclick: () => { if (picked.length) void Bridge.focusStart(minutes, picked); } })));
}
