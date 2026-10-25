// Phone: shaking it shakes Coucou. Each jolt counts as a slap, so a few in a row make him dizzy (like tapping him on the desktop).
// iOS asks permission for motion, and only inside a tap: it is requested on the first touch.
const JOLT = 18;      // m/s² beyond gravity-free acceleration; a walk stays under it
const GAP = 280;      // ms between two slaps

export function mountShake() {
  const DME = (window as any).DeviceMotionEvent;
  if (!DME) return;
  let last = 0, on = false;
  const listen = () => {
    if (on) return; on = true;
    addEventListener("devicemotion", (e) => {
      const a = e.acceleration ?? e.accelerationIncludingGravity; if (!a) return;
      const g = e.acceleration ? 0 : 9.8;
      const m = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) - g;
      const t = performance.now();
      if (m > JOLT && t - last > GAP) { last = t; navigator.vibrate?.(20); (window as any).__shake?.(); }
    });
  };
  if (typeof DME.requestPermission !== "function") return listen();
  addEventListener("touchend", () => DME.requestPermission().then((r: string) => r === "granted" && listen()).catch(() => {}), { once: true });
}
