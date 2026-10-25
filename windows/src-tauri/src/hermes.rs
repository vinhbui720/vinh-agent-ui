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
