// The YouTube pill: whichever browser (or app) is playing media, read through
// MPRIS like Spotify's pill, but by polling: any `org.mpris.MediaPlayer2.*`
// name except Spotify's own and playerctld. The state is Spotify's
// `PlayerState`, so the card and pill on the page are the same views.
// ponytail: it follows what plays, not what is on YouTube (browsers give no
// URL over MPRIS); add a title/URL filter if other audio gets in the way.

use crate::spotify::PlayerState;
use tauri::AppHandle;

pub const PILL_ID: &str = "integration_youtube";

/// Starts the poller when the pill is declared, stops it when it is not.
pub fn sync(app: &AppHandle, active_integrations: &[String]) {
    let on = active_integrations.iter().any(|id| id == PILL_ID);
    #[cfg(target_os = "linux")]
    linux::sync(app, on);
    #[cfg(not(target_os = "linux"))]
    let _ = (app, on);
}

/// The player as it is now (the card coming on screen).
#[tauri::command]
pub async fn youtube_refresh(app: AppHandle) -> Option<PlayerState> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let conn = dbus::blocking::Connection::new_session().ok()?;
            linux::poll(&conn, &app, true)
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        None
    }
}

/// `playPause`, `next`, `previous`, `seek` (seconds), `volume` (0…100).
#[tauri::command]
pub async fn youtube_control(action: String, value: Option<f64>) -> bool {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::control(&action, value)).await.unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (action, value);
        false
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::spotify::linux::props_of;
    use crate::spotify::{artwork_source, data_url, ArtSource};
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;
    use serde::Serialize;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{LazyLock, Mutex};
    use std::time::Duration;
    use tauri::Emitter;

    const PATH: &str = "/org/mpris/MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    const PREFIX: &str = "org.mpris.MediaPlayer2.";
    const CALL: Duration = Duration::from_millis(1500);
    const ART_LIMIT: u64 = 3 * 1024 * 1024;

    static GENERATION: AtomicU64 = AtomicU64::new(0);

    struct Last {
        bus: Option<String>,
        state: PlayerState,
        art_url: Option<String>,
    }
    static LAST: LazyLock<Mutex<Last>> =
        LazyLock::new(|| Mutex::new(Last { bus: None, state: PlayerState::default(), art_url: None }));

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Artwork {
        art_url: String,
        data_url: String,
    }

    pub fn sync(app: &AppHandle, on: bool) {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        if !on {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            // One connection for the whole run; slow when nothing plays.
            let Ok(conn) = Connection::new_session() else { return };
            while GENERATION.load(Ordering::SeqCst) == generation {
                let found = poll(&conn, &app, false).is_some_and(|s| s.running);
                std::thread::sleep(Duration::from_millis(if found { 2000 } else { 5000 }));
            }
        });
    }

    fn players(conn: &Connection) -> Vec<String> {
        let (names,): (Vec<String>,) = conn
            .with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", CALL)
            .method_call("org.freedesktop.DBus", "ListNames", ())
            .unwrap_or_default();
        names
            .into_iter()
            .filter(|n| n.starts_with(PREFIX) && !n.ends_with(".spotify") && !n.ends_with(".playerctld"))
            .collect()
    }

    /// One look at every player; emits when something changed (or when `force`).
    pub fn poll(conn: &Connection, app: &AppHandle, force: bool) -> Option<PlayerState> {
        let now = crate::spotify::now_ms_pub();
        let mut found: Vec<(String, PlayerState)> = vec![];
        for bus in players(conn) {
            let Ok(props) = conn.with_proxy(bus.as_str(), PATH, CALL).get_all(PLAYER) else { continue };
            let mut st = PlayerState::default();
            st.apply(&props_of(&props), now);
            if st.track.is_some() {
                st.running = true;
                st.installed = true;
                found.push((bus, st));
            }
        }
        let mut last = LAST.lock().unwrap();
        let pick = found
            .iter()
            .find(|(b, s)| s.playing && Some(b) == last.bus.as_ref())
            .or_else(|| found.iter().find(|(_, s)| s.playing))
            .or_else(|| found.iter().find(|(b, _)| Some(b) == last.bus.as_ref()))
            .or_else(|| found.first());
        let (bus, mut next) = match pick {
            Some((b, s)) => (Some(b.clone()), s.clone()),
            None => (None, PlayerState { installed: true, ..PlayerState::default() }),
        };
        next.position_at = now;
        let expected = last.state.position_at_time(now);
        let same = last.state.track == next.track
            && last.state.playing == next.playing
            && last.state.volume == next.volume
            && last.state.running == next.running
            && (next.position - expected).abs() < 2.5;
        last.bus = bus;
        if same && !force {
            return Some(last.state.clone());
        }
        let art = next.track.as_ref().and_then(|t| t.art_url.clone());
        let art_changed = art != last.art_url;
        last.art_url = art.clone();
        last.state = next.clone();
        drop(last);
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "youtube", &next);
        if let Some(url) = art.filter(|_| art_changed || force) {
            // Browsers hand over a local file; anything else is not read.
            if let Some(ArtSource::File(path)) = artwork_source(&url) {
                let bytes = std::fs::metadata(&path)
                    .ok()
                    .filter(|m| m.is_file() && m.len() <= ART_LIMIT)
                    .and_then(|_| std::fs::read(&path).ok());
                if let Some(data) = bytes.as_deref().and_then(data_url) {
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, "youtube-artwork", Artwork { art_url: url, data_url: data });
                }
            }
        }
        Some(next)
    }

    pub fn control(action: &str, value: Option<f64>) -> bool {
        let (bus, state) = {
            let l = LAST.lock().unwrap();
            (l.bus.clone(), l.state.clone())
        };
        let Some(bus) = bus else { return false };
        let Ok(conn) = Connection::new_session() else { return false };
        let p = conn.with_proxy(bus.as_str(), PATH, CALL);
        let v = value.unwrap_or(0.0);
        let done: Result<(), dbus::Error> = match action {
            "playPause" => p.method_call(PLAYER, "PlayPause", ()),
            "next" => p.method_call(PLAYER, "Next", ()),
            "previous" => p.method_call(PLAYER, "Previous", ()),
            "seek" => match state.track.as_ref() {
                None => Err(dbus::Error::new_failed("no track")),
                Some(track) => {
                    let target_us = (v.clamp(0.0, (track.duration - 1.0).max(0.0)) * 1_000_000.0) as i64;
                    match dbus::Path::new(track.object_path.clone()) {
                        Ok(path) => p.method_call(PLAYER, "SetPosition", (path, target_us)),
                        Err(_) => {
                            let from = (state.position_at_time(crate::spotify::now_ms_pub()) * 1_000_000.0) as i64;
                            p.method_call(PLAYER, "Seek", (target_us - from,))
                        }
                    }
                }
            },
            "volume" => p.set(PLAYER, "Volume", (v / 100.0).clamp(0.0, 1.0)),
            _ => Err(dbus::Error::new_failed("unknown action")),
        };
        done.is_ok()
    }
}
