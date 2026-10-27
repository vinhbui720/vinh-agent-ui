// Hermes chat over ACP (src-tauri/src/hermes.rs): one saved session, replayed on launch. The steps Hermes took
// (tool calls) fold away under the answer; `/` lists Hermes's own commands; permission requests answer inline.
import { Bridge, onEvent } from "../core/bridge";
import { h, clear } from "./dom";
import { renderMarkdown } from "./markdown";
import { N_, t } from "../i18n/i18n";
import { speakAloud } from "../island/opencode";

type Item =
  | { k: "user" | "agent"; text: string; mid?: string }
  | { k: "tool"; id: string; title: string; status: string; text: string };
interface Cmd { name: string; description: string; input?: { hint: string } }
interface Perm { rpc: unknown; title: string; text: string; options: { id: string; name: string; kind: string }[] }

const S = {
  steps: N_("steps"),
  placeholder: N_("Message Hermes… (/ for commands)"),
};
const KEY = "hermesAcp";

export const hx = { items: [] as Item[], cmds: [] as Cmd[], perms: [] as Perm[], busy: false, ready: false };
let listeners: (() => void)[] = [];
export const onHermes = (f: () => void) => { listeners.push(f); };
let queued = 0;
const changed = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; listeners.forEach((f) => f()); }); };

let started = false;
export function initHermes() {
  if (started) return;
  started = true;
  void onEvent<Record<string, any>>("hermes-event", (e) => {
    const last = hx.items[hx.items.length - 1];
    if (e.t === "user" || e.t === "agent") {
      const text = String(e.text ?? "");
      if (last && last.k === e.t && (!e.mid || (last as { mid?: string }).mid === e.mid)) last.text += text;
      else hx.items.push({ k: e.t, text, mid: e.mid });
    } else if (e.t === "tool") hx.items.push({ k: "tool", id: e.id, title: String(e.title ?? e.kind ?? ""), status: "running", text: e.text ?? "" });
    else if (e.t === "tool_update") {
      const tl = hx.items.find((i) => i.k === "tool" && i.id === e.id) as Extract<Item, { k: "tool" }> | undefined;
      if (tl) { tl.status = e.status ?? tl.status; if (e.text) tl.text = e.text; }
    } else if (e.t === "commands") hx.cmds = e.list ?? [];
    else if (e.t === "perm") hx.perms.push({ rpc: e.rpc, title: String(e.title ?? ""), text: e.text ?? "", options: e.options ?? [] });
    else if (e.t === "session") localStorage.setItem(KEY, e.id);
    changed();
  });
}

/** Opens the saved session; its history comes back as events, so the list is emptied first. */
export async function openHermes() {
  initHermes();
  if (hx.ready) return;
  hx.items = [];
  try {
    localStorage.setItem(KEY, await Bridge.hermesOpen(localStorage.getItem(KEY)));
    hx.ready = true;
  } catch (err) { hx.items.push({ k: "agent", text: String(err).replace(/^Error:\s*/, "") }); }
  changed();
}

export async function sendHermes(text: string) {
  await openHermes();
  hx.items.push({ k: "user", text });
  hx.busy = true; changed();
  try {
    await Bridge.hermesSend(text);
    // The finished answer (what came after your message and the steps), read like OpenCode's.
    const from = hx.items.map((i) => i.k).lastIndexOf("user");
    const said = hx.items.slice(from + 1).filter((i) => i.k === "agent").map((i) => i.text).join("\n");
    if (said.trim()) speakAloud(said, "Hermes");
  }
  catch (err) { hx.items.push({ k: "agent", text: String(err).replace(/^Error:\s*/, "") }); }
  hx.busy = false; hx.perms = []; changed();
}

export async function newHermes() {
  initHermes();
  hx.items = []; hx.perms = [];
  try { localStorage.setItem(KEY, await Bridge.hermesNew()); hx.ready = true; } catch { hx.ready = false; }
  changed();
}

export const stopHermes = () => void Bridge.hermesCancel().catch(() => {});

function steps(tools: Extract<Item, { k: "tool" }>[], live: boolean): HTMLElement {
  const run = tools.find((x) => x.status !== "completed" && x.status !== "failed");
  const box = h("details", { class: "hx-steps" },
    h("summary", { text: live && run ? `${run.title}…` : `${tools.length} ${t(S.steps)}` }));
  for (const x of tools) box.append(h("div", { class: "hx-step" + (x.status === "failed" ? " bad" : "") },
    h("div", { class: "hx-step-t", text: x.title }), x.text ? h("pre", { class: "hx-step-o", text: x.text.slice(0, 1500) }) : null));
  return box;
}

/** Paints the whole conversation: your messages, folded steps, then Hermes's answer. */
export function renderHermes(log: HTMLElement) {
  clear(log);
  let group: Extract<Item, { k: "tool" }>[] = [];
  const flush = (live: boolean) => { if (group.length) log.append(h("div", { class: "chat-row" }, steps(group, live))); group = []; };
  hx.items.forEach((i) => {
    if (i.k === "tool") { group.push(i); return; }
    flush(false);
    if (i.k === "user") log.append(h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: i.text })));
    else { const r = h("div", { class: "reply" }); renderMarkdown(r, i.text); log.append(h("div", { class: "chat-row" }, r)); }
  });
  flush(hx.busy);
  for (const p of hx.perms) log.append(h("div", { class: "chat-row" }, h("div", { class: "oc-perm" },
    h("span", { class: "oc-perm-text", text: [p.title, p.text].filter(Boolean).join(": ") }),
    ...p.options.map((o) => h("button", { class: "oc-btn", text: o.name, onclick: () => {
      hx.perms = hx.perms.filter((x) => x !== p); void Bridge.hermesPermission(p.rpc, o.id); changed();
    } })))));
  if (hx.busy && !hx.items.length) log.append(h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i"))));
  log.scrollTop = log.scrollHeight;
}

/** The `/` menu: Hermes's commands that match what is typed. */
export function renderCommands(menu: HTMLElement, input: HTMLInputElement) {
  clear(menu);
  const v = input.value;
  const list = v.startsWith("/") && !v.includes(" ") ? hx.cmds.filter((c) => c.name.startsWith(v.slice(1))) : [];
  menu.style.display = list.length ? "flex" : "none";
  for (const c of list.slice(0, 8)) menu.append(h("button", { class: "hx-cmd", title: c.description, onclick: () => {
    input.value = `/${c.name} `; input.focus(); input.dispatchEvent(new Event("input"));
  } }, h("b", { text: `/${c.name}` }), h("span", { text: c.input?.hint ?? c.description })));
}

export const hermesPlaceholder = () => t(S.placeholder);
