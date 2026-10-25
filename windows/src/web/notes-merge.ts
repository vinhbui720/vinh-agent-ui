// Pure logic of the phone's notes: 3-way merge, task toggling, link lookup. No DOM, no network.
import { merge } from "node-diff3";

/**
 * `local`: the phone's text, `base`: what both started from, `host`: the file on the host now.
 * Lines changed on one side only go through; the same line changed on both leaves
 * <<<<<<< markers for the user to settle (still no data lost).
 */
export function reconcile(local: string, base: string, host: string): { text: string; conflict: boolean } {
  if (local === host) return { text: host, conflict: false };
  if (host === base) return { text: local, conflict: false };
  if (local === base) return { text: host, conflict: false };
  const r = merge(local.split("\n"), base.split("\n"), host.split("\n"), {
    excludeFalseConflicts: true,
    label: { a: "phone", b: "host" },
  });
  return { text: r.result.join("\n"), conflict: r.conflict };
}

const TASK = /^(\s*[-*+] \[)([ xX])(\] )/;

/** Source line numbers of the task items, skipping code fences. */
export function taskLines(src: string): number[] {
  const out: number[] = [];
  let fence = false;
  src.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && TASK.test(l)) out.push(i);
  });
  return out;
}

/** Flips the n-th task item of the note (the n-th checkbox in the rendered page). */
export function toggleTask(src: string, n: number): string {
  const at = taskLines(src)[n];
  if (at == null) return src;
  const lines = src.split("\n");
  lines[at] = lines[at].replace(TASK, (_, a, m, b) => a + (m === " " ? "x" : " ") + b);
  return lines.join("\n");
}

/** Where `[[name]]` or `![[name.png]]` points: a path of the vault index, or null. */
export function resolveLink(name: string, paths: string[], from = ""): string | null {
  const want = name.split("#")[0].trim().replace(/\\/g, "/");
  if (!want) return null;
  const cands = /\.[a-z0-9]{2,4}$/i.test(want) ? [want] : [want + ".md", want];
  const low = paths.map((p) => p.toLowerCase());
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  for (const c of cands) {
    for (const guess of [c, dir + c]) {
      const i = low.indexOf(guess.toLowerCase());
      if (i >= 0) return paths[i];
    }
    const i = low.findIndex((p) => p.endsWith("/" + c.toLowerCase()));
    if (i >= 0) return paths[i];
  }
  return null;
}

/** Title shown for a path: file name without `.md`. */
export const noteTitle = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");
