// Plays a frame animation drawn in VectorCraft (see scripts/mochi-anim.mjs). Canvas reads the SVG
// path data as it is (Path2D), so nothing is converted at run time. Separate from BotEngine.

export interface VectorAnim {
  fps: number;
  w: number;
  h: number;
  /** Mochi's body centre inside a frame. */
  cx: number;
  cy: number;
  /** Per frame: [path data, fill]. */
  frames: [number, [string, string][]][];
}

const cache = new WeakMap<VectorAnim, Path2D[][]>();

/** Draws the frame shown at `seconds` (looping), centred on (x, y) at `scale`. Returns the frame index. */
export function drawVectorAnim(ctx: CanvasRenderingContext2D, a: VectorAnim, seconds: number, x: number, y: number, scale = 1): number {
  let paths = cache.get(a);
  if (!paths) cache.set(a, (paths = a.frames.map(([, f]) => f.map(([d]) => new Path2D(d)))));
  const i = Math.floor(seconds * a.fps) % a.frames.length;
  ctx.save();
  ctx.translate(x - a.cx * scale, y - a.cy * scale);
  ctx.translate(-a.frames[i][0] * scale, 0);
  ctx.scale(scale, scale);
  a.frames[i][1].forEach(([, fill], k) => { ctx.fillStyle = fill; ctx.fill(paths![i][k]); });
  ctx.restore();
  return i;
}
