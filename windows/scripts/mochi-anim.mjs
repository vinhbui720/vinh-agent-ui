// Mochi animations <-> VectorCraft (frame by frame).
//   node scripts/mochi-anim.mjs gen  [name]   -> src/mochi/art/<name>.svg  (open it in VectorCraft)
//   node scripts/mochi-anim.mjs pack [name]   -> src/mochi/anims/<name>.ts (from the SVG VectorCraft exported)
// The SVG holds every frame side by side: <g id="f0">…<g id="f1">…, each with a body and eyes (paths),
// FRAME_W apart. Draw whatever you like inside a frame; `pack` keeps each frame's paths and colours.
// The dark "bg" rect behind each frame only makes the light body visible in VectorCraft; pack skips ids starting "bg".
// Only `gen` knows the engine's numbers (src/mochi/engine.ts: R, rx 1.14R, ry 0.88R, eyes, blink).
// ponytail: the idle loop is built from those constants, not by running the engine; add a headless run if it drifts.
import fs from "node:fs";

const name = process.argv[3] ?? "idle";
const art = `src/mochi/art/${name}.svg`;
const out = `src/mochi/anims/${name}.ts`;
const FRAME_W = 300, FRAME_H = 260, CX = 150, CY = 130, R = 100;
const rx = R * 1.14, ry = R * 0.88;
const f = (n) => +n.toFixed(2);

// Body: the engine's superellipse (exponent 2/2.7), as a closed polygon. `rot` tilts it about its centre.
const rotp = (x, y, rot) => { const c = Math.cos(rot), s = Math.sin(rot), dx = x - CX, dy = y - (CY); return [CX + dx * c - dy * s, CY + dx * s + dy * c]; };
function body(sx, sy, oy, rot = 0) {
  const e = 2 / 2.7, pts = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const [x, y] = rotp(CX + sx * rx * Math.sign(c) * Math.abs(c) ** e, CY + oy + sy * ry * Math.sign(s) * Math.abs(s) ** e, rot);
    pts.push(`${f(x)} ${f(y)}`);
  }
  return `M${pts.join("L")}Z`;
}
// Eye: a pill like roundRectPath in the engine; `open` 1 = awake, 0.06 = blink. `turn` = head yaw (rad): the eyes
// slide across the face and narrow as they turn away (same sin/cos the engine uses); 0 = idle, unchanged.
function eyeGeom(side, open, sx, sy, oy, turn = 0, rot = 0) {
  const ang = side * 0.37 + turn, k = Math.max(Math.cos(ang), 0.3) / Math.cos(side * 0.37);
  const w = R * 0.25 * k, h = Math.max(R * 0.27 * open, w * 0.3);
  const ex = Math.sin(ang) * Math.cos(-0.12) * rx * sx, ey = Math.sin(0.12) * ry * sy;
  const [cx, cy] = rotp(CX + ex, CY + oy + ey, rot);
  return { cx, cy, w, h, k };
}
function eye(side, open, sx, sy, oy, turn = 0, rot = 0) {
  const { cx, cy, w, h } = eyeGeom(side, open, sx, sy, oy, turn, rot), r = Math.min(w, h) / 2;
  const x = cx - w / 2, y = cy - h / 2;
  return `M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`;
}
// A thin curved bar (a sound wave) around (cx, cy): radius r, from angle a0 to a1, width w.
function arc(cx, cy, r, a0, a1, w) {
  const o = [], i = [];
  for (let k = 0; k <= 8; k++) { const a = a0 + ((a1 - a0) * k) / 8; o.push([cx + (r + w / 2) * Math.cos(a), cy + (r + w / 2) * Math.sin(a)]); i.push([cx + (r - w / 2) * Math.cos(a), cy + (r - w / 2) * Math.sin(a)]); }
  return [...o, ...i.reverse()];
}
// Shadow the head casts on the hand: the part of each hand shape inside the head outline grown by GROW px.
// Both shapes are convex, so a Sutherland-Hodgman clip is enough (no geometry library).
const GROW = 5;
function bodyPts(sx, sy, oy, rot, grow) {
  const e = 2 / 2.7, pts = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    let x = sx * rx * Math.sign(c) * Math.abs(c) ** e, y = sy * ry * Math.sign(s) * Math.abs(s) ** e;
    const l = Math.hypot(x, y) || 1; x += (x / l) * grow; y += (y / l) * grow;
    pts.push(rotp(CX + x, CY + oy + y, rot));
  }
  return pts;
}
function clip(subject, clipper) {
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const [ax, ay] = clipper[i], [bx, by] = clipper[(i + 1) % clipper.length];
    const side = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax); // > 0: inside (clipper runs clockwise on screen)
    const inp = out; out = [];
    inp.forEach((p, k) => {
      const q = inp[(k + 1) % inp.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    });
  }
  return out;
}
const path = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
function blobPts(cx, cy, ax, ay, rot) {
  return Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2, x = ax * Math.cos(a), y = ay * Math.sin(a); return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; });
}
// A tilted ellipse as a polygon (hand and ear are plain blobs: easy to redraw in VectorCraft).
function blob(cx, cy, ax, ay, rot) {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, x = ax * Math.cos(a), y = ay * Math.sin(a);
    pts.push(`${f(cx + x * Math.cos(rot) - y * Math.sin(rot))} ${f(cy + x * Math.sin(rot) + y * Math.cos(rot))}`);
  }
  return `M${pts.join("L")}Z`;
}
const P = (id, fill, d) => `<path id="${id}" fill="${fill}" d="${d}"/>`;
const ease = (t) => t * t * (3 - 2 * t);

// Each animation: a list of frames, each a list of <path>s (back to front).
const ANIMS = {
  // 16 frames at 8 fps = 2 s: a slow breath (squash) and one blink (frames 11-13).
  idle() {
    const open = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.06, 0.5, 1, 1];
    return open.map((o, i) => {
      const b = Math.sin((i / open.length) * Math.PI * 2);
      const sy = 1 + 0.015 * b, sx = 1 - 0.01 * b, oy = -1.5 * b;
      return [P("body", "#E6E9EE", body(sx, sy, oy)), P("eye-l", "#1A1412", eye(-1, o, sx, sy, oy)), P("eye-r", "#1A1412", eye(1, o, sx, sy, oy))];
    });
  },
  // Listening (cute version): the head turns to the right so its left side faces out and leans toward a plump
  // mitten hand that rises BEHIND the head, beside the ear (frames 0-4). Frames 5-20 are the wait for the speaker
  // (2 s, loop these): the head floats up and down, the hand taps its fingers, two little sound waves pulse in
  // from the left, a pink cheek shows, one blink. Then it lowers (21-24).
  listen() {
    const N = 25;
    return Array.from({ length: N }, (_, i) => {
      const p = ease(i < 5 ? i / 4 : i < 21 ? 1 : Math.max(0, (24 - i) / 3));
      const t = i >= 5 && i < 21 ? ((i - 5) / 16) * Math.PI * 2 : 0; // one full hover cycle over the wait
      const w = p === 1, S = Math.sin(t);
      const oy = w ? -3.5 * S : 0, turn = 0.62 * p + (w ? 0.05 * S : 0), sx = 1 - 0.2 * p, rot = -0.1 * p + (w ? 0.02 * S : 0);
      const open = i === 14 ? 0.5 : i === 15 ? 0.06 : i === 16 ? 0.5 : 1;
      const out = [];
      const left = CX - rx * sx;
      if (p > 0.02) { // plump hand first, so the head covers its inner half
        const hx = left - 1 - (1 - p) * 12, hy = CY + 4 + oy + (1 - p) * 110;
        const parts = [["palm", hx, hy, 25, 30, 0.1]];
        [-15, 0, 15].forEach((o, k) => parts.push([`finger-${k}`, hx + o * 0.95 - 4, hy - 28 - (k === 1 ? 5 : 0) - (w ? 3.5 * Math.max(0, Math.sin(t * 2 - k * 1.3)) : 0), 9.5, 17, 0.2 * (k - 1)]));
        parts.push(["thumb", hx + 21, hy - 6, 9, 15, 0.7]);
        parts.forEach(([id, x, y, ax, ay, r]) => out.push(P(id, "#E6E9EE", blob(x, y, ax, ay, r))));
        const head = bodyPts(sx, 1, oy, rot, GROW);
        parts.forEach(([id, x, y, ax, ay, r]) => { const c = clip(blobPts(x, y, ax, ay, r), head); if (c.length > 2) out.push(P(`body_shadow-${id}`, "#D3D9E2", path(c))); });
      }
      out.push(P("body", "#E6E9EE", body(sx, 1, oy, rot)));
      if (p > 0.02) out.push(P("ear", "#D3D9E2", blob(left + 17 * p, CY + 2 + oy, 8 * p, 17 * p, rot)));
      const L = eyeGeom(-1, open, sx, 1, oy, turn, rot), Rg = eyeGeom(1, open, sx, 1, oy, turn, rot);
      if (p > 0.02) out.push(P("cheek", "#F4C6D0", blob(L.cx - 3 * p, L.cy + 20, 12 * p, 6.5 * p, rot))); // pink cheek under the near eye
      out.push(P("eye-l", "#1A1412", eye(-1, open, sx, 1, oy, turn, rot)), P("eye-r", "#1A1412", eye(1, open, sx, 1, oy, turn, rot)));
      if (w) { // two sound waves flowing toward the ear
        [0, 1].forEach((k) => {
          const ph = (((t / (Math.PI * 2)) * 2 + k * 0.5) % 1), r = 20 + ph * 26, a = Math.max(0, Math.sin(ph * Math.PI));
          if (a > 0.1) out.push(P(`wave-${k}`, "#AEB9CC", path(arc(left - 20 - ph * 8, CY - 10 + oy, r * 0.6, Math.PI - 0.7, Math.PI + 0.7, 3.5 * a + 0.5))));
        });
      }
      return out;
    });
  },
  // Angry (cute): the body turns red and puffs up, the round eyes get a slanted top (no brows), pink cheeks, a small
  // frown, and a wobble with two steam puffs rising. Frames 0-3 puff up; 4-15 loop (3 wobbles) while he is angry.
  angry() {
    // keep the part of a polygon below the line y = y0 + k * (x - x0)
    const below = (pts, x0, y0, k) => { const d = ([x, y]) => y - (y0 + k * (x - x0)); const o = []; pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length], da = d(a), db = d(b); if (da >= 0) o.push(a); if (da >= 0 !== db >= 0) { const t = da / (da - db); o.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } }); return o; };
    return Array.from({ length: 16 }, (_, i) => {
      const p = ease(Math.min(i / 3, 1)), ph = i >= 4 ? ((i - 4) / 12) * Math.PI * 2 : 0, S = Math.sin(ph * 3), C = Math.cos(ph * 3);
      const sx = 1 + 0.05 * p, sy = 1 - 0.03 * p, rot = 0.05 * S * (i >= 4 ? 1 : 0), oy = i >= 4 ? -1.5 * Math.abs(C) : 0;
      const L = eyeGeom(-1, 1, sx, sy, oy, 0, rot), Rg = eyeGeom(1, 1, sx, sy, oy, 0, rot), out = [];
      out.push(P("body", "#F0646E", body(sx, sy, oy, rot)));
      out.push(P("cheek-l", "#FF9AA5", blob(L.cx - 8, L.cy + 24, 14 * p, 7.5 * p, rot)), P("cheek-r", "#FF9AA5", blob(Rg.cx + 8, Rg.cy + 24, 14 * p, 7.5 * p, rot)));
      // each eye: a round blob with its inner top cut away, so it slants down toward the nose
      [[L, 1, "eye-l"], [Rg, -1, "eye-r"]].forEach(([g, inner, id]) => {
        const e = blobPts(g.cx, g.cy + 2, 11, 13, 0), cut = below(e, g.cx, g.cy - 5 * p, inner * 0.6 * p);
        out.push(P(id, "#1A1412", path(cut.map(([x, y]) => rotp(x, y, rot)))));
      });
      const [mx, my] = rotp((L.cx + Rg.cx) / 2, (L.cy + Rg.cy) / 2 + 34 + oy, rot);
      out.push(P("mouth", "#1A1412", path(arc(mx, my + 7, 9, Math.PI * 1.1, Math.PI * 1.9, 3.6))));
      if (i >= 4) [0, 1].forEach((k) => {
        const u = (ph / (Math.PI * 2) + k * 0.5) % 1, y = CY - ry - 6 - u * 34, x = CX + (k ? 38 : -38) + Math.sin(u * 6 + k) * 5, r = 7 * Math.sin(u * Math.PI) + 1;
        out.push(P(`steam-${k}`, "#FFD3D6", blob(x, y, r, r * 0.85, 0)));
      });
      return out;
    });
  },
};

if (process.argv[2] === "gen") {
  const frames = (ANIMS[name] ?? (() => { throw new Error(`no animation "${name}": ${Object.keys(ANIMS).join(", ")}`); }))();
  let g = "";
  frames.forEach((paths, i) => {
    g += `<g id="f${i}" transform="translate(${i * FRAME_W} 0)"><rect id="bg" width="${FRAME_W}" height="${FRAME_H}" fill="#3a3f4a"/>${paths.join("")}</g>`;
  });
  fs.mkdirSync("src/mochi/art", { recursive: true });
  fs.writeFileSync(art, `<svg xmlns="http://www.w3.org/2000/svg" width="${frames.length * FRAME_W}" height="${FRAME_H}" viewBox="0 0 ${frames.length * FRAME_W} ${FRAME_H}">${g}</svg>\n`);
  console.log(`wrote ${art} (${frames.length} frames of ${FRAME_W}x${FRAME_H}, 8 fps)`);
} else if (process.argv[2] === "pack") {
  const svg = fs.readFileSync(art, "utf8");
  const frames = [...svg.matchAll(/<g\b[^>]*\bid="f(\d+)"[^>]*>([\s\S]*?)<\/g>/g)].sort((a, b) => a[1] - b[1]);
  if (!frames.length) throw new Error(`no <g id="f0…"> frames in ${art}: keep the frame groups when you export`);
  const attr = (tag, k) => new RegExp(`\\b${k}="([^"]*)"`).exec(tag)?.[1];
  const data = frames.map(([whole, i, inner]) => {
    // A group with a translate keeps frame-local coordinates (gen's file); without one (VectorCraft bakes it in) the coordinates are sheet-wide, so the player subtracts i * FRAME_W.
    const dx = /translate\(/.test(whole.slice(0, whole.indexOf(">"))) ? 0 : i * FRAME_W;
    const paths = [...inner.matchAll(/<path\b[^>]*>/g)].filter(([p]) => !/\bid="bg/.test(p)).map(([p]) => ({ d: attr(p, "d"), fill: attr(p, "fill") ?? "#000" }));
    return { dx, paths };
  });
  const body = data.map((fr) => `  [${fr.dx}, [${fr.paths.map((p) => `[${JSON.stringify(p.d)}, ${JSON.stringify(p.fill)}]`).join(", ")}]]`).join(",\n");
  fs.mkdirSync("src/mochi/anims", { recursive: true });
  fs.writeFileSync(out, `// Generated by scripts/mochi-anim.mjs pack from ${art}. Edit the SVG in VectorCraft, not this file.
import type { VectorAnim } from "../vector-anim";
export const ${name}: VectorAnim = {
  fps: 8, w: ${FRAME_W}, h: ${FRAME_H}, cx: ${CX}, cy: ${CY},
  /** Per frame: [x offset of the frame in the sheet, [[path data, fill], ...]]. */
  frames: [
${body},
  ],
};
`);
  console.log(`wrote ${out} (${data.length} frames)`);
} else console.log("usage: gen|pack [name]");
