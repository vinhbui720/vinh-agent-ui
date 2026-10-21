import test from "node:test";
import assert from "node:assert/strict";
const store = new Map();
globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { speakable, sentenceEnd, softEnd, speakFinished, setSpeech, speechOn } = await import("../src/island/opencode.ts");
const { calls } = await import("./tauri.mjs");
globalThis.Audio ??= class { play() { return Promise.resolve(); } pause() {} };
const said = () => calls.filter(([c]) => c === "opencode_tts").map(([, a]) => a.text);
const msg = (id, role, text) => ({ id, role, text });

test("sentenceEnd waits for a finished sentence", () => {
  assert.equal(sentenceEnd("Hello wor", 0), 0);
  assert.equal(sentenceEnd("Hello world. And th", 0), 12);
  assert.equal(sentenceEnd("One. Two. Thr", 5), 9);
  assert.equal(sentenceEnd("line one\nline", 0), 9);
});

test("speakable drops code even across chunks", () => {
  const st = { fence: false };
  assert.equal(speakable("See this: ```js\nlet x", st), "See this:");
  assert.equal(speakable(" = 1;\n``` Done **now**.", st), "Done now.");
  assert.equal(st.fence, false);
});

test("softEnd cuts a long run at the last comma, else the last space", () => {
  assert.equal(softEnd("alpha, beta gamma", 0), 7);
  assert.equal(softEnd("alpha beta gam", 0), 11);
  assert.equal(softEnd("alpha", 0), 0);
});

test("the last answer is read when the session leaves the running list", () => {
  const user = msg("u1", "user", "hi");
  speakFinished([], new Map([["sA", [user]]])); // first look: history, nothing said
  speakFinished([{ id: "sA", running: true }], new Map([["sA", [user, msg("a1", "assistant", "The first part is completely done. Second par")]]]));
  assert.deepEqual(said(), ["The first part is completely done."]);
  // The session ends and is gone from the list: the rest is still read, at once.
  speakFinished([], new Map([["sA", [user, msg("a1", "assistant", "The first part is completely done. Second part is done too.")]]]));
  assert.deepEqual(said(), ["The first part is completely done.", "Second part is done too."]);
});

test("history seen at startup is not read, a new answer is", () => {
  calls.length = 0;
  const old = [msg("u", "user", "q"), msg("a", "assistant", "Old answer that was there before.")];
  speakFinished([], new Map([["sB", old]]));
  speakFinished([], new Map([["sB", old]]));
  assert.deepEqual(said(), []);
  speakFinished([], new Map([["sB", [...old, msg("u2", "user", "q2"), msg("a2", "assistant", "A brand new reply from OpenCode.")]]]));
  assert.deepEqual(said(), ["A brand new reply from OpenCode."]);
});

test("muted: no request is sent, and the choice is remembered until toggled back", () => {
  calls.length = 0;
  const q = msg("uM", "user", "q");
  speakFinished([], new Map([["sM", [q]]]));
  setSpeech(false);
  assert.equal(speechOn(), false);
  assert.equal(localStorage.getItem("ocSpeak"), "0"); // persisted
  speakFinished([{ id: "sM", running: true }], new Map([["sM", [q, msg("aM1", "assistant", "This answer is written while muted. More")]]]));
  speakFinished([], new Map([["sM", [q, msg("aM1", "assistant", "This answer is written while muted. More text here.")]]]));
  assert.deepEqual(said(), []); // nothing sent to the API
  setSpeech(true);
  assert.equal(speechOn(), true);
  speakFinished([], new Map([["sM", [q, msg("aM1", "assistant", "This answer is written while muted. More text here.")]]]));
  assert.deepEqual(said(), []); // what was written while muted is not read back later
  speakFinished([], new Map([["sM", [q, msg("aM1", "assistant", "This answer is written while muted. More text here."), msg("uM2", "user", "q2"), msg("aM2", "assistant", "A new reply after unmuting arrives.")]]]));
  assert.deepEqual(said(), ["A new reply after unmuting arrives."]);
});
