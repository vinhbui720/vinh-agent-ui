// The web app's notes: the Obsidian vault is a folder, so the phone reads and writes the
// .md files in place. Only the web gateway (phone_link/web.rs) calls this, behind its token.
// Writes carry the mtime the editor last saw (`expect`): a file that changed since is a
// "conflict", and the phone merges and tries again. Deletes go to the vault's .trash.
// ponytail: whole-vault walk per list (a few thousand files: instant); add a cache if it grows.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    path: String,
    mtime: u64,
    size: u64,
}

const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];

fn ext(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn vault() -> Result<PathBuf, String> {
    let v = crate::integrations::obsidian_vault().ok_or("no vault")?;
    v.canonicalize().map_err(|_| "no vault".to_string())
}

/// `rel` inside the vault: no `..`, no hidden folders, and no symlink out of it.
fn safe(rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = vault()?;
    let r = Path::new(rel);
    if rel.is_empty() || r.is_absolute() || r.components().any(|c| !matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.'))) {
        return Err("bad path".into());
    }
    let full = root.join(r);
    // Nearest folder that exists (a new note may sit in a folder not made yet).
    let mut anchor = full.clone();
    while !anchor.exists() {
        anchor = anchor.parent().ok_or("bad path")?.to_path_buf();
    }
    if !anchor.canonicalize().map_err(|_| "bad path".to_string())?.starts_with(&root) {
        return Err("bad path".into());
    }
    Ok((root, full))
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<Entry>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with('.') || out.len() > 20_000 {
            continue;
        }
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk(&p, root, out);
        } else if ext(&p) == "md" || IMAGES.contains(&ext(&p).as_str()) {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(Entry { path: rel.to_string_lossy().replace('\\', "/"), mtime: ms(&meta), size: meta.len() });
            }
        }
    }
}

pub fn list() -> Result<Vec<Entry>, String> {
    let root = vault()?;
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    Ok(out)
}

#[derive(Serialize)]
pub struct Note {
    text: String,
    mtime: u64,
}

pub fn read(path: &str) -> Result<Note, String> {
    let (_, f) = safe(path)?;
    if ext(&f) != "md" {
        return Err("not a note".into());
    }
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    Ok(Note { text, mtime: ms(&std::fs::metadata(&f).map_err(|e| e.to_string())?) })
}

/// `expect` 0: the file must not exist yet. Otherwise it must still have that mtime.
pub fn write(path: &str, text: &str, expect: u64) -> Result<u64, String> {
    let (_, f) = safe(path)?;
    if ext(&f) != "md" {
        return Err("not a note".into());
    }
    let now = std::fs::metadata(&f).ok().map(|m| ms(&m));
    if now.unwrap_or(0) != expect {
        return Err("conflict".into());
    }
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Temp file then rename: a dropped connection never leaves half a note.
    let tmp = f.with_extension("md.coucou-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    Ok(ms(&std::fs::metadata(&f).map_err(|e| e.to_string())?))
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    let (_, a) = safe(from)?;
    let (_, b) = safe(to)?;
    if ext(&a) != "md" || ext(&b) != "md" || b.exists() {
        return Err("cannot rename".into());
    }
    std::fs::rename(a, b).map_err(|e| e.to_string())
}

pub fn delete(path: &str) -> Result<(), String> {
    let (root, f) = safe(path)?;
    if ext(&f) != "md" {
        return Err("not a note".into());
    }
    let trash = root.join(".trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = f.file_name().ok_or("bad path")?.to_string_lossy().to_string();
    let mut to = trash.join(&name);
    if to.exists() {
        to = trash.join(format!("{}-{}", ms(&std::fs::metadata(&f).map_err(|e| e.to_string())?), name));
    }
    std::fs::rename(f, to).map_err(|e| e.to_string())
}

/// An image of the vault: bytes and content type.
pub fn image(path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (_, f) = safe(path)?;
    let mime = match ext(&f).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return Err("not an image".into()),
    };
    Ok((std::fs::read(&f).map_err(|e| e.to_string())?, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_in_the_vault() {
        // `safe` needs a vault; the pure checks below do not.
        for bad in ["", "/etc/passwd", "../x.md", "a/../../x.md", ".obsidian/app.json", "a/.git/x.md"] {
            let r = Path::new(bad);
            let ok = !(bad.is_empty() || r.is_absolute() || r.components().any(|c| !matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.'))));
            assert!(!ok, "{bad}");
        }
    }
}
