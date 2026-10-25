// The Call tab, as a phone call. Phone and desktop browser both: the page itself joins the LiveKit room (WebRTC works
// in a real browser), picks which computer does the work, and the agent talks. Work goes back to that computer through
// the Coucou web gateway (RPC run_task etc., answered here). The desktop app itself uses the pill (core/call.ts).
import { Room, RoomEvent, Track } from "livekit-client";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { call } from "../core/flow";
import { lkUrl } from "../core/call";
import { listen } from "../mochi/anims/listen";
import { drawVectorAnim } from "../mochi/vector-anim";
import type { ViewActions, ViewHost } from "./views";
import { t as tl } from "../i18n/i18n";

interface Machine { id: string; name: string; online: boolean; here: boolean }
const WHO = (localStorage.getItem("callWho") || (localStorage.setItem("callWho", "ph" + Math.random().toString(36).slice(2, 8)), localStorage.getItem("callWho")))!;

export function buildPhoneCall(_actions: ViewActions): ViewHost {
  let room: Room | null = null, machines: Machine[] = [], pick = localStorage.getItem("callMachine") || "host";
  let speaker = true, muted = false, t0 = 0, timer = 0;
  const audio = new Set<HTMLMediaElement>();
  const avatar = h("canvas", { class: "pc-avatar", width: 300, height: 260 }) as HTMLCanvasElement;
  const who = h("div", { class: "pc-who" });
  const status = h("div", { class: "pc-status" });
  const heard = h("div", { class: "pc-heard" });
  const answer = h("div", { class: "pc-answer" });
  const list = h("div", { class: "pc-machines" });
  const ctl = h("div", { class: "pc-ctl" });
  const el = h("div", { class: "view phonecall" }, h("div", { class: "card" }, h("div", { class: "pc" }, who, status, avatar, heard, answer, list, ctl)));

  const fmt = () => { const s = Math.floor((Date.now() - t0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name ?? "";
  const round = (cls: string, icon: string, label: string, on: () => void, active = false) => {
    const b = h("button", { class: `pc-btn ${cls}${active ? " on" : ""}`, "aria-label": label, onclick: on }, svg(icon, 24), h("span", { text: label }));
    return b;
  };
  const rpc = async (p: object) => {
    const r = room, a = r && [...r.remoteParticipants.values()].find((x) => x.identity.startsWith("agent") || x.isAgent);
    if (r && a) await r.localParticipant.performRpc({ destinationIdentity: a.identity, method: "set_io", payload: JSON.stringify(p) }).catch(() => {});
  };
  const draw = (() => {
    const x = avatar.getContext("2d")!; let on = 0, t = 0;
    const tick = () => { if (!room) { on = 0; x.clearRect(0, 0, 300, 260); return; } const e = Math.floor((performance.now() - t) / 125); x.clearRect(0, 0, 300, 260); drawVectorAnim(x, listen, ((e < 5 ? e : 5 + ((e - 5) % 16)) + 0.01) / listen.fps, 150, 130, 1); on = requestAnimationFrame(tick); };
    return () => { if (!on) { t = performance.now(); on = requestAnimationFrame(tick); } };
  })();

  function paint() {
    const live = !!room;
    who.textContent = live ? nameOf(pick) : tl("Call");
    status.textContent = live ? fmt() : "";
    list.style.display = live ? "none" : "";
    list.replaceChildren(...machines.map((m) => h("button", {
      class: `pc-m${m.id === pick ? " on" : ""}${m.id ? "" : " off"}`, disabled: !m.id || !m.online,
      title: !m.id ? tl("Nothing to answer on this computer yet") : !m.online ? tl("Offline") : "",
      onclick: () => { pick = m.id; localStorage.setItem("callMachine", pick); paint(); },
    }, h("i", { class: m.online ? "on" : "" }), h("span", { text: m.name }), m.here ? h("em", { text: tl("this computer") }) : null)));
    ctl.replaceChildren(...(live
      ? [round("mute", ICONS.mic, muted ? tl("Unmute") : tl("Mute"), () => { muted = !muted; void room?.localParticipant.setMicrophoneEnabled(!muted); void rpc({ stt: muted ? "off" : "fast" }); paint(); }, muted),
         round("spk", ICONS.speaker, speaker ? tl("Speaker") : tl("Earpiece"), () => { speaker = !speaker; route(); paint(); }, speaker),
         round("end", ICONS.phoneDown, tl("End"), () => void hang())]
      : [round("go", ICONS.phone, tl("Call"), () => void dial())]));
  }

  /** Loudspeaker or earpiece: setSinkId where the browser has it (Android Chrome); iOS keeps its own routing. */
  function route() {
    if (!("setSinkId" in HTMLMediaElement.prototype)) return;
    void navigator.mediaDevices.enumerateDevices().then((ds) => {
      const outs = ds.filter((d) => d.kind === "audiooutput");
      const ear = outs.find((d) => /earpiece|receiver|handset|phone/i.test(d.label));
      const spk = outs.find((d) => /speaker/i.test(d.label)) ?? outs.find((d) => d.deviceId === "default");
      const id = (speaker ? spk : ear)?.deviceId;
      if (id) audio.forEach((a) => void (a as any).setSinkId(id).catch(() => {}));
    });
  }

  async function dial() {
    const r = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    r.on(RoomEvent.TrackSubscribed, (tr) => { if (tr.kind === Track.Kind.Audio) { const a = tr.attach(); document.body.appendChild(a); audio.add(a); route(); } });
    r.on(RoomEvent.TrackUnsubscribed, (tr) => tr.detach().forEach((e) => { audio.delete(e as HTMLMediaElement); e.remove(); }));
    r.on(RoomEvent.Disconnected, () => { if (room === r) void hang(true); });
    r.registerTextStreamHandler("lk.transcription", async (reader, from) => {
      const mine = !!reader.info.attributes?.["lk.transcribed_track_id"];
      if (!mine && from.identity === r.localParticipant.identity) return;
      let text = ""; if (mine) { heard.textContent = ""; answer.textContent = ""; }
      for await (const c of reader) { text += c; (mine ? heard : answer).textContent = text; }
    });
    // The work goes to the computer that serves this page (its OpenCode, its folders): the gateway answers for it.
    r.registerRpcMethod("run_task", async (d) => { const { task, allowBlocked } = JSON.parse(d.payload); return (await call<string>("voice_run", { task, allowBlocked: !!allowBlocked })) ?? ""; });
    r.registerRpcMethod("recall", async (d) => (await call<string>("voice_recall", { query: d.payload })) ?? "");
    r.registerRpcMethod("cancel", async () => String(await call<number>("voice_cancel")));
    r.registerRpcMethod("mem_add", async (d) => { const { who: w, text } = JSON.parse(d.payload); await call<void>("voice_mem_add", { who: w, text }); return "ok"; });
    r.registerRpcMethod("context", async () => (await call<string>("voice_context")) ?? "");
    status.textContent = tl("Connecting…");
    try {
      await r.connect(lkUrl(), await Bridge.voiceToken(WHO, pick));
      await r.localParticipant.setMicrophoneEnabled(true);
      room = r; t0 = Date.now(); muted = false; draw(); timer = window.setInterval(() => { if (room) status.textContent = fmt(); }, 1000);
      for (let i = 0; i < 50 && !r.remoteParticipants.size; i++) await new Promise((k) => setTimeout(k, 200));
      await new Promise((k) => setTimeout(k, 1500)); await rpc({ stt: "fast", tts: "on" });
      paint();
    } catch (e) { await r.disconnect().catch(() => {}); room = null; paint(); status.textContent = String((e as Error)?.message ?? e).slice(0, 80); }
  }

  async function hang(already = false) {
    const r = room; room = null; clearInterval(timer); heard.textContent = answer.textContent = "";
    if (r && !already) { await call<number>("voice_cancel").catch(() => {}); await r.disconnect().catch(() => {}); }
    audio.forEach((a) => a.remove()); audio.clear(); paint();
  }

  const load = async () => { machines = (await call<Machine[]>("call_machines")) ?? []; if (!machines.some((m) => m.id === pick && m.online)) pick = machines.find((m) => m.id && m.online)?.id ?? "host"; paint(); };
  paint();
  return { el, sync() { if (!room) void load(); } };
}
