// Obsidian pill's calendar + to-do: the vault is a folder of .md files, so tasks
// (`- [ ] text`, `📅 YYYY-MM-DD` as the Tasks plugin writes it) are read and edited
// in place. No plugin, key or network. Daily notes are files named YYYY-MM-DD.md.
// ponytail: whole-vault scan per call (a few hundred notes: instant); cache if it grows.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Default)]
pub struct Task {
    file: String,
    line: usize,
    text: String,
    done: bool,
    /// Due date, else the date of the daily note it is written in.
    day: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Overview {
    vault: String,
    tasks: Vec<Task>,
    /// Dates that have a daily note.
    notes: Vec<String>,
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// `- [ ] text` / `* [x] text` → (done, text).
fn task_of(line: &str) -> Option<(bool, &str)> {
    let t = line.trim_start();
    let t = t.strip_prefix("- [").or_else(|| t.strip_prefix("* ["))?;
    let mut c = t.chars();
    let mark = c.next()?;
    if c.next()? != ']' {
        return None;
    }
    let rest = c.as_str().strip_prefix(' ')?.trim();
    let done = match mark {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };
    (!rest.is_empty()).then_some((done, rest))
}

fn due_of(text: &str) -> Option<String> {
    let after = text.split_once('📅')?.1.trim_start();
    let d: String = after.chars().take(10).collect();
    is_date(&d).then_some(d)
}

fn scan(dir: &Path, root: &Path, out: &mut Overview, dailies: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = e.path();
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            scan(&path, root, out, dailies);
            continue;
        }
        if path.extension().is_none_or(|x| x != "md") || e.metadata().is_ok_and(|m| m.len() > 2_000_000) {
            continue;
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let file_day = is_date(&stem).then(|| stem.clone());
        if let Some(d) = &file_day {
            out.notes.push(d.clone());
            dailies.push(path.clone());
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        for (i, line) in content.lines().enumerate() {
            if let Some((done, text)) = task_of(line) {
                out.tasks.push(Task {
                    file: rel.clone(),
                    line: i,
                    text: text.to_string(),
                    done,
                    day: due_of(text).or_else(|| file_day.clone()),
                });
            }
        }
    }
}

fn vault() -> Result<PathBuf, String> {
    let v = crate::integrations::obsidian_vault().ok_or("no vault")?;
    v.canonicalize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn obsidian_overview() -> Result<Overview, String> {
    tokio::task::spawn_blocking(|| {
        let root = vault()?;
        let mut out = Overview {
            vault: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ..Default::default()
        };
        scan(&root, &root, &mut out, &mut Vec::new());
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ticks or unticks one task. `text` must still be on that line: if the note
/// moved under us, nothing is written.
#[tauri::command]
pub async fn obsidian_toggle(file: String, line: usize, text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = vault()?;
        let path = root.join(&file).canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(&root) || path.extension().is_none_or(|x| x != "md") {
            return Err("not a note in the vault".into());
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
        let l = lines.get_mut(line).ok_or("note changed")?;
        let (done, now) = task_of(l).ok_or("note changed")?;
        if now != text.trim() {
            return Err("note changed".into());
        }
        let at = l.find('[').ok_or("note changed")? + 1;
        l.replace_range(at..at + 1, if done { " " } else { "x" });
        std::fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Appends `- [ ] text` to the daily note of `day`, creating it next to the others.
#[tauri::command]
pub async fn obsidian_add(text: String, day: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if !is_date(&day) {
            return Err("bad date".into());
        }
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            return Ok(());
        }
        let root = vault()?;
        let (mut tmp, mut dailies) = (Overview::default(), Vec::new());
        scan(&root, &root, &mut tmp, &mut dailies);
        let dir = dailies.first().and_then(|p| p.parent()).unwrap_or(&root).to_path_buf();
        let path = dir.join(format!("{day}.md"));
        let mut content = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| format!("---\ntags: [daily-note]\ndate: {day}\n---\n\n# {day}\n\n## Task\n"));
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&format!("- [ ] {text}\n"));
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tasks_and_due_dates() {
        assert_eq!(task_of("  - [ ] #task call mum 📅 2026-06-14"), Some((false, "#task call mum 📅 2026-06-14")));
        assert_eq!(task_of("- [x] done"), Some((true, "done")));
        assert_eq!(task_of("- [-] cancelled"), None);
        assert_eq!(task_of("- [ ] "), None);
        assert_eq!(task_of("plain text"), None);
        assert_eq!(due_of("a 📅 2026-06-14 b").as_deref(), Some("2026-06-14"));
        assert_eq!(due_of("a 📅 soon"), None);
        assert!(is_date("2026-10-22") && !is_date("2026-1-22"));
    }
}
