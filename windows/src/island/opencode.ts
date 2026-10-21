// OpenCode v2 → island. One poller feeds Home (the OpenCode pill: state, a step
// per running session, a badge when one waits for a permission) and the OpenCode
// chat (sessions, selected session's messages, permission requests).
// Talks to OpenCode's local API through opencode.rs; no plugin, nothing written.
// Session text is only ever shown, never logged.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { dropPendingCard } from "./hooks";
import type { Island } from "./island";

let island: Island | null = null;

export const OPENCODE_PILL = "agent_opencode";

const FAST_MS = 1500;
let timer: number | null = null;
let tick = 0;
let busy = false;
let signature = "";

export function registerOpenCode(i: Island) {
  island = i;
  if (timer != null) return;
  timer = window.setInterval(() => void poll(), FAST_MS);
  void poll();
}

/** Picks the session the chat shows and the Home tag that is highlighted. */
export function selectOpenCodeSession(id: string) {
  const t = State.tasks.find((x) => x.id === sessionPill(id));
  if (t) State.setFocus(t.id);
  else State.opencode.selected = id; // not on Home (resumed from history): the OpenCode pill's own chat
  signature = "";
  void poll(true);
}

/** The OpenCode pill's chat becomes this session (history of a folder). */
export function resumeOpenCodeSession(id: string) {
  State.opencode.selected = id;
  State.opencode.panel = false;
  State.setFocus(OPENCODE_PILL);
  signature = "";
  void poll(true);
}

export function setOpenCodeDirectory(dir: string) {
  State.opencode.directory = dir;
  localStorage.setItem("ocDir", dir);
  State.notify();
}

/** A new empty session in the chosen folder, shown in the OpenCode pill's chat. */
export async function newOpenCodeSession(): Promise<string> {
  const dir = State.opencode.directory;
  const id = await Bridge.opencodeCreate(dir);
  resumeOpenCodeSession(id);
  return id;
}

async function poll(force = false) {
  const pill = State.tasks.find((t) => t.id === OPENCODE_PILL);
  if (!pill || State.paused || busy) return;
  // Chat of a session that is not on Home: still has to be read.
  const oc = State.opencode;
  // Hidden island: a slow look is enough to keep the pill honest.
  if (!force && State.mode === "hidden" && tick++ % 4 !== 0) return;
  busy = true;
  try {
    const sessions = await Bridge.opencodeSessions();
    const pending = await Bridge.opencodePermissions().catch(() => []);
    const messages = oc.selected ? await Bridge.opencodeMessages(oc.selected) : null;
    // Every session gets its own pill, so each one is its own tab on Home.
    const perSession = new Map<string, Awaited<ReturnType<typeof Bridge.opencodeMessages>>>();
    for (const s of sessions) {
      perSession.set(s.id, s.id === oc.selected && messages ? messages : await Bridge.opencodeMessages(s.id).catch(() => []));
    }
    const sig = JSON.stringify([
      sessions.map((s) => [s.id, s.title, s.running]), pending.map((p) => p.id), oc.selected,
      [...perSession].map(([id, m]) => [id, m.map((x) => [x.id, x.text.length])]),
    ]);
    oc.error = "";
    if (sig === signature) return;
    signature = sig;
    oc.sessions = sessions;
    oc.pending = pending;
    if (messages) {
      State.chats[OPENCODE_PILL] = messages.map((m, i) => ({ id: i, role: m.role, content: m.text }));
      oc.lines = messages.filter((m) => m.role === "assistant").slice(-5)
        .map((m) => m.text.trim().split("\n")[0].slice(0, 90));
    }
    applyToPill(pill.id);
    syncSessionPills(sessions, perSession);
    syncApproval();
    State.notify();
  } catch (err) {
    const msg = String(err).replace(/^Error:\s*/, "");
    if (msg === oc.error && oc.sessions.length === 0) return;
    oc.error = msg;
    oc.sessions = [];
    oc.pending = [];
    signature = "";
    applyToPill(pill.id);
    syncSessionPills([], new Map());
    syncApproval();
    State.notify();
  } finally {
    busy = false;
  }
}

/** The pill shows what OpenCode is doing: a step per running session, and a badge for a waiting request. */
function applyToPill(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  const running = State.opencode.sessions.filter((s) => s.running);
  t.state = running.length ? "working" : "idle";
  t.steps = State.opencode.lines.length ? State.opencode.lines : running.map((s) => s.title || s.directory.split("/").pop() || s.id);
  t.stepIndex = Math.max(0, t.steps.length - 1);
  t.stepSeq = t.steps.length - 1;
  const waiting = State.opencode.pending.length > 0;
  if (waiting && State.focusId !== id) t.pillBadge = "approval";
  else if (!waiting && t.pillBadge === "approval") t.pillBadge = null;
}

/** A waiting OpenCode request becomes the island's own approval card (Allow / Deny). */
/** Requests already answered here, so a late poll cannot raise their card again. */
export const answered = new Set<string>();

function syncApproval() {
  const first = State.opencode.pending[0];
  const own = sessionPill(first?.sessionId ?? "");
  // The session's own pill, else the OpenCode pill: never the main (Claude Code) pill.
  const pillId = State.tasks.some((t) => t.id === own) ? own : OPENCODE_PILL;
  const cur = State.pendingApproval;
  if (!first) {
    if (cur?.requestId.startsWith("oc:") && island) dropPendingCard(island);
    return;
  }
  if (cur || !island) return; // one card at a time
  if (answered.has(first.id)) return;
  State.beginApproval({
    requestId: `oc:${first.sessionId}:${first.id}`,
    sessionId: first.sessionId,
    pillId,
    tool: first.action,
    command: first.resources.join(" ") || first.action,
  });
  State.updateTask(pillId, "approval");
  island.alert("approval");
}

export const sessionPill = (sessionId: string) => `ocs_${sessionId}`;

/** The OpenCode session a pill shows: its own, or the selected one for the main OpenCode pill. */
export function sessionOf(pill: string): string | null {
  if (pill.startsWith("ocs_")) return pill.slice(4);
  return pill === OPENCODE_PILL ? State.opencode.selected : null;
}

/** One pill per session: named after it, working while it runs, gone when it ends. */
function syncSessionPills(
  sessions: { id: string; title: string; directory: string; running: boolean }[],
  msgs: Map<string, { role: string; text: string }[]>,
) {
  const color = State.tasks.find((t) => t.id === OPENCODE_PILL)?.color ?? "#4ADE80";
  const alive = new Set(sessions.map((s) => sessionPill(s.id)));
  for (const t of [...State.tasks]) {
    if (t.id.startsWith("ocs_") && !alive.has(t.id)) {
      State.removeTask(t.id);
      delete State.chats[t.id];
    }
  }
  for (const s of sessions) {
    const id = sessionPill(s.id);
    const name = s.title || s.directory.split("/").pop() || s.id;
    State.upsertExternalAgent(id, name, color);
    const t = State.tasks.find((x) => x.id === id);
    if (!t) continue;
    const m = msgs.get(s.id) ?? [];
    State.chats[id] = m.map((x, i) => ({ id: i, role: x.role as "user" | "assistant", content: x.text }));
    t.name = name;
    t.sessionCwd = s.directory;
    t.steps = m.filter((x) => x.role === "assistant").slice(-5).map((x) => x.text.trim().split("\n")[0].slice(0, 90));
    t.stepIndex = Math.max(0, t.steps.length - 1);
    t.stepSeq = t.steps.length - 1;
    if (State.pendingApproval?.pillId !== id) t.state = s.running ? "working" : "idle";
  }
}
