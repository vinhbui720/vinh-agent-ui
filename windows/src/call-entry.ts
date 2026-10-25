// The live call runs here, in Chrome (WebKitGTK has no WebRTC); see voice::ensure_call_page.
// One page only: a second tab of the same profile would join the room as the same person and kick the first out.
await import("./web-shim");
const { ownCall } = await import("./core/call");
void navigator.locks.request("coucou-call", { ifAvailable: true }, (lock) => {
  if (!lock) { window.close(); return; }
  ownCall();
  return new Promise(() => {}); // held until the page closes
});
export {};
