// Call buttons in the chat bar. The call itself lives in the pill window (src/core/call.ts); these only send
// commands and paint from `call-state`, so the island, the hotkey and every window show the same call.
import { callCmd, onCallState, type CallState } from "../core/call";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t, tl } from "../i18n/i18n";

const S = {
  call: N_("Talk live (tap to start and stop)"),
  hear: N_("Voice agent listens (microphone)"),
  speak: N_("Voice agent speaks (speaker)"),
  fast: N_("Fast Vietnamese recognition (tap for accurate, Vietnamese and English)"),
  accurate: N_("Accurate recognition, Vietnamese and English (tap for fast)"),
};

export function buildCall(): HTMLElement {
  const call = h("button", { class: "mic-btn call-btn", type: "button", title: tl(S.call) }, svg(ICONS.speaker, 12));
  const ears = h("button", { class: "mic-btn call-opt", type: "button", title: tl(S.hear) }, svg(ICONS.mic, 11));
  const mouth = h("button", { class: "mic-btn call-opt", type: "button", title: tl(S.speak) }, svg(ICONS.speaker, 11));
  const mode = h("button", { class: "mic-btn call-opt call-mode", type: "button", title: tl(S.fast) }, "⚡");
  const box = h("span", { class: "call-box" }, call, ears, mouth, mode);
  const paint = (s: CallState) => {
    call.classList.toggle("rec", s.live);
    box.classList.toggle("live", s.live);
    ears.classList.toggle("off", !s.hear);
    mouth.classList.toggle("off", !s.tts);
    mode.textContent = s.mode === "accurate" ? "🎯" : "⚡";
    mode.title = t(s.mode === "accurate" ? S.accurate : S.fast);
  };
  void onCallState(paint);
  call.onclick = () => void callCmd({ cmd: "toggle" });
  ears.onclick = () => void callCmd({ cmd: "hear" });
  mouth.onclick = () => void callCmd({ cmd: "speak" });
  mode.onclick = () => void callCmd({ cmd: "mode" });
  paint({ live: false, hear: true, tts: true, mode: "fast", heard: "", answer: "" });
  return box;
}
