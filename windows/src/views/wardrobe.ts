// Wardrobe view — port of WardrobeView (IslandViewContent.swift). Opened with a
// right-click on Mochi or from the tray menu. Resting the pointer on a button
// tries the outfit on Mochi; a click keeps it.

import { h } from "./dom";
import { State } from "../core/state";
import { PILL_PALETTE } from "../core/pill-colors";
import { drawWardrobeIcon } from "../mochi/outfits";
import {
  OUTFIT_KEYS, OUTFIT_SELECTIONS, WARDROBE_STRINGS, pillWear, resolveOutfit, seasonalOutfit,
  wardrobeHeader, type Outfit, type OutfitSelection,
} from "../mochi/wardrobe";
import type { ViewActions, ViewHost } from "./views";
import { language, tl } from "../i18n/i18n";

const ICON = 28;

export function buildWardrobe(actions: ViewActions): ViewHost {
  const note = h("span", { class: "wardrobe-note" });
  const who = h("span", { class: "wardrobe-who" });
  /** What the focused pill's Mochi wears: the wardrobe edits that pill. */
  const current = () =>
    pillWear(State.settings.pillWardrobe, State.focusId ?? State.mainPillId, State.mainPillId, State.settings.mochiOutfit);
  const swatchRow = h("div", { class: "wardrobe-tints" });
  const swatches = new Map<string, HTMLButtonElement>();
  const pillRow = h("div", { class: "wardrobe-tints" }, h("span", { class: "wardrobe-row-label", text: tl("Pill") }));
  const pillSwatches = new Map<string, HTMLButtonElement>();
  for (const hex of PILL_PALETTE) {
    const b = h("button", { class: "wardrobe-tint", title: hex, "aria-label": hex, onclick: () => actions.choosePillColor(hex) }) as HTMLButtonElement;
    b.style.background = hex;
    pillSwatches.set(hex, b);
    pillRow.append(b);
  }
  swatchRow.append(h("span", { class: "wardrobe-row-label", text: tl("Clothes") }));
  for (const hex of ["", ...PILL_PALETTE]) {
    const b = h("button", {
      class: hex ? "wardrobe-tint" : "wardrobe-tint none",
      title: hex ? hex : tl("No colour"),
      "aria-label": hex ? hex : tl("No colour"),
      onclick: () => actions.chooseTint(hex || null),
    }) as HTMLButtonElement;
    if (hex) b.style.background = hex;
    swatches.set(hex, b);
    swatchRow.append(b);
  }
  const grid = h("div", { class: "wardrobe-grid" });
  const el = h(
    "div",
    { class: "view wardrobe" },
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "stack wardrobe-stack" },
        h("div", { class: "wardrobe-head" }, h("span", { class: "wardrobe-title", text: tl("Wardrobe") }), who, note),
        grid,
        pillRow,
        swatchRow,
      ),
    ),
  );

  let hovered: OutfitSelection | null = null;
  let drawnSeason: Outfit | null = null;
  let drawnLanguage = language();
  let drawnDpr = 0;
  const items = new Map<OutfitSelection, { button: HTMLButtonElement; canvas: HTMLCanvasElement }>();

  const updateNote = () => {
    note.textContent = wardrobeHeader(hovered, current().outfit, new Date());
  };

  for (const sel of OUTFIT_SELECTIONS) {
    const canvas = h("canvas");
    const button = h(
      "button",
      { class: "wardrobe-item", title: tl(OUTFIT_KEYS[sel]), "aria-label": tl(OUTFIT_KEYS[sel]) },
      canvas,
    );
    button.addEventListener("mouseenter", () => {
      hovered = sel;
      actions.previewOutfit(resolveOutfit(sel, new Date()));
      updateNote();
    });
    button.addEventListener("mouseleave", () => {
      if (hovered !== sel) return;
      hovered = null;
      actions.previewOutfit(null);
      updateNote();
    });
    button.addEventListener("click", () => actions.chooseOutfit(sel));
    items.set(sel, { button, canvas });
    grid.append(button);
  }

  /** Icons are drawn once; only "auto" changes, with the season and its badge's language. */
  const drawIcons = () => {
    const season = seasonalOutfit(new Date());
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (season === drawnSeason && drawnLanguage === language() && drawnDpr === dpr) return;
    // On a monitor of another scale every icon is drawn again, sharp and whole.
    const first = drawnSeason == null || drawnDpr !== dpr;
    drawnSeason = season;
    drawnLanguage = language();
    drawnDpr = dpr;
    for (const [sel, { canvas }] of items) {
      if (!first && sel !== "auto") continue;
      canvas.width = Math.round(ICON * dpr);
      canvas.height = Math.round(ICON * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWardrobeIcon(ctx, ICON, sel, season, WARDROBE_STRINGS.autoBadge);
    }
  };

  return {
    el,
    sync() {
      drawIcons();
      // The island drops the preview when the view closes: so does the hover.
      if (State.wardrobePreview == null) hovered = null;
      const now = current();
      for (const [sel, { button }] of items) button.classList.toggle("on", sel === now.outfit);
      const t = State.focusTask;
      who.textContent = t ? t.name : "";
      who.style.color = t?.color ?? "";
      for (const [hex, b] of pillSwatches) b.classList.toggle("on", hex === (t?.color ?? "").toUpperCase());
      for (const [hex, b] of swatches) b.classList.toggle("on", hex === (now.tint ?? ""));
      updateNote();
    },
  };
}
