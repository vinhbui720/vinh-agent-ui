// Chat with Hermes Agent: the Hermes pill's chat tab runs `hermes chat --oneshot`
// in the Obsidian vault and streams its text back as `chat-delta`. The reply
// comes with the session id, so the next message resumes the same conversation
// (Hermes remembers; Coucou keeps nothing).
// ponytail: one process per message (~8 s cold start). Upgrade: a resident
// `hermes` gateway/API once Coucou needs sub-second answers.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

/// Only read the notes unless the user clearly asks for a change; answers cite `[[Note]]`.
const NOTEBOOK: &str = "You are the user's notebook assistant for their Obsidian vault (the current folder). \
Answer from the notes and cite them as [[Note name]]; if the notes do not say, say so. \
Never create, edit, move or delete a note unless the user clearly asks, and say what you changed. \
Reply in the user's language, briefly.\n\n";

#[derive(Serialize)]
pub struct Reply {
    text: String,
    session: String,
}

fn hermes_exe() -> std::path::PathBuf {
    // A menu-launched app does not have ~/.local/bin on its PATH.
    std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".local/bin/hermes"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| "hermes".into())
}

#[tauri::command]
pub async fn hermes_ask(app: AppHandle, text: String, session: Option<String>) -> Result<Reply, String> {
    tokio::task::spawn_blocking(move || {
        let dir = crate::integrations::obsidian_vault()
            .filter(|p| p.is_dir())
            .or_else(|| std::env::var_os("HOME").map(Into::into))
            .ok_or("no folder")?;
        let session = session.filter(|s| !s.is_empty());
        let prompt = if session.is_some() { text } else { format!("{NOTEBOOK}{text}") };

        // One Hermes for every machine: with a host set, the same command runs on it over SSH
        // (key login only; Tailscale address). Its tools, memory and sessions stay there.
        let host = crate::secrets::get("hermes-host").map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
        let mut cmd;
        if let Some(host) = &host {
            if host.starts_with('-') {
                return Err("Invalid Hermes host.".into());
            }
            cmd = Command::new("ssh");
            cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "--"]);
            let resume = session.as_deref().map(|s| format!(" --resume '{}'", s.replace('\'', ""))).unwrap_or_default();
            cmd.arg(format!(
                "cd \"$HOME/Documents/Obsidian Vault\" 2>/dev/null; exec \"$HOME/.local/bin/hermes\" chat --query-file - --oneshot --format stream-json -s obsidian{resume}"
            ));
        } else {
            cmd = Command::new(hermes_exe());
            cmd.args(["chat", "--query-file", "-", "--oneshot", "--format", "stream-json", "-s", "obsidian", "--in"])
                .arg(&dir);
            if let Some(id) = &session {
                cmd.args(["--resume", id]);
            }
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Hermes (or ssh) not found.".to_string())?;
        child.stdin.take().ok_or("stdin")?.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;

        let (mut shown, mut id) = (String::new(), session.unwrap_or_default());
        for line in std::io::BufReader::new(child.stdout.take().ok_or("stdout")?).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("text") => {
                    let part = v["text"].as_str().unwrap_or_default();
                    if !shown.is_empty() {
                        shown.push('\n');
                    }
                    shown.push_str(part);
                    let _ = app.emit_to(WINDOW_LABEL, "chat-delta", shown.clone());
                }
                Some("result") => {
                    if let Some(s) = v["session_id"].as_str() {
                        id = s.to_string();
                    }
                    if let Some(t) = v["text"].as_str() {
                        shown = t.to_string();
                    }
                }
                _ => {}
            }
        }
        let _ = child.wait();
        if shown.trim().is_empty() {
            return Err("Hermes gave no answer.".into());
        }
        Ok(Reply { text: shown, session: id })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Hermes chat over ACP ─────────────────────────────────────────────────────
// One resident `hermes-acp` (locally, or over SSH when `hermes-host` is set) holds the session, so the chat
// keeps its memory across messages and Coucou restarts (`session/load`). Tool calls, answers and the
// slash commands come back as `hermes-event`; the text of events is never logged.

use std::collections::HashMap;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

struct Acp {
    stdin: Mutex<ChildStdin>,
    _child: Mutex<Child>,
    waits: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
    session: Mutex<String>,
    cwd: String,
}

static ACP: Mutex<Option<Arc<Acp>>> = Mutex::new(None);

fn text_of(v: &Value) -> String {
    let one = |c: &Value| c["content"]["text"].as_str().or(c["text"].as_str()).unwrap_or_default().to_string();
    match v.as_array() {
        Some(a) => a.iter().map(one).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        None => one(v),
    }
}

impl Acp {
    fn write(&self, v: Value) -> Result<(), String> {
        let mut w = self.stdin.lock().unwrap();
        writeln!(w, "{v}").and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    fn call(&self, method: &str, params: Value, secs: u64) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.waits.lock().unwrap().insert(id, tx);
        self.write(serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let r = rx.recv_timeout(Duration::from_secs(secs)).map_err(|_| "Hermes stopped answering.".to_string());
        self.waits.lock().unwrap().remove(&id);
        let r = r?;
        match r.get("error") {
            Some(e) => Err(e["message"].as_str().unwrap_or("Hermes error").to_string()),
            None => Ok(r["result"].clone()),
        }
    }
}

fn emit(app: &AppHandle, v: Value) {
    let _ = app.emit_to(WINDOW_LABEL, "hermes-event", v);
}

fn on_message(app: &AppHandle, acp: &Acp, m: Value) {
    let method = m["method"].as_str();
    if let (Some(method), Some(id)) = (method, m.get("id")) {
        if method == "session/request_permission" {
            let p = &m["params"];
            let options: Vec<Value> = p["options"].as_array().cloned().unwrap_or_default().iter()
                .map(|o| serde_json::json!({ "id": o["optionId"], "name": o["name"], "kind": o["kind"] })).collect();
            emit(app, serde_json::json!({ "t": "perm", "rpc": id, "title": p["toolCall"]["title"], "text": text_of(&p["toolCall"]["content"]), "options": options }));
        } else {
            let _ = acp.write(serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "unsupported" } }));
        }
    } else if let Some(id) = m["id"].as_u64() {
        if let Some(tx) = acp.waits.lock().unwrap().remove(&id) {
            let _ = tx.send(m);
        }
    } else if method == Some("session/update") {
        let u = &m["params"]["update"];
        let ev = match u["sessionUpdate"].as_str() {
            Some("user_message_chunk") => serde_json::json!({ "t": "user", "mid": u["messageId"], "text": u["content"]["text"] }),
            Some("agent_message_chunk") => serde_json::json!({ "t": "agent", "mid": u["messageId"], "text": u["content"]["text"] }),
            Some("tool_call") => serde_json::json!({ "t": "tool", "id": u["toolCallId"], "title": u["title"], "kind": u["kind"], "text": text_of(&u["content"]) }),
            Some("tool_call_update") => serde_json::json!({ "t": "tool_update", "id": u["toolCallId"], "status": u["status"], "text": text_of(&u["content"]) }),
            Some("available_commands_update") => serde_json::json!({ "t": "commands", "list": u["availableCommands"] }),
            _ => return,
        };
        emit(app, ev);
    }
}

fn start(app: &AppHandle) -> Result<Arc<Acp>, String> {
    let host = crate::secrets::get("hermes-host").map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
    let home = std::env::var("HOME").unwrap_or_default();
    let (mut cmd, cwd);
    if let Some(host) = &host {
        if host.starts_with('-') {
            return Err("Invalid Hermes host.".into());
        }
        cmd = Command::new("ssh");
        cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "--", "exec \"$HOME/.local/bin/hermes-acp\""]);
        // ACP wants an absolute folder: the remote's Obsidian vault, else its home.
        let o = Command::new("ssh").args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "--", "d=\"$HOME/Documents/Obsidian Vault\"; [ -d \"$d\" ] && echo \"$d\" || echo \"$HOME\""]).output().map_err(|_| "ssh not found.".to_string())?;
        cwd = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if cwd.is_empty() {
            return Err("Cannot reach the Hermes host.".into());
        }
    } else {
        let exe = std::path::PathBuf::from(&home).join(".local/bin/hermes-acp");
        cmd = Command::new(if exe.exists() { exe } else { "hermes-acp".into() });
        cwd = crate::integrations::obsidian_vault().filter(|p| p.is_dir()).map(|p| p.to_string_lossy().into_owned()).unwrap_or(home);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|_| "Hermes (or ssh) not found.".to_string())?;
    let stdin = child.stdin.take().ok_or("stdin")?;
    let out = child.stdout.take().ok_or("stdout")?;
    let acp = Arc::new(Acp { stdin: Mutex::new(stdin), _child: Mutex::new(child), waits: Mutex::new(HashMap::new()), next: AtomicU64::new(1), session: Mutex::new(String::new()), cwd });
    let (a, handle) = (acp.clone(), app.clone());
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if let Ok(m) = serde_json::from_str::<Value>(&line) {
                on_message(&handle, &a, m);
            }
        }
        // Process gone: wake every waiter and start fresh next time.
        a.waits.lock().unwrap().clear();
        let mut g = ACP.lock().unwrap();
        if g.as_ref().is_some_and(|x| Arc::ptr_eq(x, &a)) {
            *g = None;
        }
    });
    acp.call("initialize", serde_json::json!({ "protocolVersion": 1, "clientCapabilities": {} }), 30)?;
    Ok(acp)
}

fn acp(app: &AppHandle) -> Result<Arc<Acp>, String> {
    let mut g = ACP.lock().unwrap();
    if let Some(a) = g.as_ref() {
        return Ok(a.clone());
    }
    let a = start(app)?;
    *g = Some(a.clone());
    Ok(a)
}

fn new_session(app: &AppHandle, a: &Acp) -> Result<String, String> {
    let r = a.call("session/new", serde_json::json!({ "cwd": a.cwd, "mcpServers": [] }), 60)?;
    let id = r["sessionId"].as_str().ok_or("no session")?.to_string();
    *a.session.lock().unwrap() = id.clone();
    emit(app, serde_json::json!({ "t": "session", "id": id }));
    Ok(id)
}

/// Opens the saved session (its history arrives as events) or a new one. Returns the session id.
#[tauri::command]
pub async fn hermes_open(app: AppHandle, session: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let a = acp(&app)?;
        if let Some(id) = session.filter(|s| !s.is_empty()) {
            if a.call("session/load", serde_json::json!({ "sessionId": id, "cwd": a.cwd, "mcpServers": [] }), 60).is_ok() {
                *a.session.lock().unwrap() = id.clone();
                return Ok(id);
            }
        }
        new_session(&app, &a)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sends one turn (a message or a `/command`); returns when it ends, with the stop reason.
#[tauri::command]
pub async fn hermes_send(app: AppHandle, text: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let a = acp(&app)?;
        let mut sid = a.session.lock().unwrap().clone();
        if sid.is_empty() {
            sid = new_session(&app, &a)?;
        }
        let r = a.call("session/prompt", serde_json::json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }), 3600)?;
        Ok(r["stopReason"].as_str().unwrap_or("end_turn").to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn hermes_cancel() {
    if let Some(a) = ACP.lock().unwrap().clone() {
        let sid = a.session.lock().unwrap().clone();
        let _ = a.write(serde_json::json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": sid } }));
    }
}

/// Answers a permission request: `option` is an option id, or none to cancel.
#[tauri::command]
pub fn hermes_permission(rpc: Value, option: Option<String>) {
    if let Some(a) = ACP.lock().unwrap().clone() {
        let outcome = match option {
            Some(o) => serde_json::json!({ "outcome": "selected", "optionId": o }),
            None => serde_json::json!({ "outcome": "cancelled" }),
        };
        let _ = a.write(serde_json::json!({ "jsonrpc": "2.0", "id": rpc, "result": { "outcome": outcome } }));
    }
}

/// A fresh conversation.
#[tauri::command]
pub async fn hermes_new(app: AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || { let a = acp(&app)?; new_session(&app, &a) }).await.map_err(|e| e.to_string())?
}
