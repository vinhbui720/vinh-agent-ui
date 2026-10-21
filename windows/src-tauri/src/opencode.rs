// Direct client for OpenCode v2's local HTTP API (experimental). No plugin: the
// service file OpenCode writes says where it listens and the password. It is
// read on every call, because the port changes at each OpenCode start.
// Session content (reasoning, tool output) is never logged.

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub directory: String,
    pub running: bool,
}

#[derive(Serialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resources: Vec<String>,
}

struct Service {
    url: String,
    password: String,
}

fn service() -> Result<Service, String> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::platform::home_dir().join(".local/state"));
    let text = std::fs::read_to_string(state.join("opencode/service.json"))
        .map_err(|_| "OpenCode is not running".to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "OpenCode service file is unreadable".to_string())?;
    let url = v["url"].as_str().unwrap_or_default().trim_end_matches('/').to_string();
    // The password only ever goes to this machine.
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") || url.starts_with("http://[::1]:")) {
        return Err("OpenCode service is not local".into());
    }
    Ok(Service { url, password: v["password"].as_str().unwrap_or_default().to_string() })
}

async fn call(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let s = service()?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let mut req = http.request(method, format!("{}{path}", s.url)).basic_auth("opencode", Some(&s.password));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|_| "OpenCode does not answer".to_string())?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("OpenCode answered {status}"));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// The sessions running now, most recently updated first.
pub async fn sessions() -> Result<Vec<Session>, String> {
    let active = call(reqwest::Method::GET, "/api/session/active", None).await?;
    let empty = serde_json::Map::new();
    let active = active["data"].as_object().unwrap_or(&empty);
    let all = call(reqwest::Method::GET, "/api/session", None).await?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut out: Vec<(u64, Session)> = vec![];
    for s in all["data"].as_array().into_iter().flatten() {
        let id = s["id"].as_str().unwrap_or_default();
        let updated = s["time"]["updated"].as_u64().unwrap_or(0);
        // Running, or recently touched and waiting for an answer.
        if !active.contains_key(id) && !(now.saturating_sub(updated) < 900_000 && waiting(id).await) {
            continue;
        }
        out.push((
            s["time"]["updated"].as_u64().unwrap_or(0),
            Session {
                id: id.to_string(),
                title: s["title"].as_str().unwrap_or("").to_string(),
                directory: s["location"]["directory"].as_str().unwrap_or("").to_string(),
                running: active.get(id).is_some_and(|a| a["type"] == "running"),
            },
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, s)| s).collect())
}

async fn waiting(session: &str) -> bool {
    call(reqwest::Method::GET, &format!("/api/session/{session}/permission"), None)
        .await
        .map(|v| v["data"].as_array().is_some_and(|a| !a.is_empty()))
        .unwrap_or(false)
}

/// The last messages of a session as plain text, oldest first: what the user
/// said and what the assistant answered. Reasoning and tool output are left out.
pub async fn messages(session: &str) -> Result<Vec<Message>, String> {
    check_id(session)?;
    let v = call(reqwest::Method::GET, &format!("/api/session/{session}/message?limit=60&order=desc"), None).await?;
    let mut out = vec![];
    for m in v["data"].as_array().into_iter().flatten() {
        let (role, text) = match m["type"].as_str() {
            Some("user") => ("user", m["text"].as_str().unwrap_or("").to_string()),
            Some("assistant") => (
                "assistant",
                m["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        out.push(Message { id: m["id"].as_str().unwrap_or("").to_string(), role: role.into(), text });
    }
    out.reverse();
    Ok(out)
}

/// A new, empty session in `directory`.
pub async fn create(directory: &str) -> Result<String, String> {
    let home = crate::platform::home_dir().to_string_lossy().to_string();
    let directory = if directory.is_empty() { home.as_str() } else { directory };
    if !std::path::Path::new(directory).is_absolute() || !std::path::Path::new(directory).is_dir() {
        return Err("Not a folder".into());
    }
    let v = call(reqwest::Method::POST, "/api/session", Some(json!({ "location": { "directory": directory } }))).await?;
    v["data"]["id"].as_str().map(String::from).ok_or_else(|| "OpenCode gave no session".to_string())
}

/// The sessions of one folder, newest first, running or not: what can be resumed.
pub async fn history(directory: &str) -> Result<Vec<Session>, String> {
    let active = call(reqwest::Method::GET, "/api/session/active", None).await?;
    let all = call(reqwest::Method::GET, "/api/session", None).await?;
    let mut out: Vec<(u64, Session)> = vec![];
    for s in all["data"].as_array().into_iter().flatten() {
        if s["location"]["directory"].as_str() != Some(directory) {
            continue;
        }
        let id = s["id"].as_str().unwrap_or_default();
        out.push((
            s["time"]["updated"].as_u64().unwrap_or(0),
            Session {
                id: id.to_string(),
                title: s["title"].as_str().unwrap_or("").to_string(),
                directory: directory.to_string(),
                running: active["data"][id]["type"] == "running",
            },
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().take(15).map(|(_, s)| s).collect())
}

/// `queue` waits for the current turn to end; `steer` redirects it now.
pub async fn prompt(session: &str, text: &str, delivery: &str) -> Result<(), String> {
    check_id(session)?;
    let delivery = if delivery == "steer" { "steer" } else { "queue" };
    call(reqwest::Method::POST, &format!("/api/session/{session}/prompt"), Some(json!({ "text": text, "delivery": delivery }))).await?;
    Ok(())
}

pub async fn interrupt(session: &str) -> Result<(), String> {
    check_id(session)?;
    call(reqwest::Method::POST, &format!("/api/session/{session}/interrupt"), Some(json!({}))).await?;
    Ok(())
}

/// Permission requests waiting for an answer, in every running session. The
/// global list only covers the server's own folder, so each session is asked.
pub async fn permissions() -> Result<Vec<Permission>, String> {
    let mut out = vec![];
    for s in sessions().await? {
        let Ok(v) = call(reqwest::Method::GET, &format!("/api/session/{}/permission", s.id), None).await else { continue };
        for p in v["data"].as_array().into_iter().flatten() {
            out.push(Permission {
                id: p["id"].as_str().unwrap_or("").to_string(),
                session_id: s.id.clone(),
                action: p["action"].as_str().unwrap_or("").to_string(),
                resources: p["resources"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(String::from)).collect(),
            });
        }
    }
    Ok(out)
}

pub async fn reply(session: &str, request: &str, decision: &str) -> Result<(), String> {
    check_id(session)?;
    check_id(request)?;
    if !matches!(decision, "once" | "always" | "reject") {
        return Err("bad decision".into());
    }
    call(reqwest::Method::POST, &format!("/api/session/{session}/permission/{request}/reply"), Some(json!({ "decision": decision }))).await?;
    Ok(())
}

/// IDs go into URL paths: letters, digits, `_` and `-` only.
fn check_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() < 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(())
    } else {
        Err("bad id".into())
    }
}

#[cfg(test)]
mod tests {
    use super::check_id;

    #[test]
    fn ids_cannot_escape_the_url_path() {
        assert!(check_id("ses_ea2d570a1ffer60gbBcdZreHXe").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a b"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }
}
