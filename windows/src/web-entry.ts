// Browser build: fake the Tauri bridge first (bridge.ts reads it at load), then boot the real island.
await import("./web-shim");
await import("./main");
const { mount } = await import("./web/notes-ui");
void mount(document.getElementById("island")!);
const { mountHoldVoice } = await import("./web/hold-voice");
mountHoldVoice(document.getElementById("island")!);
(await import("./web/shake")).mountShake();
export {};
