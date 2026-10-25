// The voice agent's memory, in the Obsidian vault: Voice/mem/. Through the day the talk is appended to
// YYYY-MM-DD.raw.md; at 23:30 (or at the next start) it is squeezed into YYYY-MM-DD.md by one Claude call and the raw
// file is deleted. Recall is a plain search of those notes: no token spent. Nothing here is ever logged.

use std::path::PathBuf;
use std::time::Duration;

const README: &str = "# Voice memory\n\nWritten by Coucou's voice agent. Hermes and OpenCode may read it.\n\n- `YYYY-MM-DD.md`: the summary of a day (decisions, done, open, preferences). Kept.\n- `YYYY-MM-DD.raw.md`: today's words, appended live, squeezed into the summary at 23:30 and then deleted.\n- Search with: `grep -ril <word> \"<vault>/Voice/mem\"`.\n";

fn dir() -> Result<PathBuf, String> {
    let d = crate::integrations::obsidian_vault().ok_or("no vault")?.join("Voice/mem");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let r = d.join("README.md");
    if !r.exists() {
        let _ = std::fs::write(r, README);
    }
    Ok(d)
}

fn today() -> String {
    let t = crate::platform::local_time();
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// One line of the day's talk. `who`: "Vinh", "Coucou" or "task".
#[tauri::command]
pub fn voice_mem_add(who: String, text: String) -> Result<(), String> {
    use std::io::Write;
    let t = crate::platform::local_time();
    let line = format!("- {:02}:{:02} {}: {}\n", t.hour, t.minute, who.replace('\n', " "), text.replace('\n', " "));
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir()?.join(format!("{}.raw.md", today()))).map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Lines of the memory that hold every word of `query`, newest day first, at most ~1500 characters.
#[tauri::command]
pub fn voice_recall(query: String) -> Result<String, String> {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    if words.is_empty() {
        return Ok(String::new());
    }
    let mut files: Vec<_> = std::fs::read_dir(dir()?).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect();
    files.sort();
    files.reverse();
    let mut out = String::new();
    for p in files {
        let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if name == "README.md" {
            continue;
        }
        for l in std::fs::read_to_string(&p).unwrap_or_default().lines() {
            let low = l.to_lowercase();
            if words.iter().all(|w| low.contains(w)) {
                out.push_str(&format!("[{name}] {l}\n"));
                if out.len() > 1500 {
                    return Ok(out.chars().take(1500).collect());
                }
            }
        }
    }
    Ok(out)
}

/// The last summaries, for the start of a call (~1500 characters).
pub fn recent() -> String {
    let Ok(d) = dir() else { return String::new() };
    let mut files: Vec<_> = std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md") && !p.to_string_lossy().ends_with(".raw.md") && !p.ends_with("README.md")).collect();
    files.sort();
    let mut out = String::new();
    for p in files.iter().rev().take(3) {
        out = format!("{}\n{}", std::fs::read_to_string(p).unwrap_or_default().trim(), out);
    }
    out.chars().take(1500).collect()
}

const SYSTEM: &str = "You squeeze one day of talk between Vinh and his voice assistant into a short note, in the language Vinh spoke. Sections, only when non-empty: ## Decisions, ## Done, ## Open, ## Preferences and facts about Vinh. Bullets, one line each, no names of secrets or keys. Under 250 words. Output the note only.";

/// Squeezes every finished day (and today after 23:30) into its summary, then deletes the raw file.
pub async fn compact(all_today: bool) {
    let Ok(d) = dir() else { return };
    let today = today();
    let Ok(rd) = std::fs::read_dir(&d) else { return };
    for p in rd.flatten().map(|e| e.path()) {
        let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let Some(day) = name.strip_suffix(".raw.md") else { continue };
        if day == today && !all_today {
            continue;
        }
        let raw = std::fs::read_to_string(&p).unwrap_or_default();
        if raw.trim().is_empty() {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        let user: String = raw.chars().take(40_000).collect();
        match crate::claude::complete(&std::env::var("COUCOU_MEM_MODEL").unwrap_or_else(|_| crate::flow::cleanup::MODEL.into()), SYSTEM, &user, 700, Duration::from_secs(60)).await {
            Ok(note) => {
                let out = d.join(format!("{day}.md"));
                let old = std::fs::read_to_string(&out).unwrap_or_default();
                if std::fs::write(&out, format!("{old}# {day}\n\n{}\n", note.trim())).is_ok() {
                    let _ = std::fs::remove_file(&p);
                    crate::log::line(format!("voice memory: {day} squeezed"));
                }
            }
            Err(e) => crate::log::line(format!("voice memory: {day} kept raw ({e})")),
        }
    }
}

/// At start, and every day at 23:30.
pub fn setup() {
    tauri::async_runtime::spawn(async {
        compact(false).await;
        let mut done = String::new();
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let t = crate::platform::local_time();
            if (t.hour, t.minute) >= (23, 30) && done != today() {
                compact(true).await;
                done = today();
            }
        }
    });
}
