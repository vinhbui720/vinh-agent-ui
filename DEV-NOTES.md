# Our Coucou fork: dev notes

Upstream: Louis-CFM/coucou (remote `upstream`). Branch `dev/vinh`. Linux app is in `windows/` (Tauri 2: Rust + TypeScript).
Run: `cd windows && npm run tauri dev`. Release: `npm run pack` (AppImage in `windows/release/`).
Tests need Node 22+ (Node 20.20.2 lacks `registerHooks`). `libgtk-layer-shell-dev` is missing, so the island is a regular window and the log shows size mismatch 720x320 vs 240x6.

## Goal
Coucou is a notification visualizer. We want it wired to OpenCode:
- Home tab = left card (main watched agent) + right list (pills).
- Default main pill: OpenCode. List: OpenCode, VS Code, Spotify only.
- OpenCode pill knows all running sessions and chat is bound to the session (write in the pill instead of the TUI).
- Chat tab and home tab are separate; do home first.
- Full rebrand later (name, icon, Mochi, sounds, bundle ID). Required before publishing.

## User can do now (no code, no rebuild)
- Edit `~/.config/coucou/settings.json` or Settings UI: main pill, declared pills (max 4), sound, screen, language, shortcuts, hover, auto-close.
  - Main pill must be a "workspace" pill: Claude Code, Cursor, Antigravity, Codex. OpenCode is "agent", so it cannot be main yet.
- Declare `agent_opencode` and `integration_spotify` as pills (works).
- Install OpenCode hook plugin: Settings → Agents → OpenCode (writes `~/.config/opencode/plugins/coucou.js`). Notification-only, one-way.
- Replace sounds in `~/.config/coucou/sounds/`.
- API keys via Settings → Integrations (OS keyring).

## Does not exist, needs dev
1. OpenCode as main pill (`src/core/pills.ts`: category `agent` -> `workspace`; I tried it once and the island looked broken, cause unknown; reverted).
2. VS Code pill: none exists. Only an "Open VS Code" button in the Claude card.
3. `opencode.rs`: direct OpenCode client. Not written.
4. Per-session rows and live session list.
5. Chat bound to an OpenCode session. Today `chat.rs` is a standalone model chat, one shared conversation, no agent access.
6. Permission Allow/Deny wired to OpenCode API (today only the Claude-style hook socket path).
7. Pill list restricted to 3 pills in the catalog (currently 20+ in `PILL_CATALOG`; config can hide them, code cannot remove them yet).
8. Rebrand.

## OpenCode API (v2.0.18, verified read-only)
- Service file: `~/.local/state/opencode/service.json` -> `{url, pid, password}`. Port changes on restart; re-read each reconnect.
- Auth: HTTP Basic, user `opencode`, password from the file. Bearer gives 401.
- `GET /api/session/active` running sessions. `GET /api/session` list.
- `GET /api/event` SSE for all sessions (`session.step.started`, `session.reasoning.delta`, ...). Contains reasoning text: never log it.
- Documented, not yet run: `POST /api/session/{id}/prompt` (`delivery`: `steer` | `queue`), `POST .../interrupt`, `POST .../permission/{reqID}/reply`, `GET .../message`.
- API is labeled experimental: fail soft when missing.
- Docs: https://opencode.ai/v2/docs/api, OpenAPI https://opencode.ai/v2/openapi.json

## Where to change what
- Pill catalog: `windows/src/core/pills.ts`. Pill IDs are stable contract values, never rename.
- Home view: `windows/src/views/views.ts` (`buildOverview`), CSS `windows/src/style.css`.
- Integration cards: `windows/src/views/integrations.ts`. Settings fields: `windows/src/settings/main.ts`.
- Pollers/secrets: `windows/src-tauri/src/integrations.rs`, `secrets.rs`. Wiring: `lib.rs`.
- Hook plugin writer: `windows/src-tauri/src/agents.rs`. Relay socket: `pipe.rs`.
- Upstream rules: `CLAUDE.md` (never restyle existing views, no telemetry, secrets only in keyring).

## Rules for this fork
- Do not edit code unless asked. Config-only changes when user says so.
- Never take or read images (global rule).
- Do not send prompts into the user's live OpenCode sessions; test with a throwaway session.
