// The Notes panel of the web app: list of the host's vault, a note in View or Edit, offline
// saves that sync on their own. Drawn over the island, in its colours, with Mochi as avatar.
// ponytail: English labels only (web panel); route them through tl()/N_() when it ships to desktop.
import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { createMiniBot } from "../mochi/minibots";
import { toggleTask, noteTitle } from "./notes-merge";
import { render } from "./notes-render";
import * as S from "./notes-store";
import { State } from "../core/state";

const PENCIL = "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4";
const PIN = "M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3-1-6z";

let entries: S.Entry[] = [];
let paths: string[] = [];
let cur: S.Doc | null = null;
let mode: "view" | "edit" = "view";
let query = "";
let saveTimer = 0;
const openDirs = new Set<string>(JSON.parse(localStorage.getItem("ntOpen") ?? "[]"));
let toggleOff = () => {};

const bar = h("div", { class: "nt-bar" });
const body = h("div", { class: "nt-body" });
const tools = h("div", { class: "nt-tools" });
export const panel = h("div", { class: "nt-panel" }, bar, body, tools);

const label: Record<S.Status, string> = { synced: "Synced", pending: "Saved on phone", offline: "Offline", syncing: "Syncing" };

function avatar(): HTMLElement {
  const a = h("div", { class: "nt-avatar" });
  a.append(createMiniBot({ id: "notes", name: "Coucou", color: "#A78BFA", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: true } as any, 26));
  return a;
}

function statusPill(): HTMLElement {
  const s = S.getStatus();
  return h("span", { class: `nt-status ${s}` }, h("i"), label[s]);
}

function btn(text: string | Node, cls: string, on: () => void, title = ""): HTMLButtonElement {
  return h("button", { class: cls, title, onclick: on }, text as any);
}

// ── Screens ──────────────────────────────────────────────────────────────────

function listScreen() {
  clear(bar); clear(body); clear(tools);
  bar.append(btn(avatar(), "nt-avatar-btn", () => toggleOff(), "Home"), h("div", { class: "nt-title" }, "Notes"), statusPill(), btn(svg(ICONS.plus, 16), "nt-icon", newNote, "New note"));
  const search = h("input", { class: "nt-search", placeholder: "Search notes", value: query, type: "search", autocapitalize: "off" }) as HTMLInputElement;
  const list = h("div", { class: "nt-list" });
  search.oninput = () => { query = search.value; fill(); };
  body.append(search, list);

  const fill = () => {
    clear(list);
    const q = query.trim().toLowerCase();
    const notes = entries.filter((e) => e.path.toLowerCase().endsWith(".md") && (!q || e.path.toLowerCase().includes(q)));
    void S.allDocs().then((docs) => {
      const pinned = new Set(docs.filter((d) => d.pinned).map((d) => d.path));
      const dirty = new Set(docs.filter((d) => d.dirty).map((d) => d.path));
      const row = (e: S.Entry, depth: number, flat: boolean) => {
        const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
        const r = h("button", { class: "nt-row", onclick: () => void open(e.path) },
          svg(pinned.has(e.path) ? PIN : ICONS.doc, 15, pinned.has(e.path) ? { stroke: 1.8 } : {}),
          h("span", { class: "nt-name" }, noteTitle(e.path)),
          dirty.has(e.path) ? h("i", { class: "nt-dot", title: "Not on the host yet" }) : null,
          flat && dir ? h("span", { class: "nt-dir" }, dir) : null);
        r.style.marginLeft = `${depth * 14}px`;
        return r;
      };
      if (!notes.length) return void list.append(h("div", { class: "nt-empty" }, q ? "Nothing matches." : "No notes yet. Tap + to write one."));
      const byTime = (a: S.Entry, b: S.Entry) => b.mtime - a.mtime;
      // Searching: a flat list of matches. Otherwise: pinned first, then the folder tree like Obsidian's.
      if (q) { for (const e of [...notes].sort(byTime).slice(0, 300)) list.append(row(e, 0, true)); return; }
      const pins = notes.filter((e) => pinned.has(e.path)).sort(byTime);
      if (pins.length) { list.append(h("div", { class: "nt-sec" }, "Pinned")); for (const e of pins) list.append(row(e, 0, true)); list.append(h("div", { class: "nt-sec" }, "Vault")); }
      type Node = { dirs: Map<string, Node>; files: S.Entry[]; newest: number };
      const root: Node = { dirs: new Map(), files: [], newest: 0 };
      for (const e of notes) {
        let n = root;
        const parts = e.path.split("/");
        for (const d of parts.slice(0, -1)) {
          if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [], newest: 0 });
          n = n.dirs.get(d)!;
          n.newest = Math.max(n.newest, e.mtime);
        }
        n.files.push(e);
      }
      const draw = (n: Node, prefix: string, depth: number) => {
        for (const [name, c] of [...n.dirs].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }))) {
          const id = prefix + name;
          const open = openDirs.has(id);
          const count = (function cnt(k: Node): number { return k.files.length + [...k.dirs.values()].reduce((t, v) => t + cnt(v), 0); })(c);
          const f = h("button", { class: `nt-row nt-folder${open ? " open" : ""}`, onclick: () => { open ? openDirs.delete(id) : openDirs.add(id); localStorage.setItem("ntOpen", JSON.stringify([...openDirs])); fill(); } },
            svg(ICONS.chevronRight, 13, { stroke: 2.2 }), svg(ICONS.folder, 15), h("span", { class: "nt-name" }, name), h("span", { class: "nt-dir" }, String(count)));
          f.style.marginLeft = `${depth * 14}px`;
          list.append(f);
          if (open) draw(c, id + "/", depth + 1);
        }
        for (const e of [...n.files].sort((x, y) => noteTitle(x.path).localeCompare(noteTitle(y.path), undefined, { numeric: true }))) list.append(row(e, depth, false));
      };
      draw(root, "", 0);
    });
  };
  fill();
}

async function noteScreen() {
  if (!cur) return listScreen();
  const d = cur;
  clear(bar); clear(body); clear(tools);
  const seg = h("div", { class: "nt-seg" },
    btn("View", mode === "view" ? "on" : "", () => void setMode("view")),
    btn(svg(PENCIL, 13, { stroke: 2 }), mode === "edit" ? "on" : "", () => void setMode("edit"), "Edit"));
  bar.append(
    btn(svg(ICONS.chevronLeft, 16), "nt-icon", () => void close(), "Notes"),
    avatar(),
    h("div", { class: "nt-title" }, noteTitle(d.path)),
    statusPill(), seg,
    btn(svg(ICONS.ellipsis, 16), "nt-icon", () => void menu(), "More"));
  if (d.conflict) {
    body.append(h("div", { class: "nt-banner" }, "Phone and host both changed a line. Both are kept: look for <<<<<<<. ",
      btn("Got it", "nt-link-btn", () => { void S.putDoc({ ...d, conflict: false }); cur = { ...d, conflict: false }; void noteScreen(); })));
  }
  if (mode === "view") {
    const page = h("div", { class: "nt-page" });
    page.innerHTML = render(d.text, paths, d.path);
    page.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.task) {
        void edit(toggleTask(cur!.text, Number(t.dataset.task)));
        e.preventDefault();
        void noteScreen();
      } else if (t.dataset?.note) void open(t.dataset.note);
      else if (t.closest("a[href]")) { const a = t.closest("a")!; a.target = "_blank"; a.rel = "noopener"; }
    });
    if (!d.text.trim()) page.append(h("div", { class: "nt-empty" }, "Empty note. Switch to Edit and write."));
    body.append(page);
  } else {
    const ta = h("textarea", { class: "nt-edit", spellcheck: "false", autocapitalize: "sentences", placeholder: "Write in Markdown…" }) as HTMLTextAreaElement;
    ta.value = d.text;
    ta.oninput = () => void edit(ta.value);
    body.append(ta);
    const wrap = (a: string, b = a) => () => {
      const { selectionStart: s, selectionEnd: e, value } = ta;
      ta.value = value.slice(0, s) + a + value.slice(s, e) + b + value.slice(e);
      ta.setSelectionRange(s + a.length, e + a.length);
      ta.focus(); void edit(ta.value);
    };
    const line = (p: string) => () => {
      const s = ta.selectionStart;
      const at = ta.value.lastIndexOf("\n", s - 1) + 1;
      ta.value = ta.value.slice(0, at) + p + ta.value.slice(at);
      ta.setSelectionRange(s + p.length, s + p.length);
      ta.focus(); void edit(ta.value);
    };
    for (const [t, f] of [["B", wrap("**")], ["I", wrap("*")], ["H", line("## ")], ["•", line("- ")], ["☐", line("- [ ] ")], ["[[ ]]", wrap("[[", "]]")], ["$", wrap("$")], ["`", wrap("`")]] as const)
      tools.append(h("button", { class: "nt-tool", onmousedown: (e: Event) => e.preventDefault(), onclick: f }, t));
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function edit(text: string) {
  if (!cur) return;
  cur = { ...cur, text };
  window.clearTimeout(saveTimer);
  const path = cur.path;
  saveTimer = window.setTimeout(() => void S.saveLocal(path, text), 800);
}
const flush = async () => { window.clearTimeout(saveTimer); if (cur) await S.saveLocal(cur.path, cur.text); };

async function setMode(m: "view" | "edit") {
  await flush();
  mode = m;
  cur = (await S.getDoc(cur!.path)) ?? cur;
  await noteScreen();
  if (m === "edit") (body.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
}

let tap = { x: innerWidth / 2, y: innerHeight / 2 };
addEventListener("pointerdown", (e) => { tap = { x: e.clientX, y: e.clientY }; }, true);

/** Mochi hops from where the finger was to the note's header, then the page fades in. */
function fly() {
  const to = bar.querySelector(".nt-avatar") as HTMLElement | null;
  if (!to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = to.getBoundingClientRect();
  const ghost = h("div", { class: "nt-fly" });
  ghost.append(createMiniBot({ id: "notes-fly", name: "Coucou", color: "#A78BFA", state: "working", stepIndex: 0, steps: [], source: "agent", isIntegration: true } as any, 34));
  ghost.style.left = `${r.left}px`; ghost.style.top = `${r.top}px`;
  document.body.append(ghost);
  to.style.opacity = "0"; body.style.opacity = "0";
  const dx = tap.x - 17 - r.left, dy = tap.y - 17 - r.top;
  ghost.animate([
    { transform: `translate(${dx}px,${dy}px) scale(1.4)`, opacity: 0 },
    { transform: `translate(${dx}px,${dy}px) scale(1.6)`, opacity: 1, offset: 0.15 },
    { transform: `translate(${dx * 0.35}px,${dy * 0.35 - 60}px) scale(1.3) rotate(-12deg)`, offset: 0.55 },
    { transform: "translate(0,0) scale(1)" },
  ], { duration: 650, easing: "cubic-bezier(.3,.7,.3,1)" }).onfinish = () => {
    ghost.remove(); to.style.opacity = "";
    body.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 260 }).onfinish = () => { body.style.opacity = ""; };
  };
}

async function open(path: string) {
  await flush();
  const d = await S.openNote(path);
  if (!d) { alert("This note is not saved on the phone. Connect once to open it."); return; }
  cur = d;
  mode = "view";
  await noteScreen();
  fly();
}

async function close() {
  await flush();
  cur = null;
  await refresh();
  listScreen();
}

async function newNote() {
  const raw = prompt("Name of the new note (folder/name works)", new Date().toISOString().slice(0, 10));
  const name = raw?.trim().replace(/\\/g, "/").split("/").filter((p) => p && !p.startsWith(".")).join("/");
  if (!name) return;
  const path = /\.md$/i.test(name) ? name : name + ".md";
  if (paths.includes(path)) return void open(path);
  await S.createNote(path);
  entries.push({ path, mtime: Date.now(), size: 0 }); paths.push(path);
  cur = (await S.getDoc(path))!;
  mode = "edit";
  await noteScreen();
  (body.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
}

async function menu() {
  if (!cur) return;
  const d = (await S.getDoc(cur.path)) ?? cur;
  const sheet = h("div", { class: "nt-sheet", onclick: (e: Event) => { if (e.target === sheet) sheet.remove(); } },
    h("div", { class: "nt-sheet-in" },
      btn(d.pinned ? "Unpin (stop keeping offline)" : "Pin (keep offline)", "nt-act", async () => { await flush(); await S.setPinned(d.path, !d.pinned); sheet.remove(); }),
      btn("Rename", "nt-act", async () => {
        const n = prompt("New name", d.path.replace(/\.md$/i, ""));
        sheet.remove();
        if (!n?.trim()) return;
        const to = n.trim().replace(/\.md$/i, "") + ".md";
        try { await flush(); await S.renameNote(d.path, to); cur = (await S.getDoc(to)) ?? { ...d, path: to }; await refresh(); await noteScreen(); } catch { alert("Could not rename (offline or name taken)."); }
      }),
      btn("Delete", "nt-act danger", async () => {
        sheet.remove();
        if (!confirm(`Delete "${noteTitle(d.path)}"? It goes to the vault's .trash.`)) return;
        try { await S.deleteNote(d.path); cur = null; await refresh(); listScreen(); } catch { alert("Could not delete (offline)."); }
      }),
      btn("Close", "nt-act", () => sheet.remove())));
  panel.append(sheet);
}

async function refresh() {
  const r = await S.loadIndex();
  entries = r.entries;
  paths = entries.map((e) => e.path);
}

// ── Mount ────────────────────────────────────────────────────────────────────

export async function mount(island: HTMLElement) {
  island.append(panel);
  const tab = h("button", { class: "tab nt-tab", title: "Notes", onclick: () => toggle(true) }, svg(ICONS.doc, 15));
  const tabs = island.querySelector(".tabs");
  tabs?.append(tab);
  // Any other tab or header button leaves the Notes.
  island.querySelector("#header")?.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".nt-tab")) toggle(false); }, true);
  let beat = 0;
  const toggle = (on: boolean) => {
    panel.classList.toggle("open", on);
    // The island's draw loop sleeps when nothing moves; keep it awake so Mochi blinks.
    window.clearInterval(beat);
    if (on) beat = window.setInterval(() => State.notify(), 120);
    tab.classList.toggle("on", on);
    if (on) void show();
  };
  toggleOff = () => toggle(false);
  (window as any).__openNotes = async (file?: string) => {
    toggle(true);
    if (!file) return;
    await refresh();
    const p = paths.find((x) => x.toLowerCase() === file.toLowerCase()) ?? paths.find((x) => x.toLowerCase() === file.toLowerCase() + ".md");
    if (p) void open(p);
  };
  const show = async () => { await refresh(); cur ? await noteScreen() : listScreen(); };
  S.onChange(() => { if (panel.classList.contains("open") && !(mode === "edit" && cur)) { const sp = bar.querySelector(".nt-status"); if (sp) sp.replaceWith(statusPill()); } else { const sp = bar.querySelector(".nt-status"); if (sp) sp.replaceWith(statusPill()); } });
  (window as any).__notesSynced = () => { if (panel.classList.contains("open") && !cur) void refresh().then(listScreen); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) void flush(); });
  addEventListener("pagehide", () => void flush());
  void refresh();
  void S.sync();
}
