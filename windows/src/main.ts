import { speakAloud } from "./island/opencode";
// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerOpenCode } from "./island/opencode";
import { registerPhoneLink } from "./island/phone-link";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerShortcutHandlers } from "./island/shortcuts";
import { registerVoiceHandlers } from "./island/voice";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { registerWhatsAppHandlers } from "./island/whatsapp";
import { SPOTIFY_ID } from "./core/spotify";
import { registerYouTubeHandlers } from "./island/youtube";
import { Recap } from "./recap/recap";
import { Updates } from "./island/update";
import { WhatsNew } from "./whats-new/controller";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";

/** Shows the language Settings asks for ("" = the system's, when Coucou has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  // Before the island exists: its canvases size their bitmaps from the pixel
  // ratio once, so the zoom correction has to land first. If zoom was adjusted,
  // wait until the ratio updates (or up to 500ms) so nothing is sized against
  // the stale value.
  const dprBefore = window.devicePixelRatio || 1;
  const zoomChanged = await Bridge.fitZoom(dprBefore);
  if (zoomChanged) {
    for (let i = 0; i < 20 && window.devicePixelRatio === dprBefore; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const island = new Island(root);
  // Browser build: the hello scene starts at once, not after the boot round trips.
  const WEB = !!(window as any).__COUCOU_WEB__;
  if (WEB) { island.launch(); (window as any).__shake = () => island.shake(); }

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();
  await island.desktop.init();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      // "Update Coucou to X…", only in the menu while a new version is out.
      case "update":
        setPaused(false);
        Updates.show();
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  const checkZoom = async () => {
    const dpr = window.devicePixelRatio || 1;
    await Bridge.fitZoom(dpr);
  };

  await onEvent<null>("screen-changed", async () => {
    await checkZoom();
    void Bridge.reposition();
    island.ensureRunning();
  });

  // A query only matches the ratio it was made for: once it changes, watch the
  // new one, or the next monitor's scale goes unnoticed and the zoom stays wrong.
  // One frame redraws Mochi at the new ratio, even while the loop is idle.
  const watchRatio = () => {
    window
      .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener?.("change", () => {
        watchRatio();
        void checkZoom();
        island.ensureRunning();
      }, { once: true });
  };
  watchRatio();

  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
      e.preventDefault();
    }
  });

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    State.settings = { ...State.settings, ...s };
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as on macOS.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    void refreshConfigured();
  });

  if ((window as any).__COUCOU_WEB__) followDesktop(island);
  else registerHookHandlers(island);
  registerOpenCode(island);
  registerPhoneLink(island);
  registerIntegrationHandlers(island);
  registerShortcutHandlers(island, () => setPaused(false));
  registerVoiceHandlers();
  registerSpotifyHandlers(island);
  registerYouTubeHandlers();
  registerWhatsAppHandlers(island);
  // New versions: Rust offers the card, the island opens it when nothing else waits.
  await Updates.register(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.settings.activeIntegrations.includes(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  // What's new, once after an update: when the greeting is over, or a few
  // seconds in when there is no greeting (the card waits for a quiet island).
  const whatsNew = () => void WhatsNew.launch(island);
  island.onGreetingDone = () => {
    checkRecap();
    whatsNew();
  };
  window.setTimeout(whatsNew, 8000);
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  if (!WEB) island.launch();
  // Browser build: coming back to the app plays the hello scene again, right away.
  if ((window as any).__COUCOU_WEB__) (window as any).__greet = () => island.launch();
  if (IS_TAURI) publishWebState();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    for (const ev of ["click", "touchstart"]) document.addEventListener(ev, () => Sound.resume(), { once: true });
  }
}

void main();

/** Desktop island → browser copy: the whole picture, debounced. */
function publishWebState() {
  let timer: number | null = null;
  const send = () => {
    timer = null;
    const chats = Object.fromEntries(Object.entries(State.chats).map(([k, v]) => [k, v.slice(-40)]));
    const oc = State.opencode;
    void Bridge.webState(JSON.stringify({
      tasks: State.tasks, focusId: State.focusId, chats, pendingApproval: State.pendingApproval,
      integrations: State.integrations, planUsage: State.planUsage, codexPlanUsage: State.codexPlanUsage,
      opencode: { sessions: oc.sessions, pending: oc.pending, selected: oc.selected },
      ls: { hermesSession: localStorage.getItem("hermesSession"), ocSel: localStorage.getItem("ocSel") },
    }));
  };
  State.subscribe(() => { if (timer == null) timer = window.setTimeout(send, 400); });
  window.setInterval(send, 30_000);
  send();
}

/** Browser copy: show what the desktop island shows. */
let lastDesktopFocus: string | null = null;
function followDesktop(island: Island) {
  void onEvent<{ hook_event_name?: string; message?: string }>("hook", (p) => { if (p.hook_event_name === "Say" && p.message) speakAloud(p.message); });
  void onEvent<any>("web-state", (s) => {
    if (!s) return;
    const wasApproval = State.pendingApproval?.requestId;
    State.tasks = s.tasks ?? [];
    // The phone keeps its own selection; the desktop's only moves it when the desktop's changes.
    if (s.focusId && s.focusId !== lastDesktopFocus) { State.focusId = s.focusId; lastDesktopFocus = s.focusId; }
    for (const [k, v] of Object.entries<any[]>(s.chats ?? {})) {
      if ((State.chats[k]?.length ?? 0) <= v.length) State.chats[k] = v;
    }
    State.integrations = s.integrations ?? {};
    State.planUsage = s.planUsage ?? null;
    State.codexPlanUsage = s.codexPlanUsage ?? null;
    State.opencode = { ...State.opencode, ...s.opencode };
    for (const [k, v] of Object.entries<any>(s.ls ?? {})) if (v) localStorage.setItem(k, v);
    State.pendingApproval = s.pendingApproval ?? null;
    if (State.pendingApproval && State.pendingApproval.requestId !== wasApproval) island.alert(State.pendingApproval.questions ? "question" : "approval");
    else if (!State.pendingApproval && (State.view === "approval" || State.view === "question")) island.setView(State.defaultView());
    State.notify();
  });
}
