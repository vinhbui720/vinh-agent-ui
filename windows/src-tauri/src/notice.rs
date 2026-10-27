// Hermes notices (`Say` hook events) across two machines. Hermes runs on one machine; the other reaches it over
// SSH (`hermes-host`). Three pieces, all in Coucou's own data folder on the Hermes machine (never in ~/.hermes):
//  * `notices.jsonl`: the relay appends each `Say` there (pipe.rs); the other machine tails it and replays the
//    lines as `hook` events, so its island shows and reads the notice like a local one;
//  * `focus`: "<machine> <unix seconds>", written when you open or hover an island: the machine that last did
//    speaks, and only within STALE seconds, else the notice waits as a badge;
//  * the text of a notice is never logged.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

const STALE: u64 = 600;
const MAX_FILE: u64 = 64 * 1024;

fn dir() -> PathBuf {
    crate::settings::local_dir()
}

fn me() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn host() -> Option<String> {
    crate::secrets::get("hermes-host").map(|h| h.trim().to_string()).filter(|h| !h.is_empty() && !h.starts_with('-'))
}

/// Runs `script` on the Hermes machine, with `input` on its stdin; its stdout.
fn ssh(host: &str, script: &str, input: Option<&str>) -> Option<String> {
    let mut c = Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", host, "--", script])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    if let (Some(mut w), Some(i)) = (c.stdin.take(), input) {
        let _ = w.write_all(i.as_bytes());
    }
    let o = c.wait_with_output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

const REMOTE_DIR: &str = "d=\"$HOME/.local/share/coucou\"; mkdir -p \"$d\"";

/// The relay (pipe.rs) calls this for every `Say`: one line, the file kept small.
pub fn record(payload: &Value) {
    let Some(message) = payload.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) else { return };
    let line = json!({ "hook_event_name": "Say", "coucou_agent": payload.get("coucou_agent").and_then(Value::as_str).unwrap_or("hermes"), "message": message });
    let path = dir().join("notices.jsonl");
    let _ = std::fs::create_dir_all(dir());
    let big = std::fs::metadata(&path).map(|m| m.len() > MAX_FILE).unwrap_or(false);
    let mut o = std::fs::OpenOptions::new();
    o.create(true).write(true);
    if big { o.truncate(true); } else { o.append(true); }
    if let Ok(mut f) = o.open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// You opened or hovered this machine's island: it speaks next.
#[tauri::command]
pub async fn notice_focus() {
    let line = format!("{} {}\n", me(), now());
    let _ = tokio::task::spawn_blocking(move || match host() {
        Some(h) => { ssh(&h, &format!("{REMOTE_DIR}; cat > \"$d/focus\""), Some(&line)); }
        None => { let _ = std::fs::create_dir_all(dir()); let _ = std::fs::write(dir().join("focus"), line); }
    }).await;
}

/// Whether this machine has the focus right now (and not for longer than STALE ago).
#[tauri::command]
pub async fn notice_can_speak() -> bool {
    tokio::task::spawn_blocking(|| {
        let text = match host() {
            Some(h) => ssh(&h, &format!("{REMOTE_DIR}; cat \"$d/focus\" 2>/dev/null"), None),
            None => std::fs::read_to_string(dir().join("focus")).ok(),
        };
        let text = text.unwrap_or_default();
        let mut it = text.split_whitespace();
        let (name, at) = (it.next().unwrap_or(""), it.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0));
        name == me() && now().saturating_sub(at) <= STALE
    }).await.unwrap_or(false)
}

/// With a Hermes host set: follow its notices for as long as Coucou runs (reconnects on its own).
pub fn start(app: &AppHandle) {
    if host().is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let Some(h) = host() else { return };
        let child = Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", &h, "--",
                &format!("{REMOTE_DIR}; touch \"$d/notices.jsonl\"; exec tail -F -n0 \"$d/notices.jsonl\"")])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        if let Ok(mut c) = child {
            if let Some(out) = c.stdout.take() {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if v["hook_event_name"] == "Say" {
                            let _ = app.emit_to(WINDOW_LABEL, "hook", v);
                        }
                    }
                }
            }
            let _ = c.kill();
            let _ = c.wait();
        }
        std::thread::sleep(Duration::from_secs(10));
    });
}
