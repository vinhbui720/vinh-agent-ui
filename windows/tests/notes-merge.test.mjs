import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, toggleTask, resolveLink, taskLines } from "../src/web/notes-merge.ts";

test("edits on different lines merge", () => {
  const r = reconcile("A\nb\nc\nd", "a\nb\nc\nd", "a\nb\nc\nD");
  assert.deepEqual(r, { text: "A\nb\nc\nD", conflict: false });
});

test("same line on both sides keeps both, marked", () => {
  const r = reconcile("a\nphone\nc", "a\nb\nc", "a\nhost\nc");
  assert.equal(r.conflict, true);
  assert.match(r.text, /<<<<<<< phone[\s\S]*phone[\s\S]*=======[\s\S]*host[\s\S]*>>>>>>> host/);
});

test("one side unchanged takes the other", () => {
  assert.equal(reconcile("x", "a", "a").text, "x");
  assert.equal(reconcile("a", "a", "y").text, "y");
});

test("tasks toggle by order, code fences skipped", () => {
  const src = "- [ ] one\n```\n- [ ] fake\n```\n- [x] two";
  assert.deepEqual(taskLines(src), [0, 4]);
  assert.equal(toggleTask(src, 1), "- [ ] one\n```\n- [ ] fake\n```\n- [ ] two");
  assert.equal(toggleTask(src, 0).split("\n")[0], "- [x] one");
});

test("links resolve by name, case-insensitive, folders ok", () => {
  const p = ["Daily/2026-10-25.md", "Ideas.md", "img/cat.png"];
  assert.equal(resolveLink("ideas", p), "Ideas.md");
  assert.equal(resolveLink("2026-10-25#top", p), "Daily/2026-10-25.md");
  assert.equal(resolveLink("cat.png", p), "img/cat.png");
  assert.equal(resolveLink("nope", p), null);
});
