//! Focus timer: stay on one browser tab or one desktop window (X11: xdotool + xprop; tabs through `bsk`).
//! Leave it for GRACE seconds: alert (red, bell). CLOSE_AFTER seconds off target: the violating tab is closed.
//! The tab/window operations are plain pub fns so Hermes can call them later.

use crate::island::WINDOW_LABEL;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const ID: &str = "integration_focus";
const GRACE: u64 = 5;
const CLOSE_AFTER: u64 = 15; // 5 s grace + 10 s alarm

#[derive(Serialize, Deserialize, Clone)]
pub struct Target {
    kind: String, // "tab" | "window"
    id: String,   // tab id or X window id
    title: String,
}

struct Session {
    gen: u64,
    targets: Vec<Target>,
    started: Instant,
    total: u64,
    violations: u32,
    off_since: Option<Instant>,
    alerted: bool,
    closed: u32,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static GEN: Mutex<u64> = Mutex::new(0);

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(cmd).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Title without the browser suffix and the "(3) " unread counter, so it compares across ticks.
pub fn norm(t: &str) -> String {
    let t = t.trim();
    let t = t.rsplit_once(" - ").map(|(a, b)| if b.contains("Chrome") || b.contains("Chromium") || b.contains("Brave") || b.contains("Firefox") || b.contains("Edge") { a } else { t }).unwrap_or(t);
    let t = match (t.strip_prefix('('), t.find(") ")) {
        (Some(_), Some(i)) if t[1..i].chars().all(|c| c.is_ascii_digit()) => &t[i + 2..],
        _ => t,
    };
    t.trim().to_string()
}

fn focused() -> Option<(String, String)> {
    let id = run("xdotool", &["getwindowfocus"])?;
    let name = run("xdotool", &["getwindowname", &id])?;
    Some((id, name))
}

fn is_browser(win: &str) -> bool {
    run("xprop", &["-id", win, "WM_CLASS"]).map(|s| { let s = s.to_lowercase(); ["chrome", "chromium", "brave", "firefox", "edge"].iter().any(|b| s.contains(b)) }).unwrap_or(false)
}

/// One request to the Chrome extension's native host (extension/host.py) over its Unix socket.
fn host(req: &str) -> Option<Value> {
    use std::io::{BufRead, BufReader, Write};
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let mut s = std::os::unix::net::UnixStream::connect(format!("{dir}/coucou-tabs.sock")).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.write_all(format!("{req}\n").as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// Tabs of every window: { tab_id, title, url, active } (needs the extension in extension/).
pub fn tab_list() -> Vec<Value> {
    host(r#"{"cmd":"list"}"#).and_then(|v| v["tabs"].as_array().cloned()).unwrap_or_default()
}

/// Brings a tab to the front.
pub fn tab_select(tab_id: &str) -> bool {
    host(&json!({ "cmd": "select", "id": tab_id.trim_matches('"') }).to_string()).is_some()
}

/// Closes the focused tab of the focused browser window (Ctrl+W). Only when a browser has the focus.
pub fn close_focused_tab() -> bool {
    let Some((id, _)) = focused() else { return false };
    is_browser(&id) && run("xdotool", &["key", "--clearmodifiers", "--window", &id, "ctrl+w"]).is_some()
}

pub fn window_list() -> Vec<Target> {
    let ids = run("xdotool", &["search", "--onlyvisible", "--name", "."]).unwrap_or_default();
    let mut out: Vec<Target> = vec![];
    for id in ids.lines() {
        let Some(title) = run("xdotool", &["getwindowname", id]) else { continue };
        if title.trim().is_empty() || title.to_lowercase().contains("coucou") || out.iter().any(|t| t.title == title) { continue }
        out.push(Target { kind: "window".into(), id: id.into(), title });
    }
    out
}

fn emit(app: &AppHandle, data: Value) {
    let _ = app.emit_to(WINDOW_LABEL, "integration", crate::integrations::IntegrationUpdate { id: ID, data, error: None, event: None });
}

fn snapshot(s: Option<&Session>) -> Value {
    match s {
        None => json!({ "phase": "idle" }),
        Some(s) => {
            let el = s.started.elapsed().as_secs();
            let off = s.off_since.map(|o| o.elapsed().as_secs()).unwrap_or(0);
            let phase = if el >= s.total { "done" } else if s.alerted { "alert" } else { "run" };
            json!({ "phase": phase, "remaining": s.total.saturating_sub(el), "total": s.total, "targets": s.targets,
                    "violations": s.violations, "closeIn": CLOSE_AFTER.saturating_sub(off), "closed": s.closed })
        }
    }
}

/// One tick: is the focus on the target? Returns false when the session is over.
fn tick(app: &AppHandle, gen: u64) -> bool {
    let cur = focused();
    let mut g = SESSION.lock().unwrap();
    let Some(s) = g.as_mut().filter(|s| s.gen == gen) else { return false };
    if s.started.elapsed().as_secs() >= s.total {
        emit(app, snapshot(Some(s)));
        return false;
    }
    let on = match &cur {
        None => true, // focus changing: no verdict
        Some((id, name)) => name.to_lowercase().contains("coucou") || s.targets.iter().any(|t| if t.kind == "window" { *id == t.id } else { is_browser(id) && norm(name) == norm(&t.title) }),
    };
    if on {
        s.off_since = None;
        s.alerted = false;
    } else {
        let since = *s.off_since.get_or_insert_with(Instant::now);
        let off = since.elapsed().as_secs();
        if off >= GRACE && !s.alerted {
            s.alerted = true;
            s.violations += 1;
        }
        // Ladder: Ctrl+W on the violating tab; if it is still there 3 s later, pull the user back to the target.
        if off >= CLOSE_AFTER && (off - CLOSE_AFTER) % 3 == 0 {
            let first_t = s.targets[0].clone();
            let tab = first_t.kind == "tab";
            let (tid, wid) = (first_t.id.clone(), first_t.id.clone());
            let first = off == CLOSE_AFTER;
            drop(g);
            let ok = first && close_focused_tab();
            if ok {
                if let Some(s) = SESSION.lock().unwrap().as_mut().filter(|s| s.gen == gen) { s.closed += 1 }
            } else if tab {
                tab_select(&tid);
            } else {
                run("xdotool", &["windowactivate", &wid]);
            }
            g = SESSION.lock().unwrap();
        }
    }
    emit(app, snapshot(g.as_ref()));
    true
}

#[tauri::command]
pub async fn focus_start(app: AppHandle, minutes: u64, targets: Vec<Target>) -> Result<(), String> {
    if minutes == 0 || minutes > 600 || targets.is_empty() || targets.iter().any(|t| t.kind != "tab" && t.kind != "window") { return Err("bad focus request".into()) }
    let gen = { let mut g = GEN.lock().unwrap(); *g += 1; *g };
    *SESSION.lock().unwrap() = Some(Session { gen, targets, started: Instant::now(), total: minutes * 60, violations: 0, off_since: None, alerted: false, closed: 0 });
    tauri::async_runtime::spawn(async move {
        loop {
            let a = app.clone();
            let go = tokio::task::spawn_blocking(move || tick(&a, gen)).await.unwrap_or(false);
            if !go { break }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn focus_stop(app: AppHandle) {
    *SESSION.lock().unwrap() = None;
    emit(&app, snapshot(None));
}

#[tauri::command]
pub fn focus_state() -> Value { snapshot(SESSION.lock().unwrap().as_ref()) }

#[tauri::command]
pub async fn focus_targets() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| {
        let tabs: Vec<Value> = tab_list().into_iter().map(|t| json!({ "kind": "tab", "id": t["tab_id"].to_string(), "title": t["title"] })).collect();
        json!({ "tabs": tabs, "windows": window_list() })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn focus_tab_select(id: String) -> bool { tokio::task::spawn_blocking(move || tab_select(&id)).await.unwrap_or(false) }

#[tauri::command]
pub async fn focus_tab_close() -> bool { tokio::task::spawn_blocking(close_focused_tab).await.unwrap_or(false) }

#[cfg(test)]
mod tests {
    #[test]
    fn norm_strips_counter_and_suffix() {
        assert_eq!(super::norm("(8) Facebook - Google Chrome"), "Facebook");
        assert_eq!(super::norm("a - b"), "a - b");
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn scan() {
        println!("WIN {}", super::window_list().len());
        println!("TAB {}", super::tab_list().len());
    }
}
