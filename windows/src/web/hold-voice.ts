// Press and hold a Hermes, OpenCode or Obsidian pill (phone): Mochi jumps up big, listens (the `listen` animation)
// and records. Let go: the speech becomes text in a small box, ready to send to that chat (or as a to-do).
import { h } from "../views/dom";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { listen } from "../mochi/anims/listen";
import { drawVectorAnim } from "../mochi/vector-anim";
import { OPENCODE_PILL, newOpenCodeSession, sessionOf } from "../island/opencode";

const HOLD_MS = 450;
const target = (id: string) => id === "agent_hermes" ? "chat" : id === "integration_obsidian" ? "todo" : id === OPENCODE_PILL || id.startsWith("ocs_") ? "chat" : null;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** The listen animation on a canvas: intro, then the wait loop until `release()`, then the outro. */
function avatar(size: number) {
  const dpr = Math.min(2, devicePixelRatio || 1), c = document.createElement("canvas");
  c.width = 300 * dpr; c.height = 260 * dpr; c.style.width = `${size}px`; c.style.height = `${size * 260 / 300}px`;
  const x = c.getContext("2d")!;
  let t0 = performance.now(), t1 = 0, alive = true;
  const tick = () => {
    if (!alive) return;
    const now = performance.now(), e = Math.floor((now - t0) / 125);
    const f = t1 ? 21 + Math.min(3, Math.floor((now - t1) / 125)) : e < 5 ? e : 5 + ((e - 5) % 16);
    x.clearRect(0, 0, c.width, c.height);
    drawVectorAnim(x, listen, (f + 0.01) / listen.fps, 150 * dpr, 130 * dpr, dpr);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { el: c, release: () => { t1 = performance.now(); }, stop: () => { alive = false; } };
}

async function record(): Promise<{ stop(): Promise<string> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream), chunks: Blob[] = [];
  mr.ondataavailable = (e) => chunks.push(e.data);
  mr.start();
  return {
    stop: () => new Promise((res) => {
      mr.onstop = async () => {
        stream.getTracks().forEach((k) => k.stop());
        try {
          const u8 = new Uint8Array(await new Blob(chunks, { type: mr.mimeType }).arrayBuffer());
          let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          res((await Bridge.localStt(btoa(bin), mr.mimeType, null)) ?? "");
        } catch { res(""); }
      };
      mr.stop();
    }),
  };
}

/** Send the text where the pill points: its chat (through the chat's own send button) or the day's to-do list. */
async function deliver(id: string, kind: "chat" | "todo", text: string) {
  if (kind === "todo") { await Bridge.obsidianAdd(text, today()); return; }
  if (id === OPENCODE_PILL && !sessionOf(id)) await newOpenCodeSession().catch(() => {});
  State.setFocus(id);
  State.view = "prompt";
  State.notify();
  await new Promise((r) => setTimeout(r, 150));
  const input = document.querySelector(".chat-input") as HTMLInputElement | null;
  if (!input) return;
  input.value = text; input.dispatchEvent(new Event("input"));
  (document.querySelector(".chat-card .send-btn") as HTMLElement | null)?.click();
}

function box(id: string, kind: "chat" | "todo", text: string, name: string) {
  const ta = h("textarea", { class: "hv-text", rows: 3, placeholder: kind === "todo" ? "Task…" : "Message…" }) as HTMLTextAreaElement;
  ta.value = text;
  const err = h("div", { class: "hv-err" });
  const close = () => sheet.remove();
  const go = h("button", { class: "hv-go", onclick: async () => {
    const v = ta.value.trim(); if (!v) return;
    try { await deliver(id, kind, v); close(); } catch (e) { err.textContent = String(e).replace(/^Error:\s*/, ""); }
  } }, kind === "todo" ? "Add task" : "Send");
  const sheet = h("div", { class: "hv-sheet", onclick: (e: Event) => { if (e.target === sheet) close(); } },
    h("div", { class: "hv-box" }, h("div", { class: "hv-to" }, kind === "todo" ? "To-do · Obsidian" : name), ta, err,
      h("div", { class: "hv-row" }, h("button", { class: "hv-no", onclick: close }, "Cancel"), go)));
  document.body.append(sheet);
  ta.focus();
}

export function mountHoldVoice(island: HTMLElement) {
  let swallow = false, holding = false;
  island.addEventListener("click", (e) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
  // The long press must not select text or open the callout menu while it is held.
  island.addEventListener("contextmenu", (e) => { if (holding) e.preventDefault(); });
  document.addEventListener("selectstart", (e) => { if (holding) e.preventDefault(); });
  island.addEventListener("pointerdown", (e) => {
    // What was pressed: a pill on Home, or Mochi himself (his canvas ignores the pointer, so hit-test by position) in the chat.
    let id: string | undefined, r: DOMRect | undefined, name = "";
    const pill = (e.target as HTMLElement).closest(".pill[data-id]") as HTMLElement | null;
    if (pill) { id = pill.dataset.id; r = pill.getBoundingClientRect(); name = pill.querySelector(".lbl")?.textContent ?? ""; }
    else if (State.view === "prompt") {
      const c = document.getElementById("bot-canvas"), b = c?.getBoundingClientRect();
      if (b && Math.hypot(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2)) <= Math.min(b.width, b.height) * 0.5) {
        id = State.chatPill; r = b; name = State.focusTask?.name ?? "";
      }
    }
    const kind = id ? target(id) : null;
    if (!r || !id || !kind || e.button) return;
    const sx = e.clientX, sy = e.clientY;
    holding = true; getSelection()?.removeAllRanges();
    let on = false, up = false, rec: { stop(): Promise<string> } | null = null, ov: HTMLElement | null = null, av: ReturnType<typeof avatar> | null = null;
    const timer = setTimeout(async () => {
      on = true; swallow = true;
      navigator.vibrate?.(15);
      av = avatar(Math.min(300, innerWidth * 0.8));
      ov = h("div", { class: "hv-ov" }, av.el, h("div", { class: "hv-cap" }, `Listening… ${name}`));
      document.body.append(ov);
      // jump from the pill to the middle of the screen
      const dx = r.left + r.width / 2 - innerWidth / 2, dy = r.top + r.height / 2 - innerHeight / 2;
      av.el.animate([{ transform: `translate(${dx}px,${dy}px) scale(.1)`, opacity: 0 }, { transform: "translate(0,-60px) scale(1.15)", opacity: 1, offset: .6 }, { transform: "none" }], { duration: 520, easing: "cubic-bezier(.3,.7,.3,1)" });
      try { rec = await record(); } catch { ov.querySelector(".hv-cap")!.textContent = "Microphone unavailable"; }
      if (up) finish();
    }, HOLD_MS);
    const finish = async () => {
      if (!on || !ov || !av) return;
      av.release();
      const cap = ov.querySelector(".hv-cap") as HTMLElement;
      cap.textContent = "…";
      const text = rec ? await rec.stop() : "";
      await new Promise((r) => setTimeout(r, 500)); // let the outro play
      av.stop(); ov.remove();
      if (text.trim()) box(id, kind, text.trim(), name);
    };
    const end = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", end); removeEventListener("pointercancel", end);
      clearTimeout(timer); up = true; holding = false; setTimeout(() => { swallow = false; }, 400);
      if (on && (rec || !ov?.querySelector(".hv-cap")?.textContent?.startsWith("Listening"))) void finish();
    };
    const move = (ev: PointerEvent) => { if (!on && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) { clearTimeout(timer); holding = false; removeEventListener("pointermove", move); removeEventListener("pointerup", end); removeEventListener("pointercancel", end); } };
    addEventListener("pointermove", move); addEventListener("pointerup", end); addEventListener("pointercancel", end);
  });
}
