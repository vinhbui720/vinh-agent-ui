// Obsidian pill: where the chat would be, a month calendar (left) and the to-do
// list of the picked day (right). The tasks are the `- [ ]` lines of the vault
// (src-tauri/src/obsidian.rs); ticking one edits the note.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { language, t, tl } from "../i18n/i18n";

export const OBSIDIAN_PILL = "integration_obsidian";

interface Task { file: string; line: number; text: string; done: boolean; day: string | null }
interface Overview { vault: string; tasks: Task[]; notes: string[] }

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** What to show of a task: no #task tag, no due date (the calendar says it). */
const label = (s: string) => s.replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "").replace(/(^|\s)#task\b/g, " ").replace(/\s+/g, " ").trim();

export function buildPlanner(): { el: HTMLElement; sync(): void } {
  let data: Overview = { vault: "", tasks: [], notes: [] };
  let shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let picked = ymd(new Date());
  let all = false;
  let failed = "";
  let last = 0;

  const cal = h("div", { class: "ob-cal" });
  const list = h("div", { class: "ob-list" });
  const input = h("input", { type: "text", class: "chat-input", placeholder: tl("Add a task…"), spellcheck: "false" }) as HTMLInputElement;
  const add = h("button", { class: "send-btn", title: tl("Add") }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, add);
  // Web app only: jump to the Notes panel.
  if ((window as any).__COUCOU_WEB__) bar.prepend(h("button", { class: "send-btn", title: "Notes", onclick: () => (window as any).__openNotes?.() }, svg(ICONS.doc, 11)));
  const el = h("div", { class: "ob-plan" }, cal, h("div", { class: "ob-side" }, list, bar));

  async function refresh() {
    last = Date.now();
    try {
      data = await Bridge.obsidianOverview();
      failed = "";
    } catch (err) {
      failed = String(err).replace(/^Error:\s*/, "");
    }
    draw();
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await Bridge.obsidianAdd(text, picked).catch((err) => { failed = String(err); });
    void refresh();
  }
  add.onclick = () => void submit();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
    e.stopPropagation(); // typing is not a shortcut
  });

  function drawCalendar(open: Map<string, number>) {
    clear(cal);
    const lang = language();
    const nav = (d: number) => () => { shown = new Date(shown.getFullYear(), shown.getMonth() + d, 1); draw(); };
    cal.append(h("div", { class: "ob-head" },
      h("button", { class: "ob-nav", onclick: nav(-1) }, svg(ICONS.chevronLeft, 10, { stroke: 2 })),
      h("b", { text: shown.toLocaleDateString(lang, { month: "long", year: "numeric" }) }),
      h("button", { class: "ob-nav", onclick: nav(1) }, svg(ICONS.chevronRight, 10, { stroke: 2 })),
    ));
    const grid = h("div", { class: "ob-grid" });
    for (let i = 0; i < 7; i++) { // 2024-01-01 is a Monday: weeks start there
      grid.append(h("span", { class: "ob-dow", text: new Date(2024, 0, 1 + i).toLocaleDateString(lang, { weekday: "narrow" }) }));
    }
    const start = new Date(shown);
    start.setDate(1 - ((shown.getDay() + 6) % 7));
    const today = ymd(new Date());
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const id = ymd(d);
      const cls = ["ob-day"];
      if (d.getMonth() !== shown.getMonth()) cls.push("out");
      if (id === today) cls.push("today");
      if (id === picked && !all) cls.push("on");
      if (open.has(id)) cls.push("has");
      else if (data.notes.includes(id)) cls.push("note");
      grid.append(h("button", { class: cls.join(" "), text: String(d.getDate()),
        onclick: () => { picked = id; all = false; draw(); } }));
    }
    cal.append(grid);
  }

  function drawList() {
    clear(list);
    const pickedLabel = picked === ymd(new Date())
      ? t("Today")
      : new Date(`${picked}T00:00`).toLocaleDateString(language(), { day: "numeric", month: "short" });
    list.append(h("div", { class: "ob-tabs" },
      h("button", { class: all ? "oc-tab" : "oc-tab on", text: pickedLabel, onclick: () => { all = false; draw(); } }),
      h("button", { class: all ? "oc-tab on" : "oc-tab", text: t("All open"), onclick: () => { all = true; draw(); } }),
    ));
    const rows = data.tasks
      .filter((x) => (all ? !x.done : x.day === picked))
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.day ?? "9").localeCompare(b.day ?? "9"));
    if (failed) list.append(h("span", { class: "oc-note", text: failed }));
    else if (!rows.length) list.append(h("span", { class: "oc-note", text: t("Nothing planned") }));
    const body = h("div", { class: "ob-rows" });
    for (const x of rows) {
      body.append(h("button", { class: x.done ? "ob-task done" : "ob-task", title: x.file,
        onclick: () => void Bridge.obsidianToggle(x.file, x.line, x.text).then(refresh, (err) => { failed = String(err).replace(/^Error:\s*/, ""); draw(); }) },
        h("i", { class: "ob-box" }, x.done ? svg(ICONS.check, 9, { stroke: 2.4 }) : ""),
        h("span", { text: label(x.text) || x.text }),
        all && x.day ? h("em", { text: x.day.slice(5) }) : "",
      ));
    }
    list.append(body);
  }

  function draw() {
    const open = new Map<string, number>();
    for (const x of data.tasks) if (!x.done && x.day) open.set(x.day, (open.get(x.day) ?? 0) + 1);
    drawCalendar(open);
    drawList();
  }

  draw();
  return { el, sync() { if (Date.now() - last > 5000) void refresh(); } };
}
