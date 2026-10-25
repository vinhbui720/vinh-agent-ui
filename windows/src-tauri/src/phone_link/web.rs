// ponytail: events not replayed to late joiners; add a ring buffer if pills look empty on connect.
// The web app's gateway (windows/web/index.html, a PWA the phone adds to its Home Screen).
// A tiny HTTP server on 127.0.0.1 only: `coucou-web.py` proxies /api/live/* here, and
// `tailscale serve` is what exposes that to the tailnet. No token: the tailnet is the lock and `one` checks Host/Origin.
// the tailnet (see the check in `one`). It is the same picture the phone link gets
// (hub snapshot), the same decision path (Hub::decide, so the same fingerprint, TTL and
// "too long to allow from a phone" rules), OpenCode's own functions, and the ElevenLabs voice.
// No telemetry; nothing is logged but the route.


use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::hub;
use crate::{log, opencode, Shared};
use std::sync::OnceLock;
use tauri::{Emitter, Listener, WebviewWindow};
use std::sync::Mutex;
use tokio::sync::broadcast;

const PORT: u16 = 8766;
const MAX_BODY: usize = 24 * 1024 * 1024; // dictation clips arrive base64 in the body

pub fn start(app: &AppHandle) {
    let app = app.clone();
    forward_events(&app);
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)).await else {
            log::line("web gateway: port busy, not started");
            return;
        };
        log::line(format!("web gateway: 127.0.0.1:{PORT}"));
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                one(app, stream).await;
            });
        }
    });
}

async fn read_request(s: &mut TcpStream) -> Option<(String, String, Vec<(String, String)>, Vec<u8>)> {
    tokio::time::timeout(std::time::Duration::from_secs(15), read_request_inner(s)).await.ok()?
}

async fn read_request_inner(s: &mut TcpStream) -> Option<(String, String, Vec<(String, String)>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = buf[end + 4..].to_vec();
    while body.len() < len {
        let n = s.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Some((method, path, headers, body))
}

async fn reply(s: &mut TcpStream, code: u16, body: Value) {
    let b = body.to_string();
    let head = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len());
    let _ = s.write_all(head.as_bytes()).await;
    let _ = s.write_all(b.as_bytes()).await;
}



/// What the browser island may do. Everything else answers null, so desktop-only calls
/// (window moves, settings, secrets, hooks) stay out of reach of a token holder.
const EVENTS: &[&str] = &[
    "hook", "integration", "github-alerts", "chat-delta", "notes-changed", "settings-changed",
    "spotify", "spotify-artwork", "youtube", "youtube-artwork", "voice-say",
];

static SNAPSHOT: Mutex<String> = Mutex::new(String::new());

/// The desktop island's picture of itself: cached for late joiners, pushed to every browser.
#[tauri::command]
pub fn web_state(window: WebviewWindow, snapshot: String) -> Result<(), String> {
    super::only_island(&window)?;
    let msg = format!("{{\"event\":\"web-state\",\"payload\":{snapshot}}}");
    *SNAPSHOT.lock().unwrap() = msg.clone();
    let _ = bus().send(msg);
    Ok(())
}

/// Any module: send an event to every browser on the gateway (the call page).
pub fn push(event: &str, payload: Value) {
    let _ = bus().send(json!({ "event": event, "payload": payload }).to_string());
}

fn bus() -> &'static broadcast::Sender<String> {
    static BUS: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    BUS.get_or_init(|| broadcast::channel(256).0)
}

/// The island window's own listeners see every event emitted to it; mirror them to the bus.
fn forward_events(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let win = loop {
            if let Some(w) = app.get_webview_window(crate::island::WINDOW_LABEL) {
                break w;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        };
        for name in EVENTS {
            win.listen(*name, move |e| {
                let payload: Value = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
                let _ = bus().send(json!({ "event": name, "payload": payload }).to_string());
            });
        }
    });
}

fn arg<T: serde::de::DeserializeOwned + Default>(a: &Value, k: &str) -> T {
    serde_json::from_value(a[k].clone()).unwrap_or_default()
}

async fn rpc(app: &AppHandle, cmd: &str, a: &Value) -> Result<Value, String> {
    let s = |k: &str| -> String { arg(a, k) };
    fn j<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
        r.map(|v| json!(v))
    }
    match cmd {
        "boot" => Ok(json!(crate::boot(app.clone(), app.state::<Shared>()))),
        "approval_decision" => {
            let _ = app.emit_to(crate::island::WINDOW_LABEL, "phone-link-decided", s("requestId"));
            Ok(json!(crate::approval_decision(app.clone(), s("requestId"), s("decision"))))
        }
        "approval_answer" => {
            let _ = app.emit_to(crate::island::WINDOW_LABEL, "phone-link-decided", s("requestId"));
            Ok(json!(crate::approval_answer(app.clone(), s("requestId"), arg(a, "answers"))))
        }
        "approval_ack" => Ok(json!(crate::approval_ack(app.clone(), s("requestId")))),
        "chat_send" => j(crate::chat_send(
            app.clone(), app.state::<Shared>(), app.state::<crate::chat::PillChats>(),
            s("pill"), s("query"), serde_json::from_value(a["context"].clone()).ok(),
        ).await),
        "chat_reset" => Ok(json!(crate::chat_reset(app.state::<crate::chat::PillChats>(), s("pill")))),
        "chat_models" => j(crate::chat_models(app.state::<Shared>(), s("provider")).await),
        "hermes_ask" => j(crate::hermes::hermes_ask(app.clone(), s("text"), a["session"].as_str().map(String::from)).await),
        "focus_state" => j(Ok::<_, String>(crate::focus::focus_state())),
        "obsidian_overview" => j(crate::obsidian::obsidian_overview().await),
        "obsidian_toggle" => j(crate::obsidian::obsidian_toggle(s("file"), arg(a, "line"), s("text")).await),
        "obsidian_add" => j(crate::obsidian::obsidian_add(s("text"), s("day")).await),
        "notes_list" => j(crate::vault_notes::list()),
        "notes_read" => j(crate::vault_notes::read(&s("path"))),
        "notes_write" => j(crate::vault_notes::write(&s("path"), &s("text"), arg(a, "expect"))),
        "notes_rename" => j(crate::vault_notes::rename(&s("from"), &s("to"))),
        "notes_delete" => j(crate::vault_notes::delete(&s("path"))),
        "opencode_sessions" => j(opencode::sessions().await),
        "opencode_create" => j(opencode::create(&s("directory")).await),
        "opencode_history" => j(opencode::history(&s("directory")).await),
        "opencode_ls" => Ok(json!(opencode::list_dirs(&s("path")))),
        "opencode_messages" => j(opencode::messages(&s("session")).await),
        "opencode_send" => j(opencode::prompt(&s("session"), &s("text"), &s("delivery")).await),
        "opencode_interrupt" => j(opencode::interrupt(&s("session")).await),
        "opencode_permissions" => j(opencode::permissions().await),
        "opencode_reply" => j(opencode::reply(&s("session"), &s("request"), &s("decision")).await),
        "local_stt" => crate::voice::local_stt(s("audio"), a["mime"].as_str().map(String::from), a["lang"].as_str().map(String::from)).await.map(|t| json!(t)),
        "opencode_tts" => Ok(json!(crate::voice::opencode_tts(app.clone(), s("text")).await)),
        "refresh_integration" => Ok(json!(crate::refresh_integration(app.clone(), s("id")).await)),
        "github_refresh" => Ok(json!(crate::github_refresh(s("section")))),
        "spotify_refresh" => Ok(json!(crate::spotify::spotify_refresh(app.clone()).await)),
        "spotify_control" => Ok(json!(crate::spotify::spotify_control(app.clone(), s("action"), a["value"].as_f64()).await)),
        "youtube_refresh" => Ok(json!(crate::youtube::youtube_refresh(app.clone()).await)),
        "youtube_control" => Ok(json!(crate::youtube::youtube_control(s("action"), a["value"].as_f64()).await)),
        "voice_run" => j(crate::voice::voice_run(s("task"), a["allowBlocked"].as_bool()).await),
        "voice_context" => Ok(json!(crate::voice::voice_context())),
        "voice_mem_add" => j(crate::voice::mem::voice_mem_add(s("who"), s("text"))),
        "voice_recall" => j(crate::voice::mem::voice_recall(s("query"))),
        "voice_cancel" => Ok(json!(crate::voice::voice_cancel())),
        "voice_token" => j(crate::voice::voice_token(a["who"].as_str().map(String::from), a["room"].as_str().map(String::from), a["machine"].as_str().map(String::from)).await),
        "call_machines" => Ok(json!(crate::voice::call_machines().await)),
        "call_state" => { crate::voice::call_state(app.clone(), a["state"].clone()); Ok(Value::Null) }
        "secret_present" => Ok(json!(crate::secret_present(s("key")))),
        _ => Ok(Value::Null),
    }
}

fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" | "webmanifest" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

async fn serve_static(s: &mut TcpStream, route: &str) {
    let home = std::env::var_os("HOME").unwrap_or_default();
    let root = std::path::Path::new(&home).join(".local/share/coucou/web");
    let rel = if route == "/" { "web.html" } else { route.trim_start_matches('/') };
    let file = root.join(rel);
    let ok = !rel.contains("..") && file.is_file();
    match ok.then(|| std::fs::read(&file).ok()).flatten() {
        Some(b) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                mime(rel), b.len()
            );
            let _ = s.write_all(head.as_bytes()).await;
            let _ = s.write_all(&b).await;
        }
        None => reply(s, 404, json!({ "error": "not found" })).await,
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn one(app: AppHandle, mut s: TcpStream) {
    let Some((method, path, headers, body)) = read_request(&mut s).await else { return };
    let route = path.split('?').next().unwrap_or("").to_string();
    if method == "GET" && !route.starts_with("/api/") {
        return serve_static(&mut s, &route).await;
    }
    // No token: the only way in is the tailnet (tailscale serve) or this machine. What is left
    // to stop is a web page in a browser on this machine calling 127.0.0.1 (CSRF, DNS rebinding):
    // the Host must be ours and an Origin, when sent, must be the same site.
    let hdr = |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.as_str());
    let host = hdr("host").unwrap_or("").split(':').next().unwrap_or("").to_lowercase();
    let host_ok = host == "localhost" || host == "127.0.0.1" || host.ends_with(".ts.net") || host.starts_with("100.");
    let origin_ok = hdr("origin").map_or(true, |o| o.split("://").nth(1).is_some_and(|h| h.eq_ignore_ascii_case(hdr("host").unwrap_or(""))));
    if !(host_ok && origin_ok) {
        return reply(&mut s, 403, json!({ "error": "forbidden" })).await;
    }
    match (method.as_str(), route.as_str()) {
        ("GET", "/api/events") => {
            let mut rx = bus().subscribe();
            let first = SNAPSHOT.lock().unwrap().clone();
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n: ok\n\n";
            if s.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            if !first.is_empty() && s.write_all(format!("data: {first}\n\n").as_bytes()).await.is_err() {
                return;
            }
            loop {
                let line = match tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv()).await {
                    Ok(Ok(m)) => format!("data: {m}\n\n"),
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                    Ok(Err(_)) => return,
                    Err(_) => ": ping\n\n".to_string(),
                };
                if s.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
        ("GET", "/api/note-image") => {
            let p = path.split_once("?p=").or_else(|| path.split_once("&p=")).map(|(_, r)| r.split('&').next().unwrap_or("")).unwrap_or("");
            match crate::vault_notes::image(&pct_decode(p)) {
                Ok((b, m)) => {
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {m}\r\nContent-Length: {}\r\nCache-Control: private, max-age=300\r\nConnection: close\r\n\r\n", b.len());
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(&b).await;
                }
                Err(e) => reply(&mut s, 404, json!({ "error": e })).await,
            }
        }
        ("POST", "/api/rpc") => {
            let body: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
            let cmd = body["cmd"].as_str().unwrap_or("").to_string();
            log::line(format!("web gateway: rpc {cmd}"));
            let out = tokio::time::timeout(std::time::Duration::from_secs(330), rpc(&app, &cmd, &body["args"]))
                .await
                .unwrap_or_else(|_| Err("timeout".into()));
            match out {
                Ok(v) => reply(&mut s, 200, v).await,
                Err(e) => reply(&mut s, 400, json!({ "error": e })).await,
            }
        }
        _ => reply(&mut s, 404, json!({ "error": "not found" })).await,
    }
}
