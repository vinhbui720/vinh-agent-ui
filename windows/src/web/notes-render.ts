// Markdown → safe HTML for the View mode: standard markdown (marked), Obsidian's [[links]]
// and ![[images]], $math$ (KaTeX) and clickable task boxes. DOMPurify has the last word,
// so nothing a note contains can run script.
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Marked } from "marked";
import { imageUrl } from "./notes-store";
import { resolveLink } from "./notes-merge";

let paths: string[] = [];
let from = "";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function math(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [
    {
      name: "embed", level: "inline",
      start: (s: string) => s.indexOf("![["),
      tokenizer(s: string) {
        const m = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(s);
        return m ? { type: "embed", raw: m[0], name: m[1], size: m[2] } : undefined;
      },
      renderer(t: any) {
        const p = resolveLink(t.name, paths, from);
        if (!p) return `<span class="nt-miss">${esc(t.name)}</span>`;
        const w = /^\d+$/.test(t.size ?? "") ? ` width="${t.size}"` : "";
        return /\.md$/i.test(p) ? `<a class="nt-link" data-note="${esc(p)}">${esc(t.name)}</a>` : `<img src="${imageUrl(p)}" alt="${esc(t.name)}"${w} loading="lazy">`;
      },
    },
    {
      name: "wikilink", level: "inline",
      start: (s: string) => s.indexOf("[["),
      tokenizer(s: string) {
        const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(s);
        return m ? { type: "wikilink", raw: m[0], name: m[1], label: m[2] ?? m[1] } : undefined;
      },
      renderer(t: any) {
        const p = resolveLink(t.name, paths, from);
        return p ? `<a class="nt-link" data-note="${esc(p)}">${esc(t.label)}</a>` : `<span class="nt-miss">${esc(t.label)}</span>`;
      },
    },
    {
      name: "mathblock", level: "block",
      start: (s: string) => s.indexOf("$$"),
      tokenizer(s: string) {
        const m = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(s);
        return m ? { type: "mathblock", raw: m[0], text: m[1] } : undefined;
      },
      renderer: (t: any) => `<div class="nt-math">${math(t.text, true)}</div>`,
    },
    {
      name: "mathinline", level: "inline",
      start: (s: string) => s.indexOf("$"),
      tokenizer(s: string) {
        const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(s);
        return m ? { type: "mathinline", raw: m[0], text: m[1] } : undefined;
      },
      renderer: (t: any) => math(t.text, false),
    },
  ],
});

/** `files`: every path of the vault, to resolve links; `current`: the note shown. */
export function render(src: string, files: string[], current: string): string {
  paths = files;
  from = current;
  // Front matter is for Obsidian, not for reading.
  const body = src.replace(/^---\n[\s\S]*?\n---\n?/, "");
  let html = md.parse(body) as string;
  // Task boxes: the n-th is the n-th `- [ ]` of the source, so a tap can flip that line.
  let n = 0;
  html = html.replace(/<input ([^>]*)type="checkbox"([^>]*)>/g, (_, a, b) => `<input ${a}type="checkbox"${b} data-task="${n++}">`.replace(/\sdisabled(="")?/, ""));
  // #tags in text (not inside tags/attributes/code).
  html = html.replace(/(^|>)([^<]+)/g, (_m, g, t) => g + t.replace(/(^|\s)#([\p{L}][\p{L}\d_/-]*)/gu, '$1<span class="nt-tag">#$2</span>'));
  return DOMPurify.sanitize(html, {
    ADD_URI_SAFE_ATTR: ["type"],
    ADD_ATTR: ["class", "data-note", "data-task", "loading", "target"],
    ADD_TAGS: ["math", "semantics", "annotation"],
    // Images only from this app (vault route) or the web.
    ALLOWED_URI_REGEXP: /^(?:https?:|\/api\/note-image|#|mailto:)/i,
  });
}
