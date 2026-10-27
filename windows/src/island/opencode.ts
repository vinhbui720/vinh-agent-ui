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
    // The chat keeps its session; only a gone one (deleted, other server) is replaced by the newest running one.
    let messages = oc.selected ? await Bridge.opencodeMessages(oc.selected).catch(() => null) : null;
    if (oc.selected && !messages) {
      const alive = sessions.find((s) => s.running) ?? sessions[0];
      oc.selected = alive?.id ?? null;
      messages = oc.selected ? await Bridge.opencodeMessages(oc.selected).catch(() => null) : null;
    } else if (!oc.selected && sessions.length) {
      oc.selected = (sessions.find((s) => s.running) ?? sessions[0]).id;
      messages = await Bridge.opencodeMessages(oc.selected).catch(() => null);
    }
    if (oc.selected) localStorage.setItem("ocSel", oc.selected); else localStorage.removeItem("ocSel");
    // Every session gets its own pill, so each one is its own tab on Home.
    const perSession = new Map<string, Awaited<ReturnType<typeof Bridge.opencodeMessages>>>();
    for (const s of sessions) {
      perSession.set(s.id, s.id === oc.selected && messages ? messages : await Bridge.opencodeMessages(s.id).catch(() => []));
    }
    // A session that just stopped has left `sessions` (only running ones are listed): its last words
    // still have to be read, so look at the ones that were open one final time.
    const live = new Set(sessions.map((s) => s.id));
    const departed = new Map<string, Awaited<ReturnType<typeof Bridge.opencodeMessages>>>();
    for (const [id, st] of spoken) {
      if (st.open && !live.has(id)) departed.set(id, await Bridge.opencodeMessages(id).catch(() => []));
    }
    const sig = JSON.stringify([
      sessions.map((s) => [s.id, s.title, s.running]), pending.map((p) => p.id), oc.selected,
      [...departed].map(([id, m]) => [id, m.map((x) => [x.id, x.text.length])]),
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
    const said = speakFinished(sessions, new Map([...perSession, ...departed]));
    // Streaming: the card is up while it is read (each sentence keeps it open), like a Hermes notice.
    if (said && island && !State.pendingApproval && !island.hovered) {
      const id = State.tasks.some((x) => x.id === sessionPill(said.sid)) ? sessionPill(said.sid) : pill.id;
      const t = State.tasks.find((x) => x.id === id);
      if (t) {
        t.finalLine = said.text.slice(0, 200);
        State.setFocus(id);
        island.alert("finished");
        noticeShown();
      }
    }
    // A session that just stopped: its answer shows as a finished notice, like Hermes'.
    for (const [id, m] of departed) {
      const last = [...m].reverse().find((x) => x.role === "assistant" && x.text.trim());
      if (!last || !island) continue;
      const one = last.text.trim().replace(/\s+/g, " ").slice(0, 200);
      State.updateTask(pill.id, "finished");
      State.appendStep(pill.id, one);
      pill.finalLine = one;
      if (!State.pendingApproval) {
        State.setFocus(pill.id);
        island.alert("finished");
        noticeShown();
      } else State.setPillBadge(pill.id, "finished");
      void id;
    }
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

// ── Spoken answers ────────────────────────────────────────────────────────────
// A running session's answer is read out loud by ElevenLabs (key in the keyring or
// ELEVENLABS_API_KEY; without one, nothing is said). Text goes to ElevenLabs only; it is never logged.

// Read as it is written: every finished sentence goes to ElevenLabs at once (all fetched in parallel,
// played in order), so the voice starts with the first sentence and never waits for the full answer.
interface Spoken { id: string | null; offset: number; fence: boolean; open: boolean }
const spoken = new Map<string, Spoken>();
let primed = false; // the first look at OpenCode is history, not read
let queue: Promise<void> = Promise.resolve();
let playing: HTMLAudioElement | null = null;
let generation = 0; // Stop bumps it: clips queued before it are dropped
let talking = 0; // clips fetched or playing

export const speechOn = () => (localStorage.getItem("ocSpeak") ?? ((window as any).__COUCOU_WEB__ ? "0" : "1")) !== "0";
import { noticeShown } from "./notices";
/** Voice volume, 0 to 1.5 (Settings → General). Read at every chunk, so a change is heard at once. */
export const voiceVolume = () => { const v = Number(localStorage.getItem("ocVolume")); return Number.isFinite(v) && localStorage.getItem("ocVolume") != null ? Math.max(0, Math.min(1.5, v)) : 1; };
export const isSpeaking = () => talking > 0;
/** Called when the last queued clip has finished (not when Stop cut it off). */
let speechEnded: (() => void) | null = null;
export const onSpeechEnded = (f: () => void) => { speechEnded = f; };

function silence() {
  generation++;
  queue = Promise.resolve();
  playing?.pause();
  playing = null;
  for (const f of cancels) f();
  cancels.clear();
  for (const src of sources) { try { src.stop(); } catch { /* already over */ } }
  sources.clear();
  talking = 0;
}

/** Stops what is being read, and the rest of the answer it came from; the next answer is read again. */
export function stopSpeech() {
  silence();
  for (const st of spoken.values()) st.offset = Number.MAX_SAFE_INTEGER;
  State.notify();
}

export function setSpeech(on: boolean) {
  localStorage.setItem("ocSpeak", on ? "1" : "0");
  if (!on) silence();
  State.notify();
}

/** What is worth hearing: no code blocks, links or markup. `st.fence` carries an open ``` across chunks. */
export function speakable(md: string, st: { fence: boolean } = { fence: false }): string {
  let out = "";
  md.split("```").forEach((part, i) => {
    if (i > 0) st.fence = !st.fence;
    if (!st.fence) out += " " + part;
  });
  return out
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** End of the last finished sentence or line in `text` after `from` (0 when none yet). */
export function sentenceEnd(text: string, from: number): number {
  let end = 0;
  const re = /[.!?…。！？]+["')\]]*(?=\s)|\n/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) end = m.index + m[0].length;
  return end;
}

const MIN = 24; // shortest clip worth a request, in characters
const LONG = 220; // an unfinished run this long is cut at a comma or space

/** A cut inside a long unfinished sentence: after the last comma or semicolon, else the last space. */
export function softEnd(text: string, from: number): number {
  const hay = text.slice(from);
  const m = [...hay.matchAll(/[,;:，；]\s/g)].pop();
  if (m) return from + m.index! + m[0].length;
  const sp = hay.lastIndexOf(" ");
  return sp > 0 ? from + sp + 1 : 0;
}

/**
 * `msgs` holds every session worth a look, listed or just departed. A session absent from `sessions`
 * (or not running) has stopped: its unread rest is read now, which is what used to be missed.
 */
export function speakFinished(
  sessions: { id: string; running: boolean; title?: string; directory?: string }[],
  msgs: Map<string, { id: string; role: string; text: string }[]>,
): { sid: string; text: string } | null {
  let said: { sid: string; text: string } | null = null;
  const first = !primed;
  primed = true;
  for (const [sid, list] of msgs) {
    const running = sessions.find((s) => s.id === sid)?.running ?? false;
    const last = [...list].reverse().find((m) => m.role === "assistant" && m.text.trim());
    let st = spoken.get(sid);
    if (!st) {
      // Unseen. At startup, or when not answering now, what is written is history. A session that
      // starts answering while we watch is read from the first word of that reply.
      const answering = !first && running && list.length > 0 && list[list.length - 1].role === "assistant";
      st = { id: last?.id ?? null, offset: answering ? 0 : last?.text.length ?? 0, fence: false, open: false };
      spoken.set(sid, st);
    }
    st.open = running;
    if (!last) continue;
    if (st.id !== last.id) { st.id = last.id; st.offset = 0; st.fence = false; }
    // Running: finished sentences (or a long run cut at a comma / space). Stopped: whatever is left.
    let cut = running ? sentenceEnd(last.text, st.offset) : last.text.length;
    if (running && cut <= st.offset && last.text.length - st.offset > LONG) cut = softEnd(last.text, st.offset);
    if (cut <= st.offset) continue;
    const trial = { fence: st.fence };
    const text = speakable(last.text.slice(st.offset, cut), trial);
    // A tiny sentence ("Ok.") waits for the next one: short clips make the voice choppy.
    if (running && text.length < MIN && text.length > 0) continue;
    st.offset = cut;
    st.fence = trial.fence;
    const s = sessions.find((x) => x.id === sid);
    const name = s ? s.title || s.directory?.split("/").pop() || "" : "";
    if (text && speechOn()) { enqueue(text, `OpenCode ${name}`.trim()); said = { sid, text }; }
  }
  return said;
}

/** Reads a message aloud (same voice, mute and stop rules as OpenCode's answers). */
export function speakAloud(text: string, who?: string) {
  const say = speakable(text);
  if (say) enqueue(say, who);
}

let lastWho = "";
// A text is read sentence by sentence, each one asked of the voice server only when the audio before it is
// nearly used up: the server's GPU works in bursts and rests while you listen.
const MAXCLIP = 160;
function enqueue(text: string, who = "") {
  if (!speechOn()) return; // muted: no request at all
  const parts: string[] = [];
  for (const sent of text.match(/[^.!?…。！？\n]+[.!?…。！？]*["')\]]*\s*/g) ?? [text]) {
    const last = parts.length - 1;
    if (last >= 0 && parts[last].length < 40 && parts[last].length + sent.length <= MAXCLIP) parts[last] += sent; // tiny ones ride along
    else parts.push(sent);
  }
  for (let p of parts) {
    p = p.trim();
    while (p.length > MAXCLIP) {
      const cut = p.lastIndexOf(" ", MAXCLIP);
      const at = cut > 60 ? cut : MAXCLIP;
      enqueue1(p.slice(0, at).trim(), who);
      p = p.slice(at).trim();
    }
    if (p) enqueue1(p, who);
  }
}

// Streamed playback. The voice machine makes audio ~2.5x faster than it plays, so chunks are pulled only
// while less than AHEAD seconds are buffered: its GPU works in short bursts and rests the rest of the time.
const AHEAD = 4; // seconds of audio kept queued
const RATE = 24000;
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let cursor = 0; // when the next chunk starts, in ctx time
const sources = new Set<AudioBufferSourceNode>();
const cancels = new Set<() => void>();

function pcm(b64: string): AudioBuffer {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const buf = (ctx ??= new AudioContext()).createBuffer(1, n, RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    ch[i] = (v > 32767 ? v - 65536 : v) / 32768;
  }
  return buf;
}

/** Streams one text into the player. Resolves once it is all queued, to a promise of when it has been heard; null when no stream could start. */
async function playStream(text: string, mine: number): Promise<{ heard: Promise<void> } | null> {
  ctx ??= new AudioContext();
  // Nothing is asked of the server until the audio already queued is about to run out.
  for (let w = cursor - ctx.currentTime - AHEAD; w > 0 && mine === generation; w = cursor - ctx.currentTime - AHEAD) {
    await new Promise((r) => setTimeout(r, Math.min(w, 0.5) * 1000));
  }
  if (mine !== generation) return { heard: Promise.resolve() };
  const id = await Bridge.ttsOpen(text).catch(() => null);
  if (!id) return null;
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  let dead = mine !== generation;
  const stop = () => { dead = true; void Bridge.ttsClose(id).catch(() => {}); };
  cancels.add(stop);
  let first = true;
  let lastEnd: Promise<void> = Promise.resolve();
  while (!dead) {
    const chunk = await Bridge.ttsPull(id).catch(() => null);
    if (dead || !chunk) break;
    const buf = pcm(chunk);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (!gain) { gain = ctx.createGain(); gain.connect(ctx.destination); }
    gain.gain.value = voiceVolume();
    src.connect(gain);
    cursor = Math.max(cursor, ctx.currentTime + (first ? 0.05 : 0)) ;
    src.start(cursor);
    if (first) { first = false; void Bridge.log("tts streaming"); }
    cursor += buf.duration;
    sources.add(src);
    lastEnd = new Promise((r) => { src.onended = () => { sources.delete(src); r(); }; });
  }
  cancels.delete(stop);
  return { heard: dead ? Promise.resolve() : lastEnd };
}

function enqueue1(text: string, who = "") {
  // Clips play in the order they arrived; the speaker is named when it changes ("Hermes. …").
  if (who && who !== lastWho) text = `${who}. ${text}`;
  lastWho = who;
  const mine = generation;
  talking++;
  State.notify();
  // One request at a time, and a step is done once its audio is queued (the next may be asked for early);
  // the clip counts as read when its audio has been heard.
  const step = queue.then(async (): Promise<Promise<void>> => {
    if (mine !== generation || !speechOn()) return Promise.resolve();
    const streamed = await playStream(text, mine);
    if (streamed) return streamed.heard;
    // No stream (ElevenLabs, or the local server is off): the whole clip, as before.
    const mp3 = await Bridge.opencodeTts(text).catch(() => null);
    if (!mp3 || mine !== generation) return Promise.resolve();
    const a = new Audio(`data:audio/${mp3.startsWith("UklGR") ? "wav" : "mpeg"};base64,${mp3}`);
    playing = a;
    a.volume = Math.min(1, voiceVolume());
    await new Promise<void>((done) => {
      a.onended = a.onerror = a.onpause = () => done();
      a.play().catch(() => done());
    });
    if (playing === a) playing = null;
    return Promise.resolve();
  }).catch((): Promise<void> => Promise.resolve());
  queue = step.then(() => {});
  void step.then((heard) => heard).then(() => {
    if (mine !== generation) return; // Stop already reset the count
    if (--talking <= 0) { talking = 0; lastWho = ""; State.notify(); speechEnded?.(); }
  });
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
