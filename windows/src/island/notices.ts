// Hermes notices (the `Say` hook): read aloud on the machine you are using, then the island folds.
//  - Which machine: the one whose island you last opened or hovered (src-tauri/src/notice.rs); stale after 10 min.
//  - Not that machine, or past the burst cap: the notice waits as a badge and is read once on your next hover.
//  - Hover while one is being read: the sound stops and the island folds. Click opens a card silently.
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { isSpeaking, onSpeechEnded, speakAloud, speechOn, stopSpeech } from "./opencode";
import type { Island } from "./island";

const BURST = 3;
const FOCUS_EVERY_MS = 20_000;
let island: Island | null = null;
let reading = false; // a notice is being read
let burst = 0;
let lastFocus = 0;
const waiting: string[] = [];

export function registerNotices(i: Island) {
  island = i;
  onSpeechEnded(() => {
    burst = 0;
    if (!reading) return;
    reading = false;
    if (!State.pendingApproval && State.mode === "expanded" && !island?.hovered) island?.collapse();
  });
}

/** What the island does with a notice: read it, or leave it as a badge. Returns whether the card should pop up. */
export async function takeNotice(text: string): Promise<"read" | "wait" | "silent"> {
  if (!speechOn()) return "silent"; // reading off: the card appears as it always did
  const mine = await Bridge.noticeCanSpeak().catch(() => false);
  if (!mine || burst >= BURST) { waiting.push(text); if (waiting.length > BURST) waiting.shift(); return "wait"; }
  burst++;
  reading = true;
  speakAloud(text, "Hermes");
  return "read";
}

/** The pointer came into the island. */
export function onIslandHover() {
  const now = Date.now();
  if (now - lastFocus > FOCUS_EVERY_MS) { lastFocus = now; void Bridge.noticeFocus().catch(() => {}); }
  if (reading && isSpeaking()) {
    // "I saw it": mute, the island stays open to use; what was still queued stays a badge.
    reading = false;
    burst = 0;
    stopSpeech();
    return;
  }
  if (waiting.length && speechOn()) {
    reading = true;
    for (const t of waiting.splice(0)) { burst++; speakAloud(t, "Hermes"); }
  }
}

/** A card was raised for something that is being read: fold it when the sound ends (hover mutes). */
export function noticeShown() { if (isSpeaking()) reading = true; }
