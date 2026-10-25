// gen -> (VectorCraft-style export) -> pack round trip, run in a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = path.resolve("scripts/mochi-anim.mjs");
const run = (cwd, ...a) => execFileSync("node", [script, ...a], { cwd, encoding: "utf8" });

test("gen then pack keeps 16 frames, paths and fills", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mochi-"));
  run(d, "gen", "idle");
  const svg = path.join(d, "src/mochi/art/idle.svg");
  // what VectorCraft writes: no transforms, lowercase fills, suffixed ids, spaced commands
  const bake = (d, dx) => d.replace(/([MLHVA])([^MLHVAZ]*)/g, (_, c, a) => {
    const n = a.trim().split(/[\s,]+/).map(Number);
    if (c === "M" || c === "L") n[0] += dx; else if (c === "H") n[0] += dx; else if (c === "A") n[5] += dx;
    return c + n.join(" ");
  });
  const baked = fs.readFileSync(svg, "utf8").replace(/<g id="f(\d+)" transform="[^"]*">([\s\S]*?)<\/g>/g, (_, i, inner) =>
    `<g id="f${i}">${inner.replace(/ d="([^"]*)"/g, (_, d) => ` d="${bake(d, i * 300)}"`)}</g>`);
  fs.writeFileSync(svg, baked.replace(/<rect[^>]*>/g, "").replace(/ transform="[^"]*"/g, "").replace(/#E6E9EE/g, "#e6e9ee").replace(/id="body"/g, 'id="body-2" data-name="body"').replace(/L/g, " L"));
  run(d, "pack", "idle");
  const ts = fs.readFileSync(path.join(d, "src/mochi/anims/idle.ts"), "utf8");
  assert.equal((ts.match(/\n  \[\d+, \[/g) ?? []).length, 16);
  assert.equal((ts.match(/"#e6e9ee"/g) ?? []).length, 16);
  assert.match(ts, /\[4500, \[/);
});
test("pack fails loudly without frame groups", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mochi-"));
  fs.mkdirSync(path.join(d, "src/mochi/art"), { recursive: true });
  fs.writeFileSync(path.join(d, "src/mochi/art/idle.svg"), "<svg/>");
  assert.throws(() => run(d, "pack", "idle"));
});
