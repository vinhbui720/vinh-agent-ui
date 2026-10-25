// The live voice call with the LiveKit agent (voice-server/agent). One owner: the pill window (the island) holds
// the Room; the chat bar, the hotkey and the Coucou window only send `call-cmd` events through Rust and paint from
// `call-state`. Both ends toggle independently via the agent's `set_io` RPC.
import { Room, RoomEvent, Track } from "livekit-client";
import { Bridge, onEvent } from "./bridge";
import { call } from "./flow";

const LK_URL = "ws://127.0.0.1:7880";
/** LiveKit as a page of the tailnet sees it: HTTPS on this computer's name (tailscale serve), else the local tunnel. */
export const lkUrl = () => (location.protocol === "https:" ? `wss://${location.host.split(":")[0]}:7443` : LK_URL);
export interface CallState { live: boolean; hear: boolean; tts: boolean; mode: "fast" | "accurate"; heard: string; answer: string; error?: string }
export type CallCmd = { cmd: "toggle" } | { cmd: "hear" } | { cmd: "speak" } | { cmd: "mode" };

/** Asks the call's owner (the pill) to do something. Works from any window. */
export const callCmd = (c: CallCmd) => call<void>("call_cmd", { cmd: c.cmd });
export const onCallState = (f: (s: CallState) => void) => onEvent<CallState>("call-state", f);

/** Pill window only. */
export function ownCall() {
  let room: Room | null = null;
  const st: CallState = { live: false, hear: true, tts: true, mode: "fast", heard: "", answer: "" };
  const push = () => void call<void>("call_state", { state: { ...st } });
  const rpc = async (p: object) => {
    const r = room; const a = r && [...r.remoteParticipants.values()][0];
    if (r && a) await r.localParticipant.performRpc({ destinationIdentity: a.identity, method: "set_io", payload: JSON.stringify(p) });
  };
  // The agent works on this machine: it calls these (LiveKit RPC), answered here by OpenCode and the OS of the caller.
  const serve = (r: Room) => {
    r.registerRpcMethod("run_task", async (d) => {
      const { task, allowBlocked } = JSON.parse(d.payload);
      return (await call<string>("voice_run", { task, allowBlocked: !!allowBlocked })) ?? "";
    });
    r.registerRpcMethod("recall", async (d) => (await call<string>("voice_recall", { query: d.payload })) ?? "");
    r.registerRpcMethod("cancel", async () => String(await call<number>("voice_cancel")));
    r.registerRpcMethod("mem_add", async (d) => { const { who, text } = JSON.parse(d.payload); await call<void>("voice_mem_add", { who, text }); return "ok"; });
    r.registerRpcMethod("context", async () => (await call<string>("voice_context")) ?? "");
  };
  const stop = async () => {
    const r = room; room = null; st.live = false; st.heard = st.answer = ""; push();
    if (r) { r.remoteParticipants.forEach((p) => p.trackPublications.forEach((t) => t.track?.detach())); await r.disconnect(); }
  };
  const start = async () => {
    const r = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    r.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === Track.Kind.Audio) document.body.appendChild(track.attach()); });
    r.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((e) => e.remove()));
    r.on(RoomEvent.Disconnected, (why) => { st.error = `disconnected ${why}`; push(); delete st.error; if (room === r) { room = null; st.live = false; push(); } });
    // lk.transcription: the agent's words and yours, as text streams.
    r.registerTextStreamHandler("lk.transcription", async (reader, who) => {
      const mine = !!reader.info.attributes?.["lk.transcribed_track_id"];
      if (!mine && who.identity === r.localParticipant.identity) return;
      let text = "";
      if (mine) { st.heard = ""; st.answer = ""; }
      for await (const chunk of reader) { text += chunk; if (mine) st.heard = text; else st.answer = text; push(); }
    });
    serve(r);
    try {
      await r.connect(LK_URL, await Bridge.voiceToken());
      await r.localParticipant.setMicrophoneEnabled(st.hear);
      room = r; st.live = true; push();
      for (let i = 0; i < 50 && !r.remoteParticipants.size; i++) await new Promise((k) => setTimeout(k, 200));
      await new Promise((k) => setTimeout(k, 1500));
      await rpc({ stt: st.hear ? st.mode : "off", tts: st.tts ? "on" : "off" });
    } catch (e) {
      await r.disconnect().catch(() => {}); room = null; st.live = false;
      st.error = `[pc=${typeof RTCPeerConnection} md=${typeof navigator.mediaDevices} secure=${isSecureContext} ${location.protocol}] ` + String((e as Error)?.message ?? e).slice(0, 60); push(); delete st.error;
    }
  };
  void onEvent<string>("call-cmd", async (cmd) => {
    if (cmd === "toggle") return room ? stop() : start();
    if (cmd === "hear") { st.hear = !st.hear; await room?.localParticipant.setMicrophoneEnabled(st.hear); await rpc({ stt: st.hear ? st.mode : "off" }).catch(() => {}); }
    if (cmd === "speak") { st.tts = !st.tts; await rpc({ tts: st.tts ? "on" : "off" }).catch(() => {}); }
    if (cmd === "mode") { st.mode = st.mode === "fast" ? "accurate" : "fast"; if (st.hear) await rpc({ stt: st.mode }).catch(() => {}); }
    push();
  });
}
