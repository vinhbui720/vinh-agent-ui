// The phone's copy of the vault: an index of every note and image, the text of the notes the
// user pinned or opened, and the edits not yet on the host. IndexedDB, so it survives a closed
// app and works with no network. Sync = push each dirty note (3-way merge if the host moved).
import { reconcile } from "./notes-merge";

export interface Entry { path: string; mtime: number; size: number }
export interface Doc {
  path: string;
  text: string;
  /** What the host had when we last synced: the merge base. */
  base: string;
  /** Host mtime of `base` (0 = not on the host yet). */
  mtime: number;
  dirty: boolean;
  pinned: boolean;
  conflict?: boolean;
  seen: number;
}

const w = window as any;

async function rpc<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j as T;
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((ok, fail) => {
    const q = indexedDB.open("coucou-notes", 1);
    q.onupgradeneeded = () => {
      q.result.createObjectStore("docs", { keyPath: "path" });
      q.result.createObjectStore("meta");
    };
    q.onsuccess = () => ok(q.result);
    q.onerror = () => fail(q.error);
  });
  return dbp;
}
async function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const r = f(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
export const getDoc = (p: string) => tx<Doc | undefined>("docs", "readonly", (s) => s.get(p));
export const putDoc = (d: Doc) => tx("docs", "readwrite", (s) => s.put(d));
export const allDocs = () => tx<Doc[]>("docs", "readonly", (s) => s.getAll());
const dropDoc = (p: string) => tx("docs", "readwrite", (s) => s.delete(p));

export async function cachedIndex(): Promise<Entry[]> {
  return (await tx<Entry[] | undefined>("meta", "readonly", (s) => s.get("index"))) ?? [];
}
const saveIndex = (e: Entry[]) => tx("meta", "readwrite", (s) => s.put(e, "index"));

// ── Status ───────────────────────────────────────────────────────────────────

export type Status = "synced" | "pending" | "offline" | "syncing";
let status: Status = navigator.onLine ? "synced" : "offline";
const subs = new Set<() => void>();
export const onChange = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
const emit = () => subs.forEach((f) => f());
export const getStatus = () => status;
async function setStatus() {
  const dirty = (await allDocs()).some((d) => d.dirty);
  status = !navigator.onLine ? "offline" : dirty ? "pending" : "synced";
  emit();
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The vault's file list from the host; falls back to the last copy offline. */
export async function loadIndex(): Promise<{ entries: Entry[]; online: boolean }> {
  try {
    const entries = await rpc<Entry[]>("notes_list");
    await saveIndex(entries);
    // Notes made offline are not on the host yet: keep them in the list.
    const mine = (await allDocs()).filter((d) => d.mtime === 0 && !entries.some((e) => e.path === d.path));
    return { entries: [...entries, ...mine.map((d) => ({ path: d.path, mtime: d.seen, size: d.text.length }))], online: true };
  } catch {
    const mine = (await allDocs()).filter((d) => d.mtime === 0).map((d) => ({ path: d.path, mtime: d.seen, size: d.text.length }));
    const cached = await cachedIndex();
    return { entries: [...cached, ...mine.filter((m) => !cached.some((c) => c.path === m.path))], online: false };
  }
}

/** Opens a note: unsent edits first, else the host's text, else the cached copy. */
export async function openNote(path: string): Promise<Doc | null> {
  const have = await getDoc(path);
  if (have?.dirty) return have;
  try {
    const n = await rpc<{ text: string; mtime: number }>("notes_read", { path });
    const d: Doc = { path, text: n.text, base: n.text, mtime: n.mtime, dirty: false, pinned: have?.pinned ?? false, seen: Date.now() };
    await putDoc(d);
    return d;
  } catch {
    return have ?? null;
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Local save, always works; sync follows when it can. */
export async function saveLocal(path: string, text: string) {
  const d = (await getDoc(path)) ?? { path, text: "", base: "", mtime: 0, dirty: false, pinned: false, seen: 0 };
  if (d.text === text && d.dirty === (d.text !== d.base)) return;
  await putDoc({ ...d, text, dirty: text !== d.base || d.mtime === 0, seen: Date.now() });
  await setStatus();
  void sync();
}

export async function createNote(path: string) {
  await putDoc({ path, text: "", base: "", mtime: 0, dirty: true, pinned: false, seen: Date.now() });
  await setStatus();
}

export async function setPinned(path: string, pinned: boolean) {
  const d = await openNote(path);
  if (d) await putDoc({ ...d, pinned });
}

/** Sends one dirty note. A moved host file is merged (3-way) and sent again. */
async function push(d: Doc): Promise<void> {
  let cur = d;
  for (let i = 0; i < 3; i++) {
    try {
      const mtime = await rpc<number>("notes_write", { path: cur.path, text: cur.text, expect: cur.mtime });
      await putDoc({ ...cur, base: cur.text, mtime, dirty: false });
      return;
    } catch (e) {
      if (String((e as Error).message) !== "conflict") throw e;
      let host: { text: string; mtime: number } | null = null;
      try { host = await rpc("notes_read", { path: cur.path }); } catch { /* no file yet */ }
      if (!host) { cur = { ...cur, mtime: 0 }; continue; }
      const m = reconcile(cur.text, cur.base, host.text);
      cur = { ...cur, text: m.text, base: host.text, mtime: host.mtime, conflict: m.conflict };
      await putDoc(cur);
    }
  }
}

let syncing = false;
export async function sync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  status = "syncing"; emit();
  try {
    for (const d of (await allDocs()).filter((x) => x.dirty)) {
      try { await push(d); } catch { break; }
    }
    // Pinned notes follow the host while they have nothing unsent.
    for (const d of (await allDocs()).filter((x) => x.pinned && !x.dirty)) {
      try {
        const n = await rpc<{ text: string; mtime: number }>("notes_read", { path: d.path });
        if (n.mtime !== d.mtime) await putDoc({ ...d, text: n.text, base: n.text, mtime: n.mtime });
      } catch { /* gone or offline */ }
    }
  } finally {
    syncing = false;
    await setStatus();
    w.__notesSynced?.();
  }
}

export async function renameNote(from: string, to: string) {
  const d = await getDoc(from);
  if (d?.dirty) await push(d);
  await rpc("notes_rename", { from, to });
  if (d) { await dropDoc(from); await putDoc({ ...d, path: to }); }
}
export async function deleteNote(path: string) {
  const d = await getDoc(path);
  if (!d || d.mtime !== 0) await rpc("notes_delete", { path });
  await dropDoc(path);
}

export const imageUrl = (path: string) => `/api/note-image?p=${encodeURIComponent(path)}`;

addEventListener("online", () => void sync());
addEventListener("offline", () => void setStatus());
document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
setInterval(() => void sync(), 30_000);
void setStatus();
