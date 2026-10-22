// YouTube's reports → the page (src-tauri/src/youtube.rs): the same shape as
// Spotify's, kept in `YouTube`. The pill wears the title that plays.

import { Bridge, onEvent } from "../core/bridge";
import { pillDefinition } from "../core/pills";
import { YOUTUBE_ID, YouTube, type SpotifyState } from "../core/spotify";
import { State } from "../core/state";

export function registerYouTubeHandlers() {
  void onEvent<SpotifyState>("youtube", (s) => applyYouTube(s));
  void onEvent<{ artUrl: string; dataUrl: string }>("youtube-artwork", (art) => {
    YouTube.artwork = art;
    State.notify();
  });
  State.subscribe(() => {
    syncName();
    refreshWhenShown();
  });
  if (State.settings.activeIntegrations.includes(YOUTUBE_ID)) void Bridge.youtubeRefresh().then((s) => s && applyYouTube(s));
}

export function applyYouTube(next: SpotifyState) {
  YouTube.state = next;
  syncName();
  State.notify();
}

function syncName() {
  const task = State.tasks.find((x) => x.id === YOUTUBE_ID);
  if (!task) return;
  const name = YouTube.state.track?.title || (pillDefinition(YOUTUBE_ID)?.name ?? "YouTube");
  if (task.name !== name) task.name = name;
}

let shown = false;
function refreshWhenShown() {
  const now = State.mode === "expanded" && State.view === "overview" && State.focusTask?.id === YOUTUBE_ID;
  if (now && !shown) void Bridge.youtubeRefresh();
  shown = now;
}
