// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, onEvent, type ChatContext, type ModelInfo } from "../core/bridge";
import {
  activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { OPENCODE_PILL, newOpenCodeSession, resumeOpenCodeSession, selectOpenCodeSession, sessionOf, setOpenCodeDirectory } from "../island/opencode";
import { N_, t, tl } from "../i18n/i18n";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
  ocPlaceholder: N_("Message this OpenCode session…"),
  ocNone: N_("No running OpenCode sessions"),
  ocDown: N_("OpenCode is not running"),
  ocStop: N_("Stop"),
  ocAllow: N_("Allow"),
  ocAlways: N_("Always"),
  ocNew: N_("New session"),
  ocFolder: N_("Folder and history"),
  ocPath: N_("Folder path, then Enter"),
  ocNoHistory: N_("No sessions here"),
  ocDeny: N_("Deny"),
};


let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  const el = h("div", { class: "picker" }, chips, h("div", { class: "picker-rule" }), list);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    onChange();
    void loadModels();
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const modelRow = h("div", { class: "model-row" }, modelBtn);

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    drawModelButton();
  });
  body.append(chipRow, log, picker.el, modelRow, bar);

  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;

  // ── OpenCode pill: the chat is the running OpenCode sessions (island/opencode.ts polls) ──
  // Top row: one tab per running session (scrolls sideways) and Stop on the right.
  const ocTabs = h("div", { class: "oc-tabs" });
  const ocStop = h("button", { class: "oc-stop", title: tl(STRINGS.ocStop) }, svg(ICONS.xmark, 9));
  const ocNew = h("button", { class: "oc-stop oc-plain", title: tl(STRINGS.ocNew), onclick: () => void newOpenCodeSession().catch(() => {}) }, svg(ICONS.plus, 10));
  const ocDir = h("button", { class: "oc-stop oc-plain", title: tl(STRINGS.ocFolder), onclick: () => {
    State.opencode.panel = !State.opencode.panel;
    ocKey = "";
    void drawPanel();
    State.notify();
  } }, svg(ICONS.house, 10));
  const ocRow = h("div", { class: "oc-row" }, ocTabs, ocNew, ocDir, ocStop);
  const ocPanel = h("div", { class: "oc-panel" });
  async function drawPanel() {
    clear(ocPanel);
    ocPanel.style.display = State.opencode.panel ? "" : "none";
    if (!State.opencode.panel) return;
    const path = h("input", { type: "text", class: "oc-path", spellcheck: "false", value: State.opencode.directory,
      placeholder: t(STRINGS.ocPath) }) as HTMLInputElement;
    const list = h("div", { class: "oc-hist" });
    const load = async () => {
      clear(list);
      setOpenCodeDirectory(path.value.trim());
      try {
        for (const s of await Bridge.opencodeHistory(path.value.trim())) {
          list.append(h("button", { class: "oc-tab", title: s.directory, onclick: () => resumeOpenCodeSession(s.id) },
            h("i", { class: s.running ? "oc-dot run" : "oc-dot" }), h("span", { text: s.title || s.id })));
        }
        if (!list.firstChild) list.append(h("span", { class: "oc-note", text: t(STRINGS.ocNoHistory) }));
      } catch { list.append(h("span", { class: "oc-note", text: t(STRINGS.ocNoHistory) })); }
    };
    path.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void load(); });
    ocPanel.append(path, list);
    if (path.value) void load();
  }
  ocPanel.style.display = "none";
  const ocPerms = h("div", { class: "oc-perms" });
  body.insertBefore(ocRow, log);
  body.insertBefore(ocPerms, log);
  body.insertBefore(ocPanel, log);
  const ocActive = () => State.chatPill === OPENCODE_PILL || State.chatPill.startsWith("ocs_");
  let ocKey = "";

  function ocDraw() {
    const on = ocActive();
    ocRow.style.display = on ? "" : "none";
    ocPerms.style.display = on ? "" : "none";
    ocPanel.style.display = on && State.opencode.panel ? "" : "none";
    modelRow.style.display = on ? "none" : "";
    if (!on) return;
    const oc = State.opencode;
    const shown = sessionOf(State.chatPill);
    const cur = oc.sessions.find((s) => s.id === shown);
    const key = JSON.stringify([oc.sessions, shown, oc.pending, oc.error]);
    ocStop.style.display = cur?.running ? "" : "none";
    ocStop.onclick = () => cur && void Bridge.opencodeInterrupt(cur.id).catch(() => {});
    if (key === ocKey) return;
    ocKey = key;
    clear(ocTabs);
    if (!oc.sessions.length) {
      ocTabs.append(h("span", { class: "oc-note", text: t(oc.error ? STRINGS.ocDown : STRINGS.ocNone) }));
    }
    for (const s of oc.sessions) {
      const label = s.title || s.directory.split("/").pop() || s.id;
      ocTabs.append(h("button", {
        class: s.id === shown ? "oc-tab on" : "oc-tab",
        title: s.directory,
        onclick: () => selectOpenCodeSession(s.id),
      }, h("i", { class: s.running ? "oc-dot run" : "oc-dot" }), h("span", { text: label })));
    }
    clear(ocPerms);
    for (const p of oc.pending.filter((x) => x.sessionId === shown)) {
      const reply = (d: "once" | "always" | "reject") => () =>
        void Bridge.opencodeReply(p.sessionId, p.id, d).catch(() => {});
      ocPerms.append(h("div", { class: "oc-perm" },
        h("span", { class: "oc-perm-text", text: [p.action, ...p.resources].join(" ") }),
        h("button", { class: "oc-btn", text: t(STRINGS.ocAllow), onclick: reply("once") }),
        h("button", { class: "oc-btn", text: t(STRINGS.ocAlways), onclick: reply("always") }),
        h("button", { class: "oc-btn", text: t(STRINGS.ocDeny), onclick: reply("reject") })));
    }
    input.placeholder = t(STRINGS.ocPlaceholder);
  }
  let renderedPill = "";
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    modelName.textContent = activeModel(State.settings) || t(STRINGS.noModel);
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
  }

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, text);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    if (ocActive()) {
      // Queued behind the current turn; the answer shows up through the poll.
      const sel = sessionOf(State.chatPill);
      if (!sel) return;
      input.value = "";
      try {
        await Bridge.opencodeSend(sel, query, "queue");
        Sound.play("send");
        selectOpenCodeSession(sel); // refresh now
      } catch (err) {
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        State.view = "note";
        Sound.play("error");
        State.notify();
      }
      return;
    }
    input.value = "";
    sending = true;
    drawModelButton();
    Sound.play("send");

    // The pill this turn belongs to: the answer lands there even if another pill is in front by then.
    const pill = State.chatPill;
    const history = State.chatHistory;
    history.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      history.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(pill, query, context);
      history.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      live = null;
      renderedCount = -1; // the finished answer replaces the streamed one
      drawModelButton();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      ocDraw();
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if ((count !== renderedCount || State.chatPill !== renderedPill) && !live) {
        renderedCount = count;
        renderedPill = State.chatPill;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      drawModelButton();

      if (!ocActive()) input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
