// « OK Coucou » on Windows and Linux: say it, then ask anything. Port of the
// Mac's Voice/ (VoiceEngine.swift and its friends).
//
// While it is on, the microphone is open and a cheap energy detector cuts what
// you say into stretches; only a stretch of speech goes to Parakeet, on this
// computer, and only a stretch that starts with « OK Coucou » goes further:
// what you said after it goes to Claude with your own key (brain.rs), never
// the audio. Mochi shows it all in the pill at the bottom of the screen —
// listening, thinking, then the answer, said out loud by the system's voice
// (the pill's speechSynthesis) or ElevenLabs with your key.
//
// It stops listening while you dictate, while a call is recorded and while it
// speaks itself.

pub mod brain;
pub mod mem;
pub mod wake;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::flow::pill;
use crate::speech::{self, audio};

/// What the pill shows of a conversation.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    /// "listening", "thinking", "speaking".
    pub phase: String,
    /// What you said (after « OK Coucou »).
    pub heard: String,
    /// Coucou's answer.
    pub answer: String,
}

struct Running {
    stop: Arc<AtomicBool>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// Rust waits on these for the island's answers and the end of speech.
fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<String>>> {
    static P: OnceLock<Mutex<HashMap<u64, mpsc::Sender<String>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Whether « OK Coucou » can run: the voice model and a Claude key.
pub fn requirements_met() -> bool {
    speech::is_ready() && crate::secrets::present(crate::claude::KEY)
}

/// Starts or stops listening to follow the preference.
pub fn sync(app: &AppHandle) {
    let wanted = crate::flow::get(app).is_some_and(|f| f.store.lock().unwrap().prefs.voice);
    let mut running = RUNNING.lock().unwrap();
    match (wanted && requirements_met(), running.is_some()) {
        (true, false) => {
            let stop = Arc::new(AtomicBool::new(false));
            let app2 = app.clone();
            let stop2 = stop.clone();
            std::thread::Builder::new().name("coucou-voice".into()).spawn(move || run(app2, stop2)).ok();
            *running = Some(Running { stop });
            speech::preload();
            crate::log::line("voice: « OK Coucou » listening");
        }
        (false, true) => {
            if let Some(r) = running.take() {
                r.stop.store(true, Ordering::Relaxed);
            }
            let dictation = crate::flow::get(app).is_some_and(|f| f.store.lock().unwrap().prefs.enabled);
            if !dictation && !crate::notes::is_recording(app) {
                speech::unload();
            }
            crate::log::line("voice: « OK Coucou » off");
        }
        _ => {}
    }
}

/// « OK Coucou » is listening (the voice model stays loaded).
pub fn is_listening() -> bool {
    RUNNING.lock().unwrap().is_some()
}

/// Starts again on another microphone.
pub fn restart(app: &AppHandle) {
    if let Some(r) = RUNNING.lock().unwrap().take() {
        r.stop.store(true, Ordering::Relaxed);
    }
    sync(app);
}

fn show(app: &AppHandle, view: Option<VoiceView>) {
    pill::update(app, |s| s.voice = view);
}

enum Mode {
    /// Waiting for « OK Coucou ».
    Wake,
    /// Heard « OK Coucou » alone: what comes next is the question.
    Command { text: String, until: Instant },
    /// Coucou asked something back: an answer comes without « OK Coucou ».
    FollowUp { until: Instant },
}

fn run(app: AppHandle, stop: Arc<AtomicBool>) {
    let mic = crate::flow::get(&app).map(|f| f.store.lock().unwrap().prefs.mic.clone()).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let capture = audio::Capture::start(audio::Source::Mic(if mic.is_empty() { None } else { Some(mic) }), move |s| {
        let _ = tx.send(s.to_vec());
    });
    let mut capture = match capture {
        Ok(c) => c,
        Err(err) => {
            crate::log::line(format!("voice: microphone: {err}"));
            *RUNNING.lock().unwrap() = None;
            return;
        }
    };
    let mut vad = wake::Vad::default();
    let mut mode = Mode::Wake;
    let mut brain = brain::Brain::default();
    let mut hide_at: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        let chunk = match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(c) => Some(c),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let now = Instant::now();
        // The pill's last answer goes away after a while.
        if hide_at.is_some_and(|t| now > t) {
            hide_at = None;
            show(&app, None);
        }
        match &mode {
            Mode::Command { until, .. } | Mode::FollowUp { until } if now > *until => {
                mode = Mode::Wake;
                vad.hangover = 25;
                show(&app, None);
            }
            _ => {}
        }
        // Dictation and calls have the microphone: Coucou doesn't listen meanwhile.
        if pill::dictating(&app) || crate::notes::is_recording(&app) {
            vad.reset();
            continue;
        }
        let Some(chunk) = chunk else { continue };
        for segment in vad.feed(&chunk) {
            if segment.len() < speech::SAMPLE_RATE as usize * 35 / 100 {
                continue;
            }
            let Some(heard) = speech::transcribe(&segment).map(|t| t.text.trim().to_string()) else { continue };
            if heard.is_empty() {
                continue;
            }
            let question = match &mut mode {
                Mode::Wake => match wake::after_wake(&heard) {
                    Some(rest) => {
                        crate::log::line("voice: « OK Coucou » heard");
                        hide_at = None;
                        if crate::flow::text::word_count(&rest) >= 2 {
                            Some(rest)
                        } else {
                            show(&app, Some(VoiceView { phase: "listening".into(), heard: rest.clone(), answer: String::new() }));
                            mode = Mode::Command { text: rest, until: now + Duration::from_secs(7) };
                            // A question may come with pauses in it.
                            vad.hangover = 40;
                            None
                        }
                    }
                    None => None,
                },
                Mode::Command { text, .. } => {
                    let full = format!("{text} {heard}").trim().to_string();
                    Some(full)
                }
                Mode::FollowUp { .. } => Some(heard),
            };
            let Some(question) = question else { continue };
            mode = Mode::Wake;
            vad.hangover = 25;
            show(&app, Some(VoiceView { phase: "thinking".into(), heard: question.clone(), answer: String::new() }));
            let reply = brain.respond(&app, &question);
            let answer = reply.as_ref().map(|r| r.text.clone()).unwrap_or_default();
            if answer.is_empty() {
                let done = reply.is_some_and(|r| r.acted);
                show(&app, Some(VoiceView {
                    phase: "speaking".into(),
                    heard: question,
                    answer: if done { "✓".into() } else { crate::i18n::t("Coucou couldn't answer: check your Claude key in Notch → Chat.") },
                }));
                hide_at = Some(Instant::now() + Duration::from_secs(5));
                continue;
            }
            show(&app, Some(VoiceView { phase: "speaking".into(), heard: question.clone(), answer: answer.clone() }));
            speak(&app, &answer);
            vad.reset();
            // Drop what the microphone heard of Coucou's own voice.
            while rx.try_recv().is_ok() {}
            if answer.trim_end().ends_with('?') {
                mode = Mode::FollowUp { until: Instant::now() + Duration::from_secs(8) };
                vad.hangover = 40;
                show(&app, Some(VoiceView { phase: "listening".into(), heard: String::new(), answer }));
            } else {
                hide_at = Some(Instant::now() + Duration::from_secs(6));
            }
        }
    }
    capture.stop();
    show(&app, None);
}

// ── Speaking ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Say {
    id: u64,
    text: String,
    lang: Option<&'static str>,
    /// ElevenLabs' MP3, base64.
    audio: Option<String>,
    gender: String,
}

/// Says `text` and returns once it is said (or after a sensible time).
fn speak(app: &AppHandle, text: &str) {
    let (output, gender) = crate::flow::get(app)
        .map(|f| {
            let p = &f.store.lock().unwrap().prefs;
            (p.voice_output.clone(), p.voice_gender.clone())
        })
        .unwrap_or_else(|| ("system".into(), "female".into()));
    if output == "off" {
        std::thread::sleep(Duration::from_millis(1500));
        return;
    }
    let audio = if output == "elevenlabs" { elevenlabs(text, &gender, None).map(|mp3| base64(&mp3)) } else { None };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(id, tx);
    let _ = app.emit_to(pill::LABEL, "voice-say", Say { id, text: text.into(), lang: wake::speech_lang(text), audio, gender });
    let words = crate::flow::text::word_count(text) as u64;
    let _ = rx.recv_timeout(Duration::from_millis(4000 + words * 600));
    pending().lock().unwrap().remove(&id);
}

/// The pill says it has finished speaking (`id`), or the island answers a question.
#[tauri::command]
pub fn voice_done(id: u64, text: Option<String>) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(text.unwrap_or_default());
    }
}

/// Where the webview has no voice (WebKitGTK often): speech-dispatcher or
/// espeak-ng, when installed.
#[tauri::command]
pub async fn voice_say_native(text: String, lang: Option<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            let lang = lang.unwrap_or_default();
            let short = lang.split('-').next().unwrap_or("").to_string();
            if let Some(spd) = crate::platform::find_on_path("spd-say") {
                let mut cmd = std::process::Command::new(spd);
                cmd.arg("-w");
                if !short.is_empty() {
                    cmd.args(["-l", &short]);
                }
                return cmd.arg(&text).status().is_ok_and(|s| s.success());
            }
            if let Some(espeak) = crate::platform::find_on_path("espeak-ng") {
                let mut cmd = std::process::Command::new(espeak);
                if !short.is_empty() {
                    cmd.args(["-v", &short]);
                }
                return cmd.arg(&text).status().is_ok_and(|s| s.success());
            }
            false
        }
        #[cfg(windows)]
        {
            let _ = (text, lang);
            false
        }
    })
    .await
    .unwrap_or(false)
}

/// The keyring's key first, else `ELEVENLABS_API_KEY` from the environment (read only, never stored or logged).
fn eleven_key() -> Option<String> {
    crate::secrets::get("elevenlabs-api-key")
        .or_else(|| std::env::var("ELEVENLABS_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()))
}

/// "vi" for Vietnamese, "en" for English, None for anything else (not read aloud).
/// Letters only Vietnamese has (ạ, ỗ, đ…) decide it. A sentence with only the accents Vietnamese shares with
/// French or Spanish (ô, ó, ì…) follows the sentence read just before, so "Không có gì." stays Vietnamese.
pub fn tts_lang(text: &str) -> Option<&'static str> {
    use std::sync::atomic::{AtomicI64, Ordering::Relaxed};
    static LAST_VI: AtomicI64 = AtomicI64::new(0); // unix seconds of the last Vietnamese sentence
    const VI: &str = "ăđơưạảãấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ";
    const SHARED: &str = "àáâãèéêìíòóôõùúýỳ";
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (mut letters, mut other, mut shared) = (0usize, 0usize, false);
    for c in text.chars().filter(|c| c.is_alphabetic()) {
        letters += 1;
        let l = c.to_lowercase().next().unwrap_or(c);
        if VI.contains(l) {
            LAST_VI.store(now, Relaxed);
            return Some("vi");
        }
        shared |= SHARED.contains(l);
        if !c.is_ascii() {
            other += 1;
        }
    }
    if shared && now - LAST_VI.load(Relaxed) < 120 {
        LAST_VI.store(now, Relaxed);
        return Some("vi");
    }
    // Plain Latin text is English; a few accents (café) stay English, other scripts are skipped.
    (letters > 0 && other * 10 <= letters).then_some("en")
}

static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
static VOICES: std::sync::OnceLock<Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();

/// An OpenCode sentence, spoken: ElevenLabs' MP3 (base64) in the voice chosen in Voice settings.
/// None: not Vietnamese or English, no key, or ElevenLabs failed (nothing is read then).
#[tauri::command]
pub async fn opencode_tts(app: AppHandle, text: String) -> Option<String> {
    let lang = tts_lang(&text)?;
    let gender = crate::flow::get(&app).map(|f| f.store.lock().unwrap().prefs.voice_gender.clone()).unwrap_or_else(|| "female".into());
    let text: String = text.chars().take(1500).collect();
    tauri::async_runtime::spawn_blocking(move || {
        local_tts(&text, lang).or_else(|| elevenlabs(&text, &gender, Some(lang))).map(|a| base64(&a))
    }).await.ok().flatten()
}

// ── Streamed speech: raw 24 kHz PCM, pulled by the island ────────────────────
// The island asks for the next chunk only while it has less than a few seconds queued, so the GPU of
// the voice machine works in short bursts (Supertonic makes audio ~100x faster than it plays) and stops in between.

struct PcmStream { resp: reqwest::Response, carry: Option<u8> }
static STREAMS: OnceLock<Mutex<HashMap<String, PcmStream>>> = OnceLock::new();
static STREAM_ID: AtomicU64 = AtomicU64::new(1);
/// Streams closed while a pull had them out of the map: the pull drops them when it is back.
static CLOSED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn closed() -> &'static Mutex<std::collections::HashSet<String>> { CLOSED.get_or_init(|| Mutex::new(Default::default())) }
fn streams() -> &'static Mutex<HashMap<String, PcmStream>> { STREAMS.get_or_init(|| Mutex::new(HashMap::new())) }

/// Starts a stream: its id, or None (not Vietnamese/English, no local server, server busy).
#[tauri::command]
pub async fn tts_open(text: String) -> Option<String> {
    let lang = tts_lang(&text)?;
    let url = voice_url("COUCOU_TTS_URL", "http://127.0.0.1:18445")?;
    let model = std::env::var("COUCOU_TTS_MODEL").unwrap_or_else(|_| "supertonic-3".into());
    let voice = std::env::var("COUCOU_TTS_VOICE").unwrap_or_else(|_| "F1".into());
    let text: String = text.chars().take(1500).collect();
    let client = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client")).clone();
    let resp = client
        .post(format!("{url}/v1/audio/speech"))
        .timeout(Duration::from_secs(300))
        .json(&json!({ "model": model, "voice": voice, "input": text, "lang": lang, "response_format": "pcm", "sample_rate": 24000, "stream_format": "audio" }))
        .send().await.ok()?;
    resp.status().is_success().then_some(())?;
    let id = STREAM_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let mut map = streams().lock().unwrap();
    if map.len() > 8 { map.clear(); } // a stream nobody closed: never let them pile up on the server
    map.insert(id.clone(), PcmStream { resp, carry: None });
    Some(id)
}

/// The next chunk (base64, 16-bit little-endian mono, 24 kHz), or None at the end.
#[tauri::command]
pub async fn tts_pull(id: String) -> Option<String> {
    let mut st = streams().lock().unwrap().remove(&id)?;
    loop {
        match st.resp.chunk().await {
            Ok(Some(b)) => {
                let mut bytes = Vec::with_capacity(b.len() + 1);
                bytes.extend(st.carry.take());
                bytes.extend_from_slice(&b);
                if bytes.len() % 2 == 1 { st.carry = bytes.pop(); }
                if bytes.is_empty() { continue; }
                if closed().lock().unwrap().remove(&id) { return None; } // muted meanwhile: drop it, the server stops
                streams().lock().unwrap().insert(id, st);
                return Some(base64(&bytes));
            }
            _ => return None, // end or error: the stream is dropped, the server stops
        }
    }
}

/// Stop reading a stream (the user muted): the server stops generating.
#[tauri::command]
pub fn tts_close(id: String) {
    if streams().lock().unwrap().remove(&id).is_none() {
        let mut c = closed().lock().unwrap();
        if c.len() > 64 { c.clear(); }
        c.insert(id);
    }
}

// ── Local voice server (voice-server/AGENT-TASK.md): OpenAI-style STT and TTS ─
// URLs from env COUCOU_TTS_URL / COUCOU_STT_URL; the defaults are the SSH tunnel to the server
// (coucou-voice-tunnel.service). Set one to "" to turn local voice off.
fn voice_url(var: &str, default: &str) -> Option<String> {
    let u = std::env::var(var).unwrap_or_else(|_| default.into());
    (!u.is_empty()).then_some(u)
}

/// WAV bytes from the local TTS server (short timeout: ElevenLabs takes over when it is down).
fn local_tts(text: &str, lang: &str) -> Option<Vec<u8>> {
    let url = voice_url("COUCOU_TTS_URL", "http://127.0.0.1:18445")?;
    let model = std::env::var("COUCOU_TTS_MODEL").unwrap_or_else(|_| "supertonic-3".into());
    let voice = std::env::var("COUCOU_TTS_VOICE").unwrap_or_else(|_| "F1".into());
    let client = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client")).clone();
    tauri::async_runtime::block_on(async {
        let r = client
            .post(format!("{url}/v1/audio/speech"))
            .timeout(Duration::from_secs(60))
            .json(&json!({ "model": model, "voice": voice, "input": text, "lang": lang, "response_format": "wav" }))
            .send()
            .await
            .ok()?;
        r.status().is_success().then_some(())?;
        let b = r.bytes().await.ok()?.to_vec();
        b.starts_with(b"RIFF").then_some(b)
    })
}

/// Dictation: base64 audio (any format ffmpeg-free: webm/wav/mp4) -> text, via the local STT server.
/// `lang` "vi"/"en", or None to let Whisper detect.
#[tauri::command]
pub async fn local_stt(audio: String, mime: Option<String>, lang: Option<String>) -> Result<String, String> {
    let url = voice_url("COUCOU_STT_URL", "http://127.0.0.1:18444").ok_or("local STT is off")?;
    let model = std::env::var("COUCOU_STT_MODEL").unwrap_or_else(|_| "Systran/faster-whisper-large-v3".into());
    let bytes = unbase64(&audio).ok_or("bad audio")?;
    if bytes.len() > 20 * 1024 * 1024 { return Err("audio too long".into()); }
    let mime = mime.unwrap_or_else(|| "audio/webm".into());
    let ext = if mime.contains("mp4") { "mp4" } else if mime.contains("wav") { "wav" } else if mime.contains("ogg") { "ogg" } else { "webm" };
    let client = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client")).clone();
    let part = reqwest::multipart::Part::bytes(bytes).file_name(format!("a.{ext}")).mime_str(&mime).map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new().part("file", part).text("model", model);
    if let Some(l) = lang.filter(|l| l == "vi" || l == "en") { form = form.text("language", l); }
    let r = client.post(format!("{url}/v1/audio/transcriptions")).timeout(Duration::from_secs(60)).multipart(form).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Err(format!("STT {}", r.status())); }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

fn unbase64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()) {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => return None } as u32;
        acc = acc << 6 | v; bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); acc &= (1 << bits) - 1; }
    }
    Some(out)
}

/// ElevenLabs' MP3 for `text`, with the user's key; None and the system voice speaks.
/// `lang` ("vi", "en") pins the language of the multilingual model; the voice id is looked up once.
fn elevenlabs(text: &str, gender: &str, lang: Option<&str>) -> Option<Vec<u8>> {
    let key = eleven_key()?;
    let client = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client")).clone();
    tauri::async_runtime::block_on(async {
        let cached = VOICES.get_or_init(Default::default).lock().unwrap().get(gender).cloned();
        let voice = match cached {
            Some(v) => v,
            None => {
                let voices: Value = client.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.ok()?.json().await.ok()?;
                let v = pick_voice(voices["voices"].as_array()?, gender)?;
                VOICES.get_or_init(Default::default).lock().unwrap().insert(gender.to_string(), v.clone());
                v
            }
        };
        let mut body = json!({ "text": text, "model_id": "eleven_flash_v2_5" });
        if let Some(l) = lang {
            body["language_code"] = json!(l);
        }
        let response = client
            .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_22050_32"))
            .header("xi-api-key", &key)
            .header("accept", "audio/mpeg")
            .json(&body)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            crate::log::line(format!("voice: ElevenLabs {}", response.status()));
            return None;
        }
        Some(response.bytes().await.ok()?.to_vec())
    })
}

/// First English voice of the gender (a young one first for a man); else any
/// voice of the gender; else the first one. Same choice as the Mac.
pub fn pick_voice(voices: &[Value], gender: &str) -> Option<String> {
    let label = |v: &Value, k: &str| v["labels"][k].as_str().unwrap_or("").to_lowercase();
    let english = |v: &Value| {
        let lang = label(v, "language");
        if !lang.is_empty() {
            return lang.starts_with("en");
        }
        let accent = label(v, "accent");
        accent.is_empty() || ["american", "british", "australian", "irish", "english", "us", "uk"].iter().any(|a| accent.contains(a))
    };
    let of_gender: Vec<&Value> = voices.iter().filter(|v| label(v, "gender") == gender).collect();
    let english_ones: Vec<&&Value> = of_gender.iter().filter(|v| english(v)).collect();
    let young = if gender == "male" { english_ones.iter().find(|v| label(v, "age").contains("young")).copied() } else { None };
    let v = young.or_else(|| english_ones.first().copied()).copied().or_else(|| of_gender.first().copied()).or_else(|| voices.first())?;
    v["voice_id"].as_str().map(String::from)
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// ── The tools ─────────────────────────────────────────────────────────────────

/// Asks the island (it knows the pills and the services' data) and waits for its answer.
pub fn ask_island(app: &AppHandle, kind: &str, input: Value) -> Option<String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().unwrap().insert(id, tx);
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "voice-ask", json!({ "id": id, "kind": kind, "input": input }));
    let answer = rx.recv_timeout(Duration::from_secs(5)).ok();
    pending().lock().unwrap().remove(&id);
    answer
}

/// Runs one of Claude's tools: what goes back to Claude, and whether something changed.
pub fn run_tool(app: &AppHandle, name: &str, input: &Value) -> (String, bool) {
    match name {
        "pills" => {
            let answer = ask_island(app, "pills", input.clone()).unwrap_or_else(|| "the island did not answer".into());
            let acted = input["action"].as_str() != Some("list") && !answer.contains("unknown");
            (answer, acted)
        }
        "service_info" => (ask_island(app, "info", json!({})).unwrap_or_else(|| "no data".into()), false),
        "music" => music(app, input),
        "open_app" => open_app(input["name"].as_str().unwrap_or("")),
        "prepare_email" => {
            let to = input["recipient"].as_str().unwrap_or("").trim().to_string();
            if !to.contains('@') {
                return ("No email address: ask the user to spell it.".into(), false);
            }
            let enc = |s: &str| -> String {
                s.bytes()
                    .map(|b| match b {
                        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                        _ => format!("%{b:02X}"),
                    })
                    .collect()
            };
            let url = format!(
                "mailto:{}?subject={}&body={}",
                enc(&to).replace("%40", "@"),
                enc(input["subject"].as_str().unwrap_or("")),
                enc(input["body"].as_str().unwrap_or(""))
            );
            crate::platform::open_url(&url);
            (format!("The mail app opened with the email to {to}. Nothing is sent until the user sends it."), true)
        }
        _ => (format!("unknown tool {name}"), false),
    }
}

fn music(app: &AppHandle, input: &Value) -> (String, bool) {
    let action = input["action"].as_str().unwrap_or("");
    let (control, value) = match action {
        "play_pause" => ("playPause", None),
        "next" => ("next", None),
        "previous" => ("previous", None),
        "set_volume" => ("volume", Some(input["volume"].as_f64().unwrap_or(50.0).clamp(0.0, 100.0))),
        "search" => {
            let q = input["query"].as_str().unwrap_or("").trim();
            if q.is_empty() {
                return ("missing query".into(), false);
            }
            let encoded: String = q.chars().map(|c| if c.is_alphanumeric() { c.to_string() } else { "%20".into() }).collect();
            crate::platform::open_url(&format!("spotify:search:{encoded}"));
            return (format!("Spotify opened on a search for {q}: the user picks what to play."), true);
        }
        _ => return ("unknown action".into(), false),
    };
    let app2 = app.clone();
    let done = tauri::async_runtime::block_on(crate::spotify::spotify_control(app2, control.into(), value));
    if done {
        ("done".into(), true)
    } else {
        ("Spotify is not running or not playing: tell the user to open it.".into(), false)
    }
}

/// Opens an app whose name matches: a Start menu shortcut on Windows, a
/// .desktop entry on Linux. Nothing else is ever run.
fn open_app(name: &str) -> (String, bool) {
    let wanted = wake::normalize(name);
    if wanted.is_empty() {
        return ("no name".into(), false);
    }
    match find_app(&wanted) {
        Some((label, launch)) => {
            launch();
            (format!("{label} opened"), true)
        }
        None => (format!("No app named {name} on this computer."), false),
    }
}

#[cfg(windows)]
fn find_app(wanted: &str) -> Option<(String, Box<dyn FnOnce()>)> {
    let mut roots = Vec::new();
    if let Some(p) = std::env::var_os("APPDATA") {
        roots.push(std::path::PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(p) = std::env::var_os("ProgramData") {
        roots.push(std::path::PathBuf::from(p).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    let mut best: Option<(usize, std::path::PathBuf)> = None;
    let mut stack = roots;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
                let stem = wake::normalize(&path.file_stem().unwrap_or_default().to_string_lossy());
                let score = if stem == wanted { 0 } else if stem.starts_with(wanted) { 1 } else if stem.contains(wanted) { 2 } else { continue };
                if best.as_ref().is_none_or(|(s, p)| score < *s || (score == *s && path.as_os_str().len() < p.as_os_str().len())) {
                    best = Some((score, path));
                }
            }
        }
    }
    let (_, path) = best?;
    let label = path.file_stem()?.to_string_lossy().to_string();
    Some((label, Box::new(move || crate::platform::reveal_folder(&path.to_string_lossy()))))
}

#[cfg(target_os = "linux")]
fn find_app(wanted: &str) -> Option<(String, Box<dyn FnOnce()>)> {
    let mut dirs = vec![std::path::PathBuf::from("/usr/share/applications"), std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications")];
    dirs.push(crate::platform::home_dir().join(".local/share/applications"));
    dirs.push(crate::platform::home_dir().join(".local/share/flatpak/exports/share/applications"));
    let mut best: Option<(usize, String, String)> = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().is_none_or(|x| x != "desktop") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if text.lines().any(|l| l.trim() == "NoDisplay=true") {
                continue;
            }
            let Some(app_name) = text.lines().find_map(|l| l.strip_prefix("Name=")).map(str::trim) else { continue };
            let n = wake::normalize(app_name);
            let score = if n == wanted { 0 } else if n.starts_with(wanted) { 1 } else if n.contains(wanted) { 2 } else { continue };
            let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            if best.as_ref().is_none_or(|(s, _, _)| score < *s) {
                best = Some((score, app_name.to_string(), id));
            }
        }
    }
    let (_, label, id) = best?;
    Some((label, Box::new(move || {
        let _ = std::process::Command::new("gtk-launch").arg(&id).spawn();
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

    #[test]
    fn the_voice_is_picked_like_on_the_mac() {
        let voices: Vec<Value> = serde_json::from_str(r#"[
            {"voice_id":"a","labels":{"gender":"male","accent":"american","age":"middle aged"}},
            {"voice_id":"b","labels":{"gender":"male","accent":"british","age":"young"}},
            {"voice_id":"c","labels":{"gender":"female","accent":"american"}},
            {"voice_id":"d","labels":{"gender":"female","language":"fr"}}
        ]"#).unwrap();
        assert_eq!(pick_voice(&voices, "male").as_deref(), Some("b"));
        assert_eq!(pick_voice(&voices, "female").as_deref(), Some("c"));
        assert_eq!(pick_voice(&[], "female"), None);
    }
}

/// With the models downloaded: `COUCOU_TEST_WAKE_WAV=… cargo test -- --ignored wake_in`.
#[cfg(test)]
mod with_models {
    #[test]
    #[ignore]
    fn hears_the_wake_phrase_in_a_recording() {
        let path = std::env::var("COUCOU_TEST_WAKE_WAV").expect("COUCOU_TEST_WAKE_WAV");
        let bytes = std::fs::read(&path).unwrap();
        let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        let pcm: Vec<f32> = bytes[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let mut r = crate::speech::audio::Resampler::new(rate);
        let mut samples = Vec::new();
        r.process(&pcm, &mut samples);
        let mut vad = super::wake::Vad::default();
        let mut heard = Vec::new();
        for chunk in samples.chunks(1600) {
            for segment in vad.feed(chunk) {
                let text = crate::speech::transcribe(&segment).expect("models").text;
                println!("segment {:.2} s: {text}", segment.len() as f32 / 16_000.0);
                heard.push(super::wake::after_wake(&text));
            }
        }
        println!("{heard:?}");
        assert!(heard.iter().any(|h| h.as_deref().is_some_and(|q| !q.is_empty())));
    }
}

#[cfg(test)]
mod tts_lang_tests {
    use super::tts_lang;
    #[test]
    fn only_vietnamese_and_english() {
        assert_eq!(tts_lang("Done. All tests pass."), Some("en"));
        assert_eq!(tts_lang("Un café, s'il vous plaît, mon ami"), Some("en"));
        assert_eq!(tts_lang("Xin chào, tôi là trợ lý."), Some("vi"));
        assert_eq!(tts_lang("你好,世界"), None);
        assert_eq!(tts_lang("12345"), None);
        // Only shared accents: Vietnamese right after a Vietnamese sentence.
        assert_eq!(tts_lang("Không có gì."), Some("vi"));
    }
}

/// Join token for the LiveKit voice agent (token endpoint on the server, via the SSH tunnel; the API secret stays there).
#[tauri::command]
pub async fn voice_token(who: Option<String>, room: Option<String>, machine: Option<String>) -> Result<String, String> {
    let clean = |s: Option<String>, d: &str| -> String {
        let c: String = s.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
        if c.is_empty() { d.into() } else { c }
    };
    let (who, room) = (clean(who, "coucou"), clean(room, "voice"));
    let machine = if machine.as_deref() == Some("server") { "server" } else { "host" };
    let url = voice_url("COUCOU_LK_TOKEN_URL", "http://127.0.0.1:7890").ok_or("voice call is off")?;
    let client = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client")).clone();
    let r = client.get(format!("{url}/token?room={room}&who={who}&machine={machine}")).timeout(Duration::from_secs(5)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Err(format!("token {}", r.status())); }
    let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    v["token"].as_str().map(String::from).ok_or_else(|| "no token".into())
}

/// The machines the call tab offers: this one, the one that runs the voice server (both can take a call), and the other
/// computers of the tailnet (greyed: nothing to answer there yet). Read from Tailscale, nothing stored.
#[tauri::command]
pub async fn call_machines() -> Vec<Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("tailscale").args(["status", "--json"]).output().ok().filter(|o| o.status.success());
        let st: Value = out.and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null);
        let server = std::env::var("COUCOU_VOICE_HOST").unwrap_or_else(|_| "vinhtp-1".into());
        let me = st["Self"]["HostName"].as_str().map(String::from).or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|h| h.trim().to_string())).unwrap_or_default();
        let mut v = vec![json!({ "id": "host", "name": me, "online": true, "here": true })];
        let uid = st["Self"]["UserID"].clone();
        if let Some(peers) = st["Peer"].as_object() {
            let mut rest: Vec<Value> = Vec::new();
            for p in peers.values() {
                let name = p["HostName"].as_str().unwrap_or("");
                let os = p["OS"].as_str().unwrap_or("").to_lowercase();
                if name.is_empty() || p["UserID"] != uid || !["linux", "windows", "macos"].contains(&os.as_str()) { continue; }
                let online = p["Online"].as_bool().unwrap_or(false);
                if name == server { v.push(json!({ "id": "server", "name": name, "online": online, "here": false })); }
                else { rest.push(json!({ "id": "", "name": name, "online": online, "here": false })); }
            }
            v.extend(rest);
        }
        v
    }).await.unwrap_or_default()
}

// ── Live call: the pill window owns the WebRTC room; every window sends `call-cmd` and paints `call-state`. ──
static CALL_LIVE: AtomicBool = AtomicBool::new(false);

/// Any window: "toggle", "hear", "speak" or "mode".
#[tauri::command]
pub fn call_cmd(app: AppHandle, cmd: String) {
    crate::log::line(format!("call-cmd {cmd}"));
    // WebKitGTK has no WebRTC: the call runs in a hidden Chrome page (call.html) that listens on the web gateway.
    let fresh = ensure_call_page();
    std::thread::spawn(move || {
        if fresh { std::thread::sleep(Duration::from_secs(3)); }
        crate::phone_link::web::push("call-cmd", json!(cmd));
    });
}

static CHROME: Mutex<Option<std::process::Child>> = Mutex::new(None);

/// Starts the hidden Chrome that owns the room, unless it runs. True when it was just started.
fn ensure_call_page() -> bool {
    let mut c = CHROME.lock().unwrap();
    if c.as_mut().is_some_and(|ch| ch.try_wait().ok().flatten().is_none()) { return false; }
    let home = std::env::var("HOME").unwrap_or_default();
    *c = std::process::Command::new("google-chrome")
        .args([
            "--headless=new", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
            "--no-first-run", "--disable-gpu", "--remote-debugging-port=0",
            &format!("--user-data-dir={home}/.local/share/coucou/call-chrome"),
            "http://127.0.0.1:8766/call.html",
        ])
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().ok();
    true
}

pub fn call_toggle(app: &AppHandle) {
    // One press can arrive twice (key repeat, key plus pill): a toggle within 1.2 s of the last one is dropped.
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if last.is_some_and(|t| t.elapsed() < Duration::from_millis(1200)) { crate::log::line("call toggle ignored (too soon)"); return; }
    *last = Some(Instant::now());
    drop(last);
    // Feedback at once: the pill listens (or goes away) before the room is even connected.
    let on = !CALL_LIVE.load(Ordering::Relaxed);
    CALL_LIVE.store(on, Ordering::Relaxed);
    if !on { voice_cancel(); }
    show(app, on.then(|| VoiceView { phase: "listening".into(), ..Default::default() }));
    call_cmd(app.clone(), "toggle".into());
}
pub fn call_end(app: &AppHandle) {
    if CALL_LIVE.load(Ordering::Relaxed) { call_toggle(app); }
}

/// The pill window reports the call; the island shows it as a conversation, the other windows paint their buttons.
#[tauri::command]
pub fn call_state(app: AppHandle, state: Value) {
    let live = state["live"].as_bool().unwrap_or(false);
    if CALL_LIVE.swap(live, Ordering::Relaxed) && !live && voice_cancel() > 0 {
        crate::log::line("voice: call ended, jobs stopped");
    }
    let _ = app.emit("call-state", &state);
    crate::log::line(format!("call state: live={live} heard={}ch answer={}ch err={}", state["heard"].as_str().map_or(0, str::len), state["answer"].as_str().map_or(0, str::len), state["error"].as_str().unwrap_or("")));
    if let Some(e) = state["error"].as_str().filter(|e| !e.is_empty()) {
        pill::announce(&app, "mic", "#FF5A5A", format!("{} {e}", crate::i18n::t("Voice call failed:")), None, 10);
    }
    let heard = state["heard"].as_str().unwrap_or("").to_string();
    let answer = state["answer"].as_str().unwrap_or("").to_string();
    let phase = if !answer.is_empty() { "speaking" } else { "listening" };
    show(&app, live.then(|| VoiceView { phase: phase.into(), heard, answer }));
}

// ── The voice agent works on the machine that calls: its OpenCode, its model, its folders. ──
const DENY: &str = r#"{"permission":{"bash":{"sudo *":"deny","su *":"deny","rm -rf *":"deny","git push *":"deny","git reset --hard*":"deny","git clean *":"deny","shutdown*":"deny","reboot*":"deny","systemctl *":"deny","kill *":"deny","pkill *":"deny","dd *":"deny","mkfs*":"deny"},"question":"deny"}}"#;

/// Runs one task with this machine's OpenCode, from ~/voice-work (its opencode.json holds the deny list unless `allow_blocked`).
/// Returns the tail of the output. Never logged.
#[tauri::command]
pub async fn voice_run(task: String, allow_blocked: Option<bool>) -> Result<String, String> {
    let _one_at_a_time = JOB_LOCK.lock().await;
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = std::path::Path::new(&home).join(if allow_blocked == Some(true) { "" } else { "voice-work" });
    if allow_blocked != Some(true) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("opencode.json"), DENY).map_err(|e| e.to_string())?;
    }
    let bin = std::path::Path::new(&home).join(".opencode/bin/opencode");
    let bin = if bin.is_file() { bin } else { "opencode".into() };
    let started = Instant::now();
    let task2 = task.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        use std::os::unix::process::CommandExt;
        // One session called "voice" for every voice job; its own process group so a hang-up can kill all of it.
        let mut cmd = std::process::Command::new(bin);
        cmd.args(["run", "--auto", "--title", "voice", "--session", "ses_voice", &task2]).current_dir(&dir)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).process_group(0);
        let child = cmd.spawn()?;
        let pid = child.id();
        JOBS.lock().unwrap().push(pid);
        // Hard stop after 15 minutes.
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(900)); kill_group(pid); });
        let r = child.wait_with_output();
        JOBS.lock().unwrap().retain(|p| *p != pid);
        r
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    crate::log::line(format!("voice_run: {:.1}s, {} bytes", started.elapsed().as_secs_f32(), out.stdout.len()));
    let mut t = String::from_utf8_lossy(&out.stdout).into_owned();
    t.push_str(&String::from_utf8_lossy(&out.stderr));
    let t = t.trim();
    let from = t.char_indices().rev().nth(1499).map_or(0, |(i, _)| i);
    Ok(t[from..].to_string())
}

static JOBS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static JOB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn kill_group(pid: u32) {
    // SIGKILL to the group: opencode and what it started. Nothing left to spend tokens.
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
}

/// Stops every voice job. The call ended, the user said stop, or the agent is gone.
#[tauri::command]
pub fn voice_cancel() -> usize {
    let v: Vec<u32> = std::mem::take(&mut *JOBS.lock().unwrap());
    v.iter().for_each(|p| kill_group(*p));
    v.len()
}

/// What the agent should know about this machine.
#[tauri::command]
pub fn voice_context() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
    let desktop = std::path::Path::new(&home).join("Desktop");
    let vault = crate::integrations::obsidian_vault().map(|p| p.display().to_string()).unwrap_or_default();
    let t = crate::platform::local_time();
    let mem = mem::recent();
    format!(
        "Máy đang gọi: {} (người dùng {}, {}). Thư mục home: {home}. Desktop: {}. Vault Obsidian: {vault}.\n{}Bây giờ: {:04}-{:02}-{:02} {:02}:{:02}.",
        host.trim(), std::env::var("USER").unwrap_or_default(), std::env::consts::OS, desktop.display(),
        if mem.is_empty() { String::new() } else { format!("Trí nhớ gần đây (tóm tắt các ngày trước):\n{mem}\n") },
        t.year, t.month, t.day, t.hour, t.minute,
    )
}
