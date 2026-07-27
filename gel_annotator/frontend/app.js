/* Gel Annotator — vector rebuild, with the deferred features filled in.
 *
 *  STATE  ──→  render()  ──→  live <svg>  ──→  export
 *
 * What's new vs the MVP:
 *   • Free-form text and line annotations (click/drag tools).
 *   • Per-label drag (dx/dy override) — every auto-generated label is
 *     selectable and draggable; offsets persist across renders.
 *   • Per-label font-size + color overrides.
 *   • Hide ladders: masks the gel content of any FLANK ladder lane with
 *     the canvas background; band markers + size labels stay visible.
 *   • Image rotation: ±90° via toolbar buttons (server-side, lossless).
 *   • Saturation overlay: a transparent PNG on top of the gel marking
 *     saturated pixels.
 *
 * Architecture invariant preserved: ALL of the above are real SVG
 * elements painted into the live <svg>. Export = serialize the same DOM.
 */

"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── State ────────────────────────────────────────────────────────────
const state = {
  // Image
  imageId: null, imgWidth: 0, imgHeight: 0, imageDataUrl: null, filename: "",
  // Bit depth reported by the server (8 / 16 / 32). 16+ unlocks LUT
  // editing + the saturation toggle. 8-bit images (typical PNG/JPEG)
  // get a permanent red-saturation overlay (so clipped pixels stand
  // out) while LUT and saturation buttons are grayed-out with a
  // tooltip prompting the user to upload a raw16 / TIFF / 16-bit
  // image to use those features.
  bitDepth: 16,
  lut: { min: 0, max: 255, gamma: 1.0 }, rawMin: 0, rawMax: 255,
  invertImage: false,
  // User-chosen paper/background color (hex like "#ffffff"). "" = automatic:
  // white normally, near-black (#1a1a1a) when the image is inverted. When set,
  // it overrides both and drives luminance-based ink so default labels stay
  // readable. Reflected in the live <svg> AND every export (export = serialize
  // the same SVG, so the one bgFill below covers live view + PNG + SVG).
  bgColor: "",

  // Region (image coords)
  region: null,
  // When true, the rendered image is clipped to the region (and the canvas
  // shrinks to just the region + margins). When false (default after a
  // fresh region draw), the FULL image is shown with the region drawn as
  // an outline overlay — like ImageJ/Fiji's ROI workflow. The user toggles
  // this with the "Crop to region" button. Independent of hide-ladders,
  // which forces a stronger collapsed view orthogonally.
  croppedToRegion: false,

  // Table
  laneCount: 10,
  ladder: [],
  cells: {},                    // { columnId: string[] }
  columns: [],
  bands: {},                    // { laneIndex: [{ id, y_center, label }] }
  selectedLanes: new Set(),
  // Inner-separator positions as fractions in [0,1]. Length = laneCount-1.
  // null/undefined ⇒ default even spacing. Populated when the user drags a
  // lane separator. Outer "separators" (region edges) are always at 0 and 1
  // and are not stored — drag the region's resize handles to move those.
  laneSeparators: null,
  // Shared horizontal offset (image px) for ALL ladder band labels in a
  // given lane. { laneIdx: dx }. Drag any label left/right and they all
  // move together → labels stay in a vertical column. Default 0 means
  // "labels sit just outside the gel on the side closest to that lane".
  ladderLabelDx: {},
  // While set, that band's label renders as a foreignObject + <input>
  // instead of an SVG <text>. { laneIdx: number, bandId: string }.
  _editingBand: null,
  // While set (a tick index 0..n), the tick is highlighted with explicit
  // drag handles for separator-move (horizontal) and tick-height
  // (vertical). Click elsewhere or press Esc to clear. The handle drags
  // are SINGLE-axis (no dead-zone / axis-pending step), so the user
  // doesn't have to "guess right" on the initial movement direction.
  _selectedTick: null,
  // Multi-element selection (rectangular marquee). Array of refs:
  //   { kind: "annotation", id }
  //   { kind: "label", key }
  // Mutually exclusive with `selected` — when this has entries, `selected`
  // is null. Group drag moves every element by the same delta; Delete
  // removes them all in one history entry.
  _multiSelected: [],
  // Rectangular CELL range in the metadata table. Set by drag-select
  // across cells. Used for multi-cell editing (typing fills the range)
  // and clipboard copy/paste.
  //   { startRow, startCol, endRow, endCol } (col indices into state.columns)
  _cellRange: null,
  // Active Illustrator-style rotate mode. When non-null, ALL pointer
  // interactions on the SVG become rotation gestures around `pivot`.
  //   target:    "image" | "elements"
  //   pivot:     { x, y } in image coords
  //   refs/origs:annotation refs + pre-rotation snapshots (elements target)
  //   angle:     current preview angle (deg, signed)
  //   dragStart: pointerdown image-coords, set on first pointerdown
  rotateMode: null,
  // Region "selected" flag — when true, the corner resize handles are
  // shown and the outline gets a blue accent. Toggled by clicking the
  // region's outline rectangle. Cleared when the user clicks elsewhere.
  // Without this, the resize handles cluttered the canvas every time
  // the user just wanted to look at the gel.
  _regionSelected: false,
  // Zoom factor applied to the SVG's CSS-rendered size. 1.0 = "fit"
  // (auto-sized to the canvas-wrap container with a 1200px cap).
  // Wheel events on the canvas multiply this scale by 1.1 (zoom in)
  // or divide by 1.1 (zoom out), centered on the cursor position.
  // Clamped to [0.1, 10] so the user can't zoom into oblivion.
  // _Not_ persisted to undo / save — it's a viewport setting, like
  // scroll position, that the user resets per-session if needed.
  _zoomScale: 1.0,

  // Free-form annotations
  annotations: [],              // [{ id, type:'text'|'line', ...geometry, fontSize, color, thickness, arrowhead, text }]
  // Per-label overrides: keyed by stable label-id. Each entry can carry
  // dx/dy (drag offset) and/or fontSize/color overrides.
  labelOverrides: {},           // { labelKey: { dx, dy, fontSize, color, rotation, hidden } }
  // Per-column visibility flag. Default-undefined means SHOWN. Toggled
  // by the "Show" row of checkboxes in the metadata table. Hiding a
  // column removes its bracket row and row label from rendering AND
  // from the smart-rotation overflow check, so the layout collapses
  // cleanly. Per-label hidden flags (labelOverrides[key].hidden) are a
  // separate, finer-grained mechanism for individually deleted labels.
  columnVisible: {},            // { colid: bool }  (absent ⇒ visible)
  // Whether the per-lane numbers (1, 2, 3, …) render above the gel.
  // Toggled by the "Show" checkbox in the Lane column header. The
  // user can still mark / select / drop bands in lanes regardless;
  // this only affects the rendered numeric labels.
  showLaneNumbers: true,

  // Selection (single-element)
  selected: null,               // { kind: 'annotation'|'label', id|key }

  // Display flags
  regionOutline: true,
  bracketLineStyle: "solid", lineCap: "butt",
  hideLadders: false,
  showSaturation: false,
  satOverlayUrl: null,          // populated lazily when saturation is toggled on

  // Tools: 'region' | 'text' | 'line' | null (= select)
  tool: null,

  // In-flight text being typed for an annotation (placeholder edit)
  pendingTextAnn: null,         // {id} — the annotation receiving keystrokes

  // Layout (image-coord pixels)
  marginTop: 200, marginLeft: 70, marginRight: 70, marginBottom: 30,
  rowHeight: 38, fontPx: 18, tickHeight: 10, bandLeaderGap: 12, strokeWidth: 2,
  // Per-feature stroke widths. Both default to `strokeWidth` for
  // backward compatibility — when null/undefined the renderer falls
  // back to `strokeWidth`. The Options menu exposes these as separate
  // numeric inputs so the user can fatten the region outline without
  // also fattening the brackets / leader lines, etc.
  regionBorderWidth: 2,
  tickWidth: 2,

  // fEMSA quantification. Owned entirely by quant.js — app.js only
  // declares the slot so it participates in undo/redo, save/load, and
  // the new-image reset alongside every other piece of state. See
  // FEMSA.blankState() for the shape.
  quant: null,

  // Undo/redo history. `history` is an array of { snapshot, label } entries
  // where each `snapshot` is a deep clone of all UNDOABLE_FIELDS at a point
  // in time. `historyIndex` points at the entry whose snapshot represents
  // the CURRENT state — undo decrements, redo increments. Transient UI
  // state (selected, tool, pendingTextAnn, drag state) is intentionally
  // NOT snapshotted.
  history: [], historyIndex: -1,
};

const MAX_HISTORY = 50;
// Fields that participate in undo/redo. Everything in `state` not listed
// here is treated as transient or derived (selected, tool, pendingTextAnn,
// _bandTargetLane, selectedLanes, history fields themselves, layout
// constants).
const UNDOABLE_FIELDS = [
  "imageId", "imgWidth", "imgHeight", "imageDataUrl", "filename",
  "lut", "rawMin", "rawMax", "invertImage", "bgColor",
  "region", "regionOutline", "croppedToRegion",
  "bracketLineStyle", "lineCap", "hideLadders",
  "showSaturation", "satOverlayUrl",
  "laneCount", "ladder", "cells", "columns", "bands",
  "laneSeparators", "tickHeight", "ladderLabelDx",
  "annotations", "labelOverrides",
  "regionBorderWidth", "tickWidth",
  "columnVisible", "showLaneNumbers",
  "quant",
];

// ── Common ladder presets ────────────────────────────────────────────
//
// Listed BOTTOM-UP — i.e. LADDER_PRESETS[type][name][0] is the band that
// ran the FURTHEST (smallest molecule, lowest on the gel). After auto-
// detection produces a list of bands sorted bottom-up, applying a preset
// just zips its labels onto those bands in order; any extras keep "?".
const LADDER_PRESETS = {
  protein: {
    "PageRuler (10–180 kDa)":           ["10", "15", "25", "35", "55", "70", "100", "130", "180"],
    "PageRuler Plus (10–250 kDa)":      ["10", "15", "25", "35", "55", "70", "100", "130", "250"],
    "PageRuler Prestained (10–180 kDa)":["10", "17", "26", "34", "43", "55", "72", "95", "130", "180"],
    "Spectra Multicolor (10–260 kDa)":  ["10", "15", "20", "25", "35", "40", "50", "70", "100", "140", "260"],
    "Precision Plus (10–250 kDa)":      ["10", "15", "20", "25", "37", "50", "75", "100", "150", "250"],
    "BlueStar Prestained":              ["10", "17", "26", "34", "43", "55", "72", "95", "130", "170"],
  },
  dna: {
    "1 kb Plus (100–12000 bp)":         ["100", "200", "300", "400", "500", "650", "850", "1000", "1650", "2000", "3000", "4000", "5000", "6000", "8000", "10000", "12000"],
    "1 kb (250–10000 bp)":              ["250", "500", "750", "1000", "1500", "2000", "2500", "3000", "4000", "5000", "6000", "8000", "10000"],
    "100 bp (100–1000 bp)":             ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"],
    "100 bp Plus (100–3000 bp)":        ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000", "1200", "1500", "2000", "3000"],
    "Lambda HindIII (125–23130 bp)":    ["125", "564", "2027", "2322", "4361", "6557", "9416", "23130"],
    "GeneRuler 1 kb (250–10000 bp)":    ["250", "500", "750", "1000", "1500", "2000", "2500", "3000", "4000", "5000", "6000", "8000", "10000"],
  },
  rna: {
    "Millennium Marker (500–6000 nt)":  ["500", "1000", "1500", "2000", "2500", "3000", "4000", "5000", "6000"],
    "RiboRuler High Range (200–6000)":  ["200", "500", "1000", "1500", "2000", "3000", "4000", "5000", "6000"],
    "RiboRuler Low Range (100–1000)":   ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"],
  },
};

function historySnapshot() {
  // structuredClone deep-clones objects/arrays/Sets while strings (the
  // imageDataUrl is a base64 data URL ~MB) remain primitive — JS shares
  // string storage across all references, so 50 snapshots × 1 MB URL does
  // NOT cost 50 MB.
  const s = {};
  for (const k of UNDOABLE_FIELDS) s[k] = structuredClone(state[k]);
  return s;
}

function historyRestore(snap) {
  for (const k of UNDOABLE_FIELDS) state[k] = structuredClone(snap[k]);
}

function commitHistory(label) {
  const newSnap = historySnapshot();
  // Dedup: if nothing changed since last commit, don't add a no-op step
  // (otherwise the user would have to press Ctrl+Z multiple times to "skip"
  // empty entries — confusing). JSON.stringify-compare is ~ms even on
  // megabyte imageDataUrl strings; fine for user-action cadence.
  const last = state.history[state.historyIndex];
  if (last && JSON.stringify(last.snapshot) === JSON.stringify(newSnap)) return;
  // Drop any redo branch — once the user makes a new edit after undoing,
  // the previously-undone future is no longer reachable.
  if (state.historyIndex < state.history.length - 1) {
    state.history.length = state.historyIndex + 1;
  }
  state.history.push({ snapshot: newSnap, label: label || "" });
  state.historyIndex = state.history.length - 1;
  // Cap memory: drop oldest entries if we blow past MAX_HISTORY.
  if (state.history.length > MAX_HISTORY) {
    const drop = state.history.length - MAX_HISTORY;
    state.history.splice(0, drop);
    state.historyIndex -= drop;
  }
  updateUndoRedoUI();
}

function undo() {
  if (state.historyIndex <= 0) return;
  // Cancel any in-flight drag — restoring underneath would corrupt it.
  if (drag) cancelDrag();
  const undidLabel = state.history[state.historyIndex].label;
  state.historyIndex--;
  historyRestore(state.history[state.historyIndex].snapshot);
  // Clear transient UI that may reference now-gone state
  state.selected = null;
  state.pendingTextAnn = null;
  state.tool = null;
  state._editingBand = null;
  state.selectedLanes.clear();
  document.body.classList.remove("tool-region", "tool-text", "tool-line", "tool-band");
  ["draw-region-btn", "add-text-btn", "add-line-btn"].forEach(id => $(id).classList.remove("toggle-on"));
  // Sync UI controls to restored state
  syncControlsToState();
  rebuildTable(); renderAll(); refreshSelectionPanel();
  updateUndoRedoUI();
  setStatus(`Undid: ${undidLabel || "previous action"}`);
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  if (drag) cancelDrag();
  state.historyIndex++;
  historyRestore(state.history[state.historyIndex].snapshot);
  state.selected = null;
  state.pendingTextAnn = null;
  state.tool = null;
  state._editingBand = null;
  state.selectedLanes.clear();
  document.body.classList.remove("tool-region", "tool-text", "tool-line", "tool-band");
  ["draw-region-btn", "add-text-btn", "add-line-btn"].forEach(id => $(id).classList.remove("toggle-on"));
  syncControlsToState();
  rebuildTable(); renderAll(); refreshSelectionPanel();
  updateUndoRedoUI();
  setStatus(`Redid: ${state.history[state.historyIndex].label || "next action"}`);
}

function updateUndoRedoUI() {
  const undoBtn = $("undo-btn"), redoBtn = $("redo-btn");
  if (undoBtn) undoBtn.disabled = state.historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// Hide-ladders requires at least one lane marked as a ladder. When that's
// not the case, gray the button out AND turn the flag off if it was on
// (otherwise a previously-active hide-ladders state would persist
// invisibly with no way to interact with it). Called after any change to
// state.ladder OR state.imageId.
function updateHideLaddersBtn() {
  const btn = $("hide-ladders-btn");
  if (!btn) return;
  const hasLadder = Array.isArray(state.ladder) && state.ladder.some(Boolean);
  // The button still respects NEEDS_IMAGE — it gets enabled by image
  // upload first; ladder presence is the SECOND constraint on top.
  if (state.imageId) {
    btn.disabled = !hasLadder;
  } else {
    btn.disabled = true;
  }
  if (!hasLadder && state.hideLadders) {
    state.hideLadders = false;
    btn.classList.remove("toggle-on");
    renderAll();
  }
}

// Crop button reflects state.croppedToRegion in its toggle-on class.
function updateCropBtn() {
  const btn = $("crop-btn");
  if (btn) btn.classList.toggle("toggle-on", !!state.croppedToRegion);
}

// After history-restore, the toolbar/sidebar inputs may no longer reflect
// state (e.g. lane count number, LUT sliders, ladder checkboxes, options
// menu). This function re-syncs them. rebuildTable() handles the table
// itself.
function syncControlsToState() {
  if ($("lane-count")) $("lane-count").value = state.laneCount;
  if ($("lut-min")) $("lut-min").value = state.lut?.min ?? 0;
  if ($("lut-max")) $("lut-max").value = state.lut?.max ?? 255;
  if ($("lut-gamma")) $("lut-gamma").value = state.lut?.gamma ?? 1;
  if ($("opt-region-outline")) $("opt-region-outline").checked = state.regionOutline;
  if ($("opt-line-style")) $("opt-line-style").value = state.bracketLineStyle;
  if ($("opt-line-cap")) $("opt-line-cap").value = state.lineCap;
  if ($("opt-tick-height")) $("opt-tick-height").value = state.tickHeight;
  if ($("opt-region-border-width")) $("opt-region-border-width").value = state.regionBorderWidth ?? state.strokeWidth;
  if ($("opt-tick-width")) $("opt-tick-width").value = state.tickWidth ?? state.strokeWidth;
  // Show the explicit choice if set, else the effective auto color so the
  // swatch previews what's actually painted behind the gel.
  if ($("opt-bg-color")) $("opt-bg-color").value =
    state.bgColor || (state.invertImage ? "#1a1a1a" : "#ffffff");
  if ($("invert-btn")) $("invert-btn").classList.toggle("toggle-on", state.invertImage);
  // The dark theme is gated by body.inverted, which the click handler
  // syncs alongside state.invertImage. After an undo/redo, body must
  // follow state too — otherwise the theme can stick on/off when the
  // underlying flag has been reverted.
  document.body.classList.toggle("inverted", !!state.invertImage);
  if ($("hide-ladders-btn")) $("hide-ladders-btn").classList.toggle("toggle-on", state.hideLadders);
  if ($("saturation-btn")) $("saturation-btn").classList.toggle("toggle-on", state.showSaturation);
  updateCropBtn();
  updateHideLaddersBtn();
  // If imageId is set, NEEDS_IMAGE buttons should be enabled; otherwise
  // disable them (matches initial state).
  if (state.imageId) {
    NEEDS_IMAGE.forEach(id => { if ($(id)) $(id).disabled = false; });
    if ($("lane-count")) $("lane-count").disabled = false;
    if ($("lane-minus")) $("lane-minus").disabled = false;
    if ($("lane-plus")) $("lane-plus").disabled = false;
    if ($("empty-state")) $("empty-state").style.display = "none";
  } else {
    NEEDS_IMAGE.forEach(id => { if ($(id)) $(id).disabled = true; });
    if ($("lane-count")) $("lane-count").disabled = true;
    if ($("lane-minus")) $("lane-minus").disabled = true;
    if ($("lane-plus")) $("lane-plus").disabled = true;
    if ($("empty-state")) $("empty-state").style.display = "flex";
  }
}

let nextId = 1;
const newId = () => `id_${nextId++}`;
const $ = (id) => document.getElementById(id);
const svg = $("gel-svg");

const NEEDS_IMAGE = [
  "draw-region-btn", "add-text-btn", "add-line-btn",
  "rotate-btn",
  "invert-btn", "saturation-btn", "crop-btn", "hide-ladders-btn",
  "lut-btn", "options-btn", "quant-btn",
  // The hidden originals stay in the list so all existing toggle code
  // (which uses these IDs) keeps working — the dropdown items below
  // mirror their disabled state, and clicking a disabled hidden button
  // is a no-op, so the .click() forward from a menu item won't fire.
  "save-btn", "export-png-btn", "export-svg-btn",
  // Visible dropdown UI. project-dd-btn is intentionally NOT here:
  // Load is a valid pre-image action (the user might want to load a
  // saved project before they have any image), so the Project dropdown
  // is always enabled — but its "Save" menu item is gated separately.
  "export-dd-btn",
  "project-save-item", "export-png-item", "export-svg-item",
];

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

// ── Tools ────────────────────────────────────────────────────────────
function setTool(t) {
  // Tool change always invalidates any in-flight drag — otherwise a user
  // mid-region-drag could click "+ Text" and end up with a half-formed
  // region committed by the next pointerup.
  if (typeof drag !== "undefined" && drag) cancelDrag();
  state.tool = t;
  document.body.classList.remove("tool-region", "tool-text", "tool-line", "tool-band", "tool-qrow");
  if (t) document.body.classList.add(`tool-${t}`);
  ["draw-region-btn", "add-text-btn", "add-line-btn"].forEach((id) => {
    const expect = { "draw-region-btn": "region", "add-text-btn": "text", "add-line-btn": "line" }[id];
    $(id).classList.toggle("toggle-on", t === expect);
  });
  // Switching to any other tool disarms a pending fEMSA row placement,
  // so the next click on the gel doesn't sweep out a phantom row.
  if (window.FEMSA) FEMSA.syncTool(t);
  if (t) clearSelection();
}

$("draw-region-btn").addEventListener("click", () => {
  if (!state.imageId) return;
  setTool(state.tool === "region" ? null : "region");
  setStatus(state.tool === "region"
    ? "Click and drag on the gel to draw the analysis region."
    : "Tool cancelled.");
});
$("add-text-btn").addEventListener("click", () => {
  if (!state.imageId) return;
  setTool(state.tool === "text" ? null : "text");
  setStatus(state.tool === "text"
    ? "Click on the gel to place a text label, then type. Click outside or press Esc to commit."
    : "Tool cancelled.");
});
$("add-line-btn").addEventListener("click", () => {
  if (!state.imageId) return;
  setTool(state.tool === "line" ? null : "line");
  setStatus(state.tool === "line"
    ? "Drag on the gel to draw a line. After drawing, click it to change colour / thickness / arrowhead."
    : "Tool cancelled.");
});

// ── Upload ───────────────────────────────────────────────────────────
$("file-input").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  // Reset the input value FIRST so re-uploading the same file later
  // (after cancellation or after the user picks "no" below) still
  // fires a fresh change event. Without this, picking the same file
  // twice in a row would be ignored by the browser.
  e.target.value = "";
  if (!f) return;
  // If a gel is already loaded, warn before clobbering it. The
  // upload path resets state.region, ladder, columns, cells, bands,
  // selections, and the displayed image — none of which are recoverable
  // once the new image arrives. Use a native confirm() so we don't
  // need to spin up a modal for what should be a quick yes/no.
  if (state.imageId) {
    const ok = confirm(
      "An image is already loaded.\n\n" +
      "Uploading a new image will REPLACE it and discard the current " +
      "region, ladder, metadata columns, bands, and any unsaved " +
      "annotations.\n\n" +
      "Save your project first if you want to come back to it. " +
      "Continue with the new image?"
    );
    if (!ok) return;
  }
  await uploadImage(f);
});

async function uploadImage(file) {
  // Any in-flight drag references coordinates from the OLD image. Cancel
  // before we replace state.imageId so a stale region-draw can't commit
  // against the new image.
  if (typeof drag !== "undefined" && drag) cancelDrag();
  // Stage 1: upload + decode. Useful to differentiate so the user can
  // tell whether the slowness is the network, the image decode, or the
  // preview render — uploads of multi-megabyte 16-bit TIFFs can take
  // several seconds on each step independently.
  const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
  setStatus(`Uploading ${file.name} (${fileSizeMB} MB)…`);
  const fd = new FormData(); fd.append("file", file);
  let resp;
  try { resp = await fetch("/api/upload", { method: "POST", body: fd }); }
  catch (e) { setStatus("Upload failed: " + e.message, true); return; }
  if (!resp.ok) { setStatus("Upload failed: " + (await resp.text()), true); return; }
  setStatus("Decoding image…");
  const data = await resp.json();
  hydrateImage(data);
  // Reset annotations on new image
  state.region = null; state.croppedToRegion = false;
  state.laneCount = 10; state.ladder = []; state.cells = {};
  state.columns = []; state.bands = {}; state.selectedLanes.clear();
  state.columnVisible = {};
  state.showLaneNumbers = true;
  state.laneSeparators = null;
  state.ladderLabelDx = {}; state._editingBand = null;
  state.annotations = []; state.labelOverrides = {}; state.selected = null;
  state.hideLadders = false; state.satOverlayUrl = null;
  if (window.FEMSA) FEMSA.resetForNewImage();
  // Saturation overlay is ON by default for every new upload — this is
  // what users expect when looking at a fresh gel: a quick visual cue
  // for which bands are clipped. (Previously only 8-bit images got
  // auto-saturation; 16-bit gels appeared "too dark" because clipped
  // pixels weren't highlighted.) The user can toggle it off via the
  // Saturation button if they don't want the red overlay.
  state.showSaturation = true;
  $("hide-ladders-btn").classList.remove("toggle-on");
  $("saturation-btn").classList.add("toggle-on");
  $("lane-count").value = state.laneCount;
  // Re-apply bit-depth gates AFTER resets above. For 8-bit, this
  // additionally LOCKS the saturation toggle on (and disables the
  // button + LUT button). For 16-bit, it leaves the user-toggleable
  // default we just set.
  applyBitDepthGates();
  setStatus("Generating preview…");
  // loadPreview internally calls loadSaturation when showSaturation is
  // truthy, so we don't need a separate fetch — the overlay will be in
  // state.satOverlayUrl by the time renderAll runs below.
  await loadPreview();
  if (state.bitDepth < 16) {
    // Non-blocking warning — alerts are intrusive but the user
    // explicitly asked for one. Falling through to the status bar
    // would be too easy to miss.
    setTimeout(() => alert(
      "This is an 8-bit image (likely a JPEG / PNG / RGB photo). Some features " +
      "are limited:\n\n" +
      "  • LUT (lookup table) editing is disabled\n" +
      "  • Saturation toggle is locked on (saturated pixels show in red)\n\n" +
      "Upload a 16-bit raw image (.raw16, 16-bit TIFF) for full functionality."
    ), 50);
    setStatus(`Loaded 8-bit ${data.filename} (${data.width} × ${data.height}). Some features limited.`);
  } else {
    setStatus(`Loaded ${data.filename} (${data.width} × ${data.height}). Click "Draw region" to define the analysis area.`);
  }
  rebuildTable(); renderAll();
  // Sync conditional-enabled buttons (hide-ladders requires a ladder
  // lane; crop button reflects the cropped flag — both reset on upload).
  updateHideLaddersBtn(); updateCropBtn();
  // Reset history — a fresh image is a clean slate. Without this, undo
  // could revert past the upload into the previous image's state, which
  // would be confusing (annotations from a different image, etc.).
  state.history = []; state.historyIndex = -1;
  commitHistory(`Open ${data.filename}`);
}

function hydrateImage(data) {
  state.imageId = data.image_id; state.imgWidth = data.width; state.imgHeight = data.height;
  state.filename = data.filename; state.rawMin = data.raw_min; state.rawMax = data.raw_max;
  state.lut = data.initial_lut;
  state.bitDepth = (typeof data.bit_depth === "number") ? data.bit_depth : 16;
  $("lut-min").value = state.lut.min; $("lut-max").value = state.lut.max; $("lut-gamma").value = state.lut.gamma;
  NEEDS_IMAGE.forEach((id) => $(id).disabled = false);
  $("lane-count").disabled = false; $("lane-minus").disabled = false; $("lane-plus").disabled = false;
  $("empty-state").style.display = "none";
  // Apply the bit-depth-dependent gates LAST so it overrides the
  // NEEDS_IMAGE blanket-enable above for any features that require
  // ≥16-bit raw data (LUT, saturation toggle, etc.).
  applyBitDepthGates();
}

// Disable / re-enable features that need 16-bit raw data based on
// state.bitDepth. For 8-bit images:
//   • LUT button → disabled, with tooltip prompting raw16 upload
//   • Saturation toggle → disabled with same tooltip
//   • Saturation overlay → AUTO-ON so clipped pixels still appear in
//     red (this is the "intelligent default" the user expects when
//     LUT is off — otherwise saturated regions just look dark gray).
// For ≥16-bit images these constraints are lifted.
function applyBitDepthGates() {
  const lutBtn = $("lut-btn");
  const satBtn = $("saturation-btn");
  if (!lutBtn || !satBtn) return;
  const limited = state.bitDepth < 16;
  const tip = "Upload .raw16 file to use these features";
  if (limited) {
    lutBtn.disabled = true;
    lutBtn.title = tip;
    satBtn.disabled = true;
    satBtn.title = tip;
    // Force the saturation overlay on for 8-bit so the user can spot
    // clipped pixels at a glance. Idempotent if already on. The async
    // fetch + renderAll keeps the UI responsive: on first 8-bit
    // upload, the overlay arrives a few hundred ms after the preview.
    if (!state.showSaturation) {
      state.showSaturation = true;
      loadSaturation().then(() => renderAll()).catch(() => {});
    }
    satBtn.classList.add("toggle-on");
  } else {
    lutBtn.disabled = false;
    // Restore the original tooltip from index.html. We stash it once
    // in a data attribute so re-toggling preserves it.
    lutBtn.title = lutBtn.dataset.defaultTitle || lutBtn.title;
    satBtn.disabled = false;
    satBtn.title = satBtn.dataset.defaultTitle || satBtn.title;
    // Don't auto-toggle off when going from 8-bit to 16-bit (the user
    // could re-load a different file mid-session). Their preference
    // reflects through state.showSaturation as normal.
  }
}

async function loadPreview() {
  const u = new URL(`/api/image/${state.imageId}/preview.png`, window.location.origin);
  u.searchParams.set("min", state.lut.min); u.searchParams.set("max", state.lut.max);
  u.searchParams.set("gamma", state.lut.gamma);
  const resp = await fetch(u.toString());
  if (!resp.ok) { setStatus("Preview load failed.", true); return; }
  const blob = await resp.blob();
  state.imageDataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });
  // If saturation overlay was on, refresh it too — its pixels move with rotation.
  if (state.showSaturation) await loadSaturation();
}

async function loadSaturation() {
  // The saturation overlay uses the SOURCE raw range (not the LUT
  // range) so the markings track only TRULY clipped pixels. An
  // earlier version passed the current LUT max so the threshold
  // followed an auto-stretched preview — that worked for "what does
  // the preview clip to white" but over-marked the gel because
  // many non-saturated bright pixels still appear white in a
  // p1..p99.5 stretch.
  const u = new URL(`/api/image/${state.imageId}/saturation.png`, window.location.origin);
  u.searchParams.set("t", String(Date.now()));
  const resp = await fetch(u.toString());
  if (!resp.ok) { state.satOverlayUrl = null; return; }
  const blob = await resp.blob();
  state.satOverlayUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });
}

// ── Image rotation ───────────────────────────────────────────────────
async function rotateImage(angle) {
  if (!state.imageId) return;
  setStatus(`Rotating ${angle}°…`);
  const resp = await fetch(`/api/image/${state.imageId}/rotate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ angle }),
  });
  if (!resp.ok) { setStatus("Rotate failed: " + (await resp.text()), true); return; }
  const data = await resp.json();
  // Image dimensions may have swapped (90° / 270°). Update state.
  state.imgWidth = data.width; state.imgHeight = data.height;
  // Annotations / region / bands referenced the OLD coordinates. The cleanest
  // thing is to map them through the rotation so they stay where the user
  // visually placed them — but for an MVP we just clear them and ask the user
  // to re-do annotations after rotating. (Common workflow: rotate FIRST, then
  // annotate.) Region is preserved as-is when angle is 0 (no-op call); for
  // 90°/180°/270° we apply the inverse rotation to the region/lane/band
  // coordinates so they follow the image.
  remapAnnotationsForRotation(angle, data.width, data.height);
  await loadPreview();
  setStatus(`Rotated by ${angle}°. New dimensions: ${data.width} × ${data.height}.`);
  rebuildTable(); renderAll();
  commitHistory(`Rotate ${angle}°`);
}

function remapAnnotationsForRotation(angle, newW, newH) {
  // Rotate coordinates (x, y) clockwise by `angle` around the OLD image center.
  // The OLD image center can be inferred from the new dimensions:
  //   90°/270°: dimensions swap, so the OLD width = new height, OLD height = new width.
  //   180°: dimensions same.
  const a = ((angle % 360) + 360) % 360;
  if (a === 0) return;  // identity — no remap needed
  let oldW, oldH;
  if (a === 90 || a === 270) { oldW = newH; oldH = newW; }
  else { oldW = newW; oldH = newH; }
  const map = (x, y) => {
    if (a === 90)  return { x: oldH - y, y: x };
    if (a === 180) return { x: oldW - x, y: oldH - y };
    if (a === 270) return { x: y, y: oldW - x };
    return { x, y };
  };
  // Snapshot OLD region BEFORE we rotate state.region — we need both old
  // and new region to remap bands by their relative position within the
  // region (see comment below).
  const oldRegion = state.region ? { ...state.region } : null;
  // Region (rectangle): map both corners and re-derive (x, y, w, h)
  if (state.region) {
    const r = state.region;
    const c1 = map(r.x, r.y), c2 = map(r.x + r.w, r.y + r.h);
    state.region = {
      x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y),
      w: Math.abs(c2.x - c1.x), h: Math.abs(c2.y - c1.y),
    };
  }
  // Bands — preserve "fraction down the region" so a band at the 25% mark
  // before rotation stays at the 25% mark after. This is lossless under
  // round-trip (90° CW + 90° CCW returns identical bands) and keeps bands
  // visible within the rotated region. Lane index binding is preserved
  // (lane 1's bands stay in lane 1) — meaning after a 90°/270° rotation,
  // bands no longer track the same physical gel feature; users are advised
  // to rotate FIRST, then annotate.
  //
  // The previous implementation tried to map a (lane_center_x, y_center)
  // point through the rotation matrix, but used the NEW lane center (since
  // state.region was already rotated by the time computeLanes() was called)
  // and OLD y_center, mixing coord systems. That collapsed multi-band lanes
  // to a single y and produced negative coords on round-trip.
  if (oldRegion && state.region && oldRegion.h > 0) {
    for (const i of Object.keys(state.bands)) {
      state.bands[i] = state.bands[i].map((b) => {
        const frac = (b.y_center - oldRegion.y) / oldRegion.h;
        const newY = state.region.y + frac * state.region.h;
        return { ...b, y_center: newY };
      });
    }
  }
  // Free-form annotations
  state.annotations.forEach((ann) => {
    const m1 = map(ann.x, ann.y); ann.x = m1.x; ann.y = m1.y;
    if (ann.type === "line") { const m2 = map(ann.x2, ann.y2); ann.x2 = m2.x; ann.y2 = m2.y; }
  });
  // Label overrides — dx/dy are drag offsets in image-px, which rotate as
  // a vector (no translation component).
  const rotVec = (dx, dy) => {
    if (a === 90)  return { dx: -dy, dy: dx };
    if (a === 180) return { dx: -dx, dy: -dy };
    if (a === 270) return { dx: dy, dy: -dx };
    return { dx, dy };
  };
  for (const k of Object.keys(state.labelOverrides)) {
    const o = state.labelOverrides[k];
    if (o.dx || o.dy) {
      const v = rotVec(o.dx || 0, o.dy || 0);
      o.dx = v.dx; o.dy = v.dy;
    }
  }
}

// ── Rotate (Illustrator-style click-and-drag) ────────────────────────
//
// Click Rotate → enter rotation mode. Cursor becomes a crosshair. Click
// and drag anywhere on the SVG to rotate the selection (single annotation,
// multi-selection, or the image if nothing's selected). Angle is computed
// from the drag vector around the selection-bounds center (or image center
// for image rotation). Hold Shift to snap to 15° increments. Esc cancels;
// pointerup commits.
//
// Live preview mutates annotation positions in place during the drag — on
// Esc/cancel we restore the snapshots taken at mode entry.
//
// Image rotation also shows horizontal/vertical alignment guides; element
// rotation does not (the user is positioning text/lines, not orienting a
// gel).

function collectRotationTargetRefs() {
  // Single selection wins if present; otherwise the marquee multi-select.
  // Both free-form annotations and persistent labels are rotatable —
  // labels store their rotation in labelOverrides[key].rotation, which
  // applyOverrideToText emits as a transform on the rendered text.
  // Ladder-band labels (key starts with "band-") are excluded because
  // they don't go through applyOverrideToText.
  if (state.selected) {
    if (state.selected.kind === "annotation") {
      return [{ kind: "annotation", id: state.selected.id }];
    }
    if (state.selected.kind === "label" && !state.selected.key.startsWith("band-")) {
      return [{ kind: "label", key: state.selected.key }];
    }
  }
  if (Array.isArray(state._multiSelected) && state._multiSelected.length) {
    return state._multiSelected.filter((r) =>
      r.kind === "annotation" || (r.kind === "label" && r.key && !r.key.startsWith("band-"))
    );
  }
  return [];
}

function snapshotAnnotationForRotate(ref) {
  // Snapshot enough state to revert if the user cancels the rotation.
  // Annotations: x, y, x2, y2, rotation.
  // Labels: rotation override (stored in labelOverrides[key].rotation).
  if (ref.kind === "annotation") {
    const a = state.annotations.find((x) => x.id === ref.id);
    if (!a) return null;
    return {
      kind: "annotation",
      id: a.id, type: a.type,
      x: a.x, y: a.y, x2: a.x2, y2: a.y2,
      rotation: a.rotation || 0,
    };
  } else if (ref.kind === "label") {
    const ov = getOverride(ref.key);
    return { kind: "label", key: ref.key, rotation: ov.rotation || 0 };
  }
  return null;
}

// For labels, find the rendered SVG text element to get its current
// position. We need this once per rotation entry to set the pivot —
// the renderer hasn't placed labels in image-coords (they live in SVG
// coords, derived from layout state), so we read them off the live DOM.
function getLabelPivotImg(key) {
  const elText = svg.querySelector(`text[data-label-key="${cssEscape(key)}"]`);
  if (!elText) return null;
  let bb;
  try { bb = elText.getBBox(); } catch (_) { return null; }
  const cxSvg = bb.x + bb.width / 2;
  const cySvg = bb.y + bb.height / 2;
  // SVG → image coords (inverse of imgToSvg).
  const L = computeLayout();
  return { x: cxSvg + L.cropX - L.marginLeft, y: cySvg + L.cropY - L.marginTop };
}
function cssEscape(s) {
  // Minimal CSS.escape polyfill for label keys, which can include
  // hyphens and digits but never quotes or special characters.
  return String(s).replace(/(["\\])/g, "\\$1");
}

function computeAnnotationsBoundsCenter(refs) {
  // Selection bounds center used as the rotation pivot. Falls back to
  // (0,0) for the empty-selection edge case (caller should never hit it).
  const xs = [], ys = [];
  refs.forEach((r) => {
    if (r.kind === "annotation") {
      const a = state.annotations.find((x) => x.id === r.id);
      if (!a) return;
      if (a.type === "text") { xs.push(a.x); ys.push(a.y); }
      else if (a.type === "line") { xs.push(a.x, a.x2); ys.push(a.y, a.y2); }
    } else if (r.kind === "label") {
      const p = getLabelPivotImg(r.key);
      if (p) { xs.push(p.x); ys.push(p.y); }
    }
  });
  if (!xs.length) return { x: 0, y: 0 };
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function applyElementRotation(refs, origs, pivot, angleDeg) {
  // Rotate every snapshot's geometry around `pivot` by `angleDeg`,
  // writing the result back to the live annotation. For text, also bump
  // `ann.rotation` so the text orientation tracks the rotation. For
  // lines, only the endpoints rotate — `ann.rotation` (which the
  // renderer applies as a transform around the line's midpoint) stays
  // at the snapshot value because the line's geometry already reflects
  // the new orientation via its endpoints.
  // For LABELS we don't have a free position (labels are anchored to
  // layout-derived points like lane centers), so we only update the
  // rotation override — the renderer applies it via the SVG transform
  // returned from applyOverrideToText.
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  refs.forEach((r, i) => {
    const orig = origs[i]; if (!orig) return;
    if (orig.kind === "label") {
      setOverride(orig.key, { rotation: (orig.rotation || 0) + angleDeg });
      return;
    }
    const a = state.annotations.find((x) => x.id === r.id); if (!a) return;
    if (orig.type === "text") {
      const dx = orig.x - pivot.x, dy = orig.y - pivot.y;
      a.x = pivot.x + dx * cos - dy * sin;
      a.y = pivot.y + dx * sin + dy * cos;
      a.rotation = (orig.rotation || 0) + angleDeg;
    } else if (orig.type === "line") {
      const d1x = orig.x  - pivot.x, d1y = orig.y  - pivot.y;
      const d2x = orig.x2 - pivot.x, d2y = orig.y2 - pivot.y;
      a.x  = pivot.x + d1x * cos - d1y * sin;
      a.y  = pivot.y + d1x * sin + d1y * cos;
      a.x2 = pivot.x + d2x * cos - d2y * sin;
      a.y2 = pivot.y + d2x * sin + d2y * cos;
    }
  });
}

function enterRotateMode() {
  if (!state.imageId) return;
  if (state.rotateMode) { exitRotateMode(false); return; }  // toggle off
  const refs = collectRotationTargetRefs();
  let target, pivot, origs = null;
  if (refs.length) {
    target = "elements";
    pivot = computeAnnotationsBoundsCenter(refs);
    origs = refs.map((r) => snapshotAnnotationForRotate(r));
  } else {
    target = "image";
    const r = state.region;
    pivot = r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 }
              : { x: state.imgWidth / 2, y: state.imgHeight / 2 };
  }
  state.rotateMode = { target, pivot, refs: target === "elements" ? refs : null, origs, angle: 0, dragStart: null };
  document.body.classList.add("tool-rotate");
  rotateBtn().classList.add("toggle-on");
  setStatus(target === "elements"
    ? `Rotate mode: click and drag to rotate ${refs.length} element${refs.length === 1 ? "" : "s"}. Shift = snap 15°. Esc cancels.`
    : "Rotate mode: click and drag to rotate the image. Shift = snap 15°. Esc cancels.");
  renderAll();
}

function exitRotateMode(commit) {
  if (!state.rotateMode) return;
  const m = state.rotateMode;
  state.rotateMode = null;
  document.body.classList.remove("tool-rotate");
  rotateBtn().classList.remove("toggle-on");
  // Cancel: revert any geometry changes made during preview.
  if (!commit || m.angle === 0) {
    if (m.target === "elements" && m.origs) {
      m.origs.forEach((orig) => {
        if (!orig) return;
        if (orig.kind === "label") {
          // Restore the label's rotation override to its pre-drag value.
          // Use setOverride so the {} branch in setOverride still fires
          // when rotation === 0 (which clears the rotation field).
          setOverride(orig.key, { rotation: orig.rotation || 0 });
          return;
        }
        const a = state.annotations.find((x) => x.id === orig.id);
        if (!a) return;
        a.x = orig.x; a.y = orig.y;
        if (orig.type === "line") { a.x2 = orig.x2; a.y2 = orig.y2; }
        a.rotation = orig.rotation;
      });
    }
    renderAll();
    setStatus(commit ? "No rotation applied." : "Rotation cancelled.");
    return;
  }
  // Commit
  if (m.target === "image") {
    rotateImage(m.angle);  // server-side destructive rotation
  } else {
    renderAll();
    commitHistory(`Rotate ${m.refs.length} element${m.refs.length === 1 ? "" : "s"} ${m.angle.toFixed(1)}°`);
  }
  setStatus(`Rotated by ${m.angle.toFixed(1)}°.`);
}

const rotateBtn = () => $("rotate-btn");
$("rotate-btn").addEventListener("click", () => {
  if (state.rotateMode) { exitRotateMode(false); return; }
  enterRotateMode();
});

// ── Lane count ───────────────────────────────────────────────────────
//
// Lane geometry is fully derived from `state.region` + `state.laneCount`
// via `computeLanes()`. There is no separate "lane positions" array — that
// would just go stale every time the region or count changes. Keeping the
// derivation pure means lanes always survive: rotation, region resize,
// region redraw, LUT changes, column additions all just trigger a new
// computeLanes() on the next render.
//
// State that DOES live alongside the count:
//   • state.ladder[i]            — per-lane "is ladder?" flag
//   • state.bands[i]             — per-lane band list (ladder lanes only)
//   • state.cells[colId][i]      — per-lane metadata-cell value, per column
//   • state.labelOverrides[k]    — per-label dx/dy/font/color override
//
// All of the above are pruned on count-shrink so a later grow doesn't
// resurrect data for a "different" lane. labelOverrides are pruned by key
// pattern: lane-num-N and band-N-* go when N is past the new count.

function clampLaneCount(rawInput) {
  // parseInt ignores trailing junk ("5.7" → 5, "abc" → NaN). NaN || 1 → 1.
  // Then clamp to [1, 64] so the rest of the codebase can treat the count
  // as a small positive integer without further validation.
  return Math.max(1, Math.min(64, parseInt(rawInput, 10) || 1));
}

function cleanupStaleLaneLabelOverrides(newLaneCount) {
  // When lanes shrink, drop overrides keyed to the removed lane indices so
  // a subsequent grow doesn't re-apply stale dx/dy/font/color values to
  // what's effectively a NEW lane at that position. Also prune bracket-key
  // overrides whose start/end indices fall outside the new count — those
  // brackets are no longer reachable.
  for (const key of Object.keys(state.labelOverrides)) {
    let m = key.match(/^lane-num-(\d+)$/);
    if (m && parseInt(m[1], 10) >= newLaneCount) { delete state.labelOverrides[key]; continue; }
    m = key.match(/^band-(\d+)-/);
    if (m && parseInt(m[1], 10) >= newLaneCount) { delete state.labelOverrides[key]; continue; }
    // bracket-{colId}-{start}-{end}: drop when end >= newLaneCount.
    m = key.match(/^bracket-.+-(\d+)-(\d+)$/);
    if (m) {
      const end = parseInt(m[2], 10);
      if (end >= newLaneCount) delete state.labelOverrides[key];
    }
  }
}

function cleanupColumnLabelOverrides(deletedColId) {
  // When a column is deleted, drop any label overrides whose keys reference
  // it (row-label-{colId} and bracket-{colId}-*). Without this, the entries
  // become orphaned in state.labelOverrides — bloating saved projects and
  // (in theory) able to resurrect onto a future column with the same id.
  // The colId is escaped because `newId()` only produces "id_NN" but a
  // future change might allow regex metacharacters.
  const escId = deletedColId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rxRow = new RegExp("^row-label-" + escId + "$");
  const rxBracket = new RegExp("^bracket-" + escId + "-\\d+-\\d+$");
  for (const key of Object.keys(state.labelOverrides)) {
    if (rxRow.test(key) || rxBracket.test(key)) delete state.labelOverrides[key];
  }
}

function setLaneCount(rawInput) {
  const n = clampLaneCount(rawInput);
  // Always reflect the canonical value in the input field — covers the
  // edge cases where the user typed "-5" / "abc" / "999" / "" and the
  // clamp landed on the value the state was already at, in which case the
  // early-return below would otherwise leave the input showing junk.
  $("lane-count").value = String(n);
  if (n === state.laneCount) return;

  // Resize per-lane state arrays. New entries default to false / empty.
  state.ladder = Array.from({ length: n }, (_, i) => state.ladder[i] || false);
  for (const col of state.columns) {
    const cur = state.cells[col.id] || [];
    state.cells[col.id] = Array.from({ length: n }, (_, i) => cur[i] || "");
  }
  // Drop bands for removed lanes
  for (const k of Object.keys(state.bands)) {
    if (parseInt(k, 10) >= n) delete state.bands[k];
  }
  // Drop ladder label-dx for removed lanes (so a later grow doesn't
  // resurrect a stale offset on what's now a different lane)
  for (const k of Object.keys(state.ladderLabelDx)) {
    if (parseInt(k, 10) >= n) delete state.ladderLabelDx[k];
  }
  // Drop stale label overrides
  cleanupStaleLaneLabelOverrides(n);
  // Drop selection on removed lanes (and just clear for simplicity — the
  // user can re-select after the resize)
  state.selectedLanes.clear();
  // Reset separators — custom positions don't make sense across a count
  // change (the array length would be wrong, and "lane 3" of 5 is not
  // meaningfully the same as "lane 3" of 4). User can re-customize.
  state.laneSeparators = null;
  state.laneCount = n;
  rebuildTable();
  renderAll();
  // Lane shrink may have removed all ladder lanes — re-evaluate the
  // hide-ladders button state and turn the flag off if needed.
  updateHideLaddersBtn();
  commitHistory(`Set lane count to ${n}`);
}
$("lane-count").addEventListener("change", (e) => setLaneCount(e.target.value));
$("lane-minus").addEventListener("click", () => setLaneCount(state.laneCount - 1));
$("lane-plus").addEventListener("click",  () => setLaneCount(state.laneCount + 1));

// Default inner-separator positions for `n` lanes — even spacing, length n-1.
// e.g. n=4 → [0.25, 0.5, 0.75]. n=1 → []. The two outer "separators" (region
// edges) are always at 0 and 1, so are not stored.
function defaultSeparators(n) {
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => (i + 1) / n);
}

function computeLanes() {
  const r = state.region; if (!r) return [];
  const n = state.laneCount;
  // Use custom separators iff they exist AND match the current lane count.
  // A length mismatch is treated as stale (e.g. user changed lane count
  // before setLaneCount could reset them) — fall back to even.
  const inner = (Array.isArray(state.laneSeparators) && state.laneSeparators.length === n - 1)
    ? state.laneSeparators
    : defaultSeparators(n);
  // Build the full position array so each lane's x_left = positions[i],
  // x_right = positions[i+1]. Edges are pinned to 0 and 1.
  const positions = [0, ...inner, 1];
  return Array.from({ length: n }, (_, i) => ({
    x_left:  r.x + positions[i]     * r.w,
    x_right: r.x + positions[i + 1] * r.w,
  }));
}

// Flank-ladder range: [lo..hi] is the contiguous block of NON-ladder
// (or anywhere-but-flank-ladder) lanes. Used by hide-ladders.
function effectiveLaneRange() {
  const n = state.laneCount;
  let lo = 0; while (lo < n && state.ladder[lo]) lo++;
  let hi = n - 1; while (hi >= lo && state.ladder[hi]) hi--;
  if (lo > hi) return { lo: 0, hi: n - 1 };
  return { lo, hi };
}

// ── Metadata table ───────────────────────────────────────────────────
function rebuildTable() {
  // Rebuilding the table replaces every <td> with a fresh element, so
  // the `.cell-selected` class on the previously-highlighted cells is
  // lost. Clear the range state too — otherwise it stays "armed" but
  // invisible, and the user's next keystroke would fill the OLD range
  // even though no cells appear highlighted anymore. Pointer-driven
  // re-selection rebuilds it cleanly from scratch.
  state._cellRange = null;
  const tbl = $("metadata-table");
  const thead = tbl.querySelector("thead"); const tbody = tbl.querySelector("tbody");
  thead.innerHTML = "";
  const hr = document.createElement("tr");
  hr.appendChild(thRaw('<th style="width:36px">Lane</th>'));
  hr.appendChild(thRaw('<th class="ladder-col" style="width:48px">Ladder</th>'));
  state.columns.forEach((col) => {
    const th = document.createElement("th");
    th.dataset.colid = col.id;
    // draggable=true enables HTML5 drag-and-drop column reordering. The
    // dragstart/dragover/drop handlers in initTableHandlers consume this.
    // While the col-name is in edit mode (contenteditable), we flip
    // draggable=false so text drag-selection inside the editor isn't
    // hijacked by the column drag.
    th.setAttribute("draggable", "true");
    th.classList.add("col-th");
    th.title = "Drag to reorder. Double-click name to rename.";
    th.innerHTML = `<span class="col-del" data-act="del-col" title="Delete this column">×</span>` +
                   `<span class="col-name" contenteditable="false" data-act="rename-col">${escapeHtml(col.name)}</span>`;
    hr.appendChild(th);
  });
  const addTh = document.createElement("th");
  addTh.id = "col-add-btn"; addTh.className = "col-add-header";
  addTh.title = "Add a metadata column (shortcut: +)";
  addTh.textContent = "+";
  hr.appendChild(addTh);
  thead.appendChild(hr);

  // "Show" row — checkboxes controlling which labels render on the gel.
  //   • Lane column: toggles the per-lane number labels (1, 2, 3, …).
  //   • Ladder column: just the "Show" caption (right-aligned), no
  //     checkbox — ladder visibility is governed by the per-row Ladder
  //     checkboxes in tbody, not a column-level toggle.
  //   • User columns: per-column visibility (the bracket row + the
  //     row label that names the column on the gel).
  // Always rendered (even when no user columns exist) so the lane-
  // numbers toggle is always reachable.
  {
    const showTr = document.createElement("tr");
    showTr.className = "show-row";
    // Lane column → checkbox for lane numbers
    const laneCell = document.createElement("th");
    laneCell.className = "show-cell";
    const laneChecked = state.showLaneNumbers !== false;
    laneCell.innerHTML = `<input type="checkbox" data-act="toggle-lane-numbers" title="Show lane numbers (1, 2, 3, …) above the gel" ${laneChecked ? "checked" : ""}>`;
    showTr.appendChild(laneCell);
    // Ladder column → "Show" caption (no checkbox)
    const showLabel = document.createElement("th");
    showLabel.className = "show-row-label";
    showLabel.textContent = "Show";
    showTr.appendChild(showLabel);
    // User columns → per-column visibility checkboxes
    state.columns.forEach((col) => {
      const td = document.createElement("th");
      td.className = "show-cell";
      const checked = isColumnVisible(col.id);
      td.innerHTML = `<input type="checkbox" data-act="toggle-col-visible" data-colid="${col.id}" ${checked ? "checked" : ""}>`;
      showTr.appendChild(td);
    });
    // Empty trailing cell to align with the "+" header.
    const tail = document.createElement("th");
    tail.style.background = "transparent"; tail.style.borderColor = "transparent";
    showTr.appendChild(tail);
    thead.appendChild(showTr);
  }

  tbody.innerHTML = "";
  for (let i = 0; i < state.laneCount; i++) {
    const tr = document.createElement("tr");
    if (state.selectedLanes.has(i)) tr.classList.add("selected");
    const tdLane = document.createElement("td");
    tdLane.className = "lane-num"; tdLane.textContent = String(i + 1);
    tdLane.dataset.row = i; tdLane.dataset.act = "select-lane";
    tr.appendChild(tdLane);
    const tdLad = document.createElement("td"); tdLad.className = "ladder-cell";
    tdLad.innerHTML = `<input type="checkbox" data-row="${i}" data-act="toggle-ladder" ${state.ladder[i] ? "checked" : ""}>`;
    tr.appendChild(tdLad);
    state.columns.forEach((col) => {
      const td = document.createElement("td");
      td.className = "editable"; td.contentEditable = "true";
      td.dataset.row = i; td.dataset.colid = col.id;
      td.textContent = (state.cells[col.id] && state.cells[col.id][i]) || "";
      tr.appendChild(td);
    });
    const tdSp = document.createElement("td");
    tdSp.style.borderColor = "transparent"; tdSp.style.background = "transparent";
    tr.appendChild(tdSp);
    tbody.appendChild(tr);
  }
  updateBandPanel();
  // The quant panel's concentration-column picker and its results table
  // both read from the metadata table, so any structural change here
  // (column added / renamed / deleted, lane count changed) has to be
  // reflected there too.
  if (window.FEMSA) FEMSA.refreshPanel();
}
function thRaw(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }

function initTableHandlers() {
  const tbl = $("metadata-table");
  const thead = tbl.querySelector("thead"); const tbody = tbl.querySelector("tbody");
  thead.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("col-add-header")) return addColumn();
    if (e.target.dataset && e.target.dataset.act === "del-col") {
      const th = e.target.closest("th");
      if (th && th.dataset.colid) deleteColumn(th.dataset.colid);
    }
  });
  // "Show" checkboxes — toggle column visibility / lane numbers. Uses
  // 'change' event so it fires once per state change (click would also
  // fire for label taps and double-counts).
  thead.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.act === "toggle-col-visible") {
      const colid = t.dataset.colid;
      if (!colid) return;
      const col = state.columns.find((c) => c.id === colid);
      state.columnVisible[colid] = !!t.checked;
      renderAll();
      commitHistory(`${t.checked ? "Show" : "Hide"} column${col ? " “" + col.name + "”" : ""}`);
    } else if (t.dataset.act === "toggle-lane-numbers") {
      state.showLaneNumbers = !!t.checked;
      renderAll();
      commitHistory(`${t.checked ? "Show" : "Hide"} lane numbers`);
    }
  });
  thead.addEventListener("dblclick", (e) => {
    const sp = e.target.closest(".col-name");
    if (!sp) return;
    sp.contentEditable = "true"; sp.focus();
    document.getSelection().selectAllChildren(sp);
    // Disable column drag while the name is being edited so the user
    // can drag-select text inside the input. Re-enabled on blur (in
    // the blur handler below).
    const th = sp.closest("th");
    if (th) th.setAttribute("draggable", "false");
  });

  // ── Column drag-and-drop reordering ──────────────────────────────────
  //
  // HTML5 native drag-and-drop is used because the column headers are
  // already discrete elements with stable IDs. The dragstart sets a
  // data transfer payload (the column id), dragover paints a thin blue
  // insertion indicator on the nearest edge of the hovered TH, and
  // drop reorders state.columns and rebuilds.
  //
  // Why not pointer events: the column-name click+rename, the × delete
  // click, and the lane-cell drag-range selection all share the table
  // surface. Native drag has well-defined semantics that don't conflict
  // with those (drag triggers only after a meaningful mouse movement,
  // and only on explicitly draggable elements).
  let __colDragSource = null;  // colid being dragged
  thead.addEventListener("dragstart", (e) => {
    const th = e.target.closest("th.col-th");
    if (!th || th.getAttribute("draggable") !== "true") return;
    __colDragSource = th.dataset.colid;
    th.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require setData() to actually start a drag.
      try { e.dataTransfer.setData("text/plain", __colDragSource); } catch (_) {}
    }
  });
  thead.addEventListener("dragover", (e) => {
    if (!__colDragSource) return;
    const th = e.target.closest("th.col-th");
    if (!th || th.dataset.colid === __colDragSource) return;
    e.preventDefault();  // allow drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    // Remove any old indicator class, then add one based on which
    // half of the TH the pointer is in. left = insert before; right =
    // insert after.
    thead.querySelectorAll(".drop-before, .drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
    const r = th.getBoundingClientRect();
    const inLeftHalf = (e.clientX - r.left) < r.width / 2;
    th.classList.add(inLeftHalf ? "drop-before" : "drop-after");
  });
  thead.addEventListener("dragleave", (e) => {
    // Remove indicator only when leaving the TH entirely. dragover on
    // child elements (col-name span) fires dragleave on the previous
    // child, which would otherwise flicker the indicator.
    const th = e.target.closest("th.col-th");
    if (!th) return;
    if (!th.contains(e.relatedTarget)) {
      th.classList.remove("drop-before", "drop-after");
    }
  });
  thead.addEventListener("drop", (e) => {
    if (!__colDragSource) return;
    const th = e.target.closest("th.col-th");
    if (!th || th.dataset.colid === __colDragSource) return;
    e.preventDefault();
    const r = th.getBoundingClientRect();
    const inLeftHalf = (e.clientX - r.left) < r.width / 2;
    const fromIdx = state.columns.findIndex((c) => c.id === __colDragSource);
    let toIdx = state.columns.findIndex((c) => c.id === th.dataset.colid);
    if (fromIdx < 0 || toIdx < 0) return;
    const moved = state.columns.splice(fromIdx, 1)[0];
    // Compensate for the post-splice index shift if we're inserting after
    // the original position.
    if (fromIdx < toIdx) toIdx--;
    if (!inLeftHalf) toIdx++;
    toIdx = Math.max(0, Math.min(state.columns.length, toIdx));
    state.columns.splice(toIdx, 0, moved);
    rebuildTable(); renderAll();
    commitHistory(`Reorder columns`);
  });
  thead.addEventListener("dragend", () => {
    // Always clear visual state, even if drop happened outside the table.
    __colDragSource = null;
    thead.querySelectorAll(".dragging, .drop-before, .drop-after")
      .forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
  });
  thead.addEventListener("blur", (e) => {
    const sp = e.target.closest && e.target.closest(".col-name");
    if (!sp || sp.contentEditable !== "true") return;
    sp.contentEditable = "false";
    const th = sp.closest("th");
    // Re-enable column drag now that we're out of edit mode.
    if (th) th.setAttribute("draggable", "true");
    const colid = th && th.dataset.colid;
    const col = state.columns.find((c) => c.id === colid);
    if (col) {
      const oldName = col.name;
      const newName = sp.textContent.trim();
      col.name = newName;
      renderAll();
      if (oldName !== newName) commitHistory(`Rename column to “${newName}”`);
    }
  }, true);
  thead.addEventListener("keydown", (e) => {
    const sp = e.target.closest && e.target.closest(".col-name");
    if (!sp || sp.contentEditable !== "true") return;
    if (e.key === "Enter") { e.preventDefault(); sp.blur(); }
    if (e.key === "Escape") {
      const colid = sp.closest("th").dataset.colid;
      const col = state.columns.find((c) => c.id === colid);
      if (col) sp.textContent = col.name;
      sp.blur();
    }
  });
  tbody.addEventListener("click", (e) => {
    if (e.target.dataset && e.target.dataset.act === "toggle-ladder") {
      const row = parseInt(e.target.dataset.row, 10);
      state.ladder[row] = e.target.checked;
      // Bands are NOT deleted on uncheck — keeping them lets the user
      // toggle the ladder flag off and back on without losing their
      // existing band annotations. The renderer skips lanes where
      // ladder[i] is false, so the bands stay in state but invisible.
      // (Previously this `delete state.bands[row]` made unchecking
      // destructive; users complained about losing band labels by
      // mistake.)
      updateBandPanel(); renderAll();
      // The hide-ladders button's enabled state depends on whether ANY
      // lane is a ladder — re-evaluate on every toggle.
      updateHideLaddersBtn();
      commitHistory(`${e.target.checked ? "Mark" : "Unmark"} lane ${row + 1} as ladder`);
      return;
    }
    const td = e.target.closest("td.lane-num");
    if (td) {
      const row = parseInt(td.dataset.row, 10);
      if (e.shiftKey && state.selectedLanes.size) {
        const cur = [...state.selectedLanes];
        const lo = Math.min(...cur, row), hi = Math.max(...cur, row);
        state.selectedLanes = new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      } else if (e.ctrlKey || e.metaKey) {
        if (state.selectedLanes.has(row)) state.selectedLanes.delete(row);
        else state.selectedLanes.add(row);
      } else {
        state.selectedLanes = new Set([row]);
      }
      tbody.querySelectorAll("tr").forEach((tr, i) => tr.classList.toggle("selected", state.selectedLanes.has(i)));
      updateBandPanel();
    }
  });
  tbody.addEventListener("input", (e) => {
    const td = e.target.closest("td.editable"); if (!td) return;
    const row = parseInt(td.dataset.row, 10); const colid = td.dataset.colid;
    const value = td.textContent;
    if (!state.cells[colid]) state.cells[colid] = Array(state.laneCount).fill("");
    // Multi-cell fill via rectangular range (drag-selected): typing in any
    // cell of the range updates ALL cells in the range. Takes precedence
    // over the row-level multi-select since it's a tighter, more recent
    // gesture.
    const r = state._cellRange;
    if (r) {
      const r1 = Math.min(r.startRow, r.endRow);
      const r2 = Math.max(r.startRow, r.endRow);
      const c1 = Math.min(r.startCol, r.endCol);
      const c2 = Math.max(r.startCol, r.endCol);
      const cells = (r2 - r1 + 1) * (c2 - c1 + 1);
      if (cells > 1) {
        for (let rr = r1; rr <= r2; rr++) {
          for (let cc = c1; cc <= c2; cc++) {
            const cid = state.columns[cc]?.id;
            if (!cid) continue;
            if (!state.cells[cid]) state.cells[cid] = Array(state.laneCount).fill("");
            state.cells[cid][rr] = value;
          }
        }
        // Mirror the typed value into every other selected cell's DOM so
        // the user sees the fill happen in real-time.
        tbody.querySelectorAll("td.editable.cell-selected").forEach((other) => {
          if (other !== td) other.textContent = value;
        });
        renderAll();
        return;
      }
    }
    // Lane-level multi-select fill (existing): Shift-click on lane
    // numbers populates state.selectedLanes; typing fills all selected.
    if (state.selectedLanes.size > 1 && state.selectedLanes.has(row)) {
      for (const i of state.selectedLanes) state.cells[colid][i] = value;
      tbody.querySelectorAll(`td.editable[data-colid="${CSS.escape(colid)}"]`).forEach((other) => {
        const r = parseInt(other.dataset.row, 10);
        if (r !== row && state.selectedLanes.has(r)) other.textContent = value;
      });
    } else {
      state.cells[colid][row] = value;
    }
    renderAll();
  });
  tbody.addEventListener("keydown", (e) => {
    const td = e.target.closest("td.editable"); if (!td) return;
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const row = parseInt(td.dataset.row, 10); const colid = td.dataset.colid;
      const targetRow = e.shiftKey ? row - 1 : row + 1;
      const next = tbody.querySelector(`tr:nth-child(${targetRow + 1}) td.editable[data-colid="${CSS.escape(colid)}"]`);
      if (next) next.focus(); else td.blur();
    }
  });
  // ── Cell range selection ────────────────────────────────────────────
  //
  // The metadata table supports a spreadsheet-style multi-cell selection:
  // drag from one cell to another to highlight a rectangular range, then
  // type in any cell of the range to fill all cells with the same value.
  //
  // Selection lifecycle (mirrors Excel/Google Sheets conventions):
  //   • Pointerdown on a cell that is OUTSIDE any active range
  //         → clear the range. The clicked cell becomes the new
  //           single-cell selection (which may grow into a real range
  //           on pointermove).
  //   • Pointerdown on a cell INSIDE the active range
  //         → keep the range. Useful so the user can drag, then click
  //           any of the highlighted cells to type-fill all of them.
  //   • Pointermove during a drag, to a different cell
  //         → extend the range and re-highlight.
  //   • Pointerup
  //         → finalize. If the pointer never moved, the click is
  //           treated as a single-cell focus (no range).
  //   • Focusin (e.g. Tab/Enter navigation, programmatic focus)
  //         → if the focused cell is outside the active range, clear
  //           the range. Tab WITHIN a range preserves it so type-fill
  //           keeps working as the user moves through cells.
  //
  // Why these specific rules: the previous implementation only cleared
  // the range when the click was on a cell that ALSO had a single-cell
  // range from a prior click — multi-cell ranges from a prior drag
  // never cleared. So clicking another cell after a drag would leave
  // the old range hot, and typing in the new cell would fill the OLD
  // range (visibly modifying cells the user wasn't pointing at).
  let _cellRangeDrag = null;
  function clearCellRange() {
    state._cellRange = null;
    tbody.querySelectorAll("td.editable.cell-selected")
      .forEach((td) => td.classList.remove("cell-selected"));
  }
  function highlightCellRange() {
    tbody.querySelectorAll("td.editable.cell-selected")
      .forEach((td) => td.classList.remove("cell-selected"));
    if (!state._cellRange) return;
    const r = state._cellRange;
    const r1 = Math.min(r.startRow, r.endRow);
    const r2 = Math.max(r.startRow, r.endRow);
    const c1 = Math.min(r.startCol, r.endCol);
    const c2 = Math.max(r.startCol, r.endCol);
    for (let row = r1; row <= r2; row++) {
      for (let col = c1; col <= c2; col++) {
        const cid = state.columns[col]?.id;
        if (!cid) continue;
        const td = tbody.querySelector(`td.editable[data-row="${row}"][data-colid="${CSS.escape(cid)}"]`);
        if (td) td.classList.add("cell-selected");
      }
    }
  }
  function isCellInRange(row, colIdx) {
    const r = state._cellRange;
    if (!r) return false;
    const r1 = Math.min(r.startRow, r.endRow), r2 = Math.max(r.startRow, r.endRow);
    const c1 = Math.min(r.startCol, r.endCol), c2 = Math.max(r.startCol, r.endCol);
    return row >= r1 && row <= r2 && colIdx >= c1 && colIdx <= c2;
  }
  tbody.addEventListener("pointerdown", (e) => {
    const td = e.target.closest("td.editable"); if (!td) return;
    if (e.button !== 0) return;  // left only
    const row = parseInt(td.dataset.row, 10);
    const colid = td.dataset.colid;
    const colIdx = state.columns.findIndex((c) => c.id === colid);
    if (colIdx < 0) return;
    // Clear an existing range if the click landed OUTSIDE it. Inside
    // clicks keep the range so the user can type-fill all selected
    // cells with one keystroke after a drag.
    if (state._cellRange && !isCellInRange(row, colIdx)) {
      clearCellRange();
    }
    _cellRangeDrag = {
      startRow: row, startCol: colIdx,
      pointerId: e.pointerId,
      didMove: false,
    };
    // Don't preventDefault — let the cell focus naturally for
    // single-click typing. If the user drags, we'll set state._cellRange
    // below; the browser's text-selection within the cell doesn't
    // disrupt anything (range fills are driven by input events, which
    // fire either way).
  });
  tbody.addEventListener("pointermove", (e) => {
    if (!_cellRangeDrag) return;
    if (_cellRangeDrag.pointerId !== e.pointerId) return;
    const td = e.target.closest("td.editable"); if (!td) return;
    const row = parseInt(td.dataset.row, 10);
    const colid = td.dataset.colid;
    const colIdx = state.columns.findIndex((c) => c.id === colid);
    if (colIdx < 0) return;
    // Establish or extend the range as soon as the pointer hits a
    // DIFFERENT cell from where it started. A single click on the
    // start cell with no movement → didMove stays false, no range.
    if (row === _cellRangeDrag.startRow && colIdx === _cellRangeDrag.startCol) {
      if (!state._cellRange) return;  // no movement yet, nothing to extend
    }
    _cellRangeDrag.didMove = true;
    state._cellRange = {
      startRow: _cellRangeDrag.startRow, startCol: _cellRangeDrag.startCol,
      endRow: row, endCol: colIdx,
    };
    highlightCellRange();
  });
  // pointerup is on document so a release outside the table still
  // ends the drag cleanly. If the pointer never moved (single click),
  // any range we may have inherited from a prior drag was already
  // cleared in pointerdown when the click landed outside it.
  document.addEventListener("pointerup", () => {
    if (_cellRangeDrag) _cellRangeDrag = null;
  });

  // Cell edit history: snapshot cells on focus-in, commit on focus-out IF
  // anything changed. Bundles continuous typing into one undo entry per
  // cell. Each character keystroke fires `input` (which mutates state.cells
  // and re-renders) — but only the focusout commits to history.
  let _cellEditSnap = null;
  tbody.addEventListener("focusin", (e) => {
    const td = e.target.closest("td.editable");
    if (!td) return;
    // Tab / Enter / programmatic focus that lands OUTSIDE the active
    // multi-cell range clears the range. This mirrors spreadsheet UX:
    // navigating away from the selection treats the new cell as a
    // single-cell edit. Focus that stays WITHIN the range keeps it
    // so the user can keep type-filling as they Tab across cells.
    if (state._cellRange) {
      const row = parseInt(td.dataset.row, 10);
      const colid = td.dataset.colid;
      const colIdx = state.columns.findIndex((c) => c.id === colid);
      if (colIdx >= 0 && !isCellInRange(row, colIdx)) {
        clearCellRange();
      }
    }
    _cellEditSnap = JSON.stringify(state.cells);
  });
  tbody.addEventListener("focusout", (e) => {
    const td = e.target.closest("td.editable");
    if (!td) return;
    if (_cellEditSnap !== null && JSON.stringify(state.cells) !== _cellEditSnap) {
      commitHistory("Edit cell");
      // A cell edit may have changed a protein concentration, which
      // changes which lanes are included and every f_bound the quant
      // panel shows. Cheap to refresh; wrong to leave stale.
      if (window.FEMSA) FEMSA.refreshPanel();
    }
    _cellEditSnap = null;
  });

  tbody.addEventListener("paste", (e) => {
    const td = e.target.closest("td.editable"); if (!td) return;
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    if (/[\t\n]/.test(text)) {
      e.preventDefault(); e.stopPropagation();
      pasteTSV(td, text);
    } else {
      e.preventDefault(); document.execCommand("insertText", false, text);
    }
  });
}

function addColumn() {
  // No prompt — create immediately with an empty name + auto-focus the
  // header span as contenteditable so the user can type the name inline.
  // The existing thead "blur" handler commits the rename to history;
  // typing nothing leaves the column nameless (acceptable: header shows
  // a "(no title)" placeholder via CSS).
  const id = newId();
  state.columns.push({ id, name: "" });
  state.cells[id] = Array(state.laneCount).fill("");
  rebuildTable(); renderAll();
  commitHistory("Add column");
  // Trigger inline-edit on the new header. Defer with setTimeout so the
  // table rebuild has flushed to DOM before we focus into it.
  setTimeout(() => {
    const sp = document.querySelector(`th[data-colid="${CSS.escape(id)}"] .col-name`);
    if (!sp) return;
    sp.contentEditable = "true"; sp.focus();
    document.getSelection().selectAllChildren(sp);
  }, 0);
}
function deleteColumn(colid) {
  if (!confirm("Delete this column and all its values?")) return;
  const colName = state.columns.find(c => c.id === colid)?.name || "";
  state.columns = state.columns.filter((c) => c.id !== colid);
  delete state.cells[colid];
  delete state.columnVisible[colid];
  cleanupColumnLabelOverrides(colid);
  rebuildTable(); renderAll();
  commitHistory(`Delete column${colName ? " “" + colName + "”" : ""}`);
}
function pasteTSV(startTd, text) {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  const startRow = parseInt(startTd.dataset.row, 10);
  const startCol = state.columns.findIndex((c) => c.id === startTd.dataset.colid);
  if (startCol < 0) return;
  rows.forEach((line, dr) => {
    const cells = line.split("\t");
    cells.forEach((val, dc) => {
      const r = startRow + dr; const c = state.columns[startCol + dc];
      if (!c || r >= state.laneCount) return;
      if (!state.cells[c.id]) state.cells[c.id] = Array(state.laneCount).fill("");
      state.cells[c.id][r] = val;
    });
  });
  rebuildTable(); renderAll();
  commitHistory("Paste cells");
}

function bracketsForColumn(colid) {
  const arr = state.cells[colid] || [];
  const out = []; let i = 0;
  while (i < state.laneCount) {
    const v = (arr[i] || "").trim();
    if (!v) { i++; continue; }
    let j = i;
    while (j + 1 < state.laneCount && (arr[j + 1] || "").trim() === v) j++;
    out.push({ start: i, end: j, label: v });
    i = j + 1;
  }
  return out;
}

// ── Smart bracket-label rotation ─────────────────────────────────────
//
// When a column's labels are wider than the brackets they sit above,
// adjacent labels collide. Rather than truncating, we rotate the whole
// column's labels so they read at an angle (45° for moderate overflow,
// 90° for severe). The whole column rotates together so the figure
// looks consistent — mixing rotated and un-rotated labels in one row
// looks chaotic.
//
// Width measurement uses a single hidden 2-D canvas — no DOM mutation
// required, so it's safe to call during layout (before any element
// is in the SVG). The font string MUST match what we set on the SVG
// text element exactly, otherwise the predicted width drifts and we
// rotate too aggressively / not enough.
let __measureCanvas = null;
function measureTextWidth(text, fontPx, fontFamily, fontWeight) {
  if (!text) return 0;
  if (!__measureCanvas) __measureCanvas = document.createElement("canvas");
  const ctx = __measureCanvas.getContext("2d");
  ctx.font = `${fontWeight || "normal"} ${fontPx}px ${fontFamily || "Arial, Helvetica, sans-serif"}`;
  return ctx.measureText(text).width;
}

// For each column, return { rotated, rowHeight } describing the
// per-label rotation decision and how tall the column's row needs to be.
//   rotated  — Set of bracket keys (`${g.start}-${g.end}`) that should
//              render at 90° (vertical). Keys NOT in the set render
//              horizontally.
//   rowHeight — px reserved for this column's row, accommodating the
//              tallest rotated label (if any).
//
// Algorithm — minimum-rotation greedy:
//   1. Compute each label's un-rotated horizontal extent at its
//      bracket-center cx, half-width = textWidth / 2 + small pad.
//   2. Walk adjacent label pairs (sorted by cx). If they overlap,
//      rotate the WIDER label; this is usually the one that's actually
//      causing the collision. Re-walk after each change because
//      rotating one label changes its width and may resolve / create
//      new overlaps with neighbors. The loop terminates because a
//      rotated label has width = fontPx (a constant), so once both
//      sides of a pair are rotated the only remaining option is to
//      mark them and move on.
//   3. Default rotation angle = 90° (vertical). Earlier versions used
//      45° for "modest overflow"; the user prefers a single,
//      predictable orientation, and 90° gives the minimum footprint
//      so it's the clear winner.
//
// Why "wider one of the pair": rotating the narrower of the two
// usually doesn't resolve overlap if the wide label overhangs into
// the next bracket. Rotating the wide one collapses its horizontal
// footprint and frees space for both.
function computeColumnLayout(lanes) {
  const fs = state.fontPx;
  const PAD = 4;          // SVG-px padding around each label's extent
  const ROT_HALF_W = fs * 0.6 + PAD;  // post-rotation half horizontal width
  return state.columns.map((col) => {
    // Hidden columns claim NO vertical space — the renderer collapses
    // them out of the row stack so the remaining columns sit closer to
    // the gel rather than leaving a phantom gap. Smart rotation also
    // skips them since there's nothing to lay out.
    if (!isColumnVisible(col.id)) {
      return { rotated: new Set(), rowHeight: 0 };
    }
    const grouping = bracketsForColumn(col.id);
    if (!grouping.length) {
      return { rotated: new Set(), rowHeight: state.rowHeight };
    }
    // Build label info, in image coords (which equal SVG coords up to a
    // translation, so widths compare directly). Individually-deleted
    // bracket labels are excluded from the overlap check — there's
    // nothing to collide with if it's not being rendered.
    const labelInfos = grouping.map((g) => {
      const sl = lanes[g.start], el = lanes[g.end];
      if (!sl || !el) return null;
      const bkey = `bracket-${col.id}-${g.start}-${g.end}`;
      if (isLabelHidden(bkey)) return null;
      return {
        key: `${g.start}-${g.end}`,
        cx: (sl.x_left + el.x_right) / 2,
        textW: measureTextWidth(g.label, fs),
        rotated: false,
      };
    }).filter(Boolean);
    if (!labelInfos.length) return { rotated: new Set(), rowHeight: state.rowHeight };
    labelInfos.sort((a, b) => a.cx - b.cx);

    const halfW = (lbl) => (lbl.rotated ? ROT_HALF_W : lbl.textW / 2 + PAD);
    const rightOf = (lbl) => lbl.cx + halfW(lbl);
    const leftOf  = (lbl) => lbl.cx - halfW(lbl);

    // Iterative greedy: while ANY adjacent pair overlaps, rotate the
    // wider (un-rotated) of the pair. Bounded by 2× labels.length
    // (worst case rotates every label).
    let safety = labelInfos.length * 2 + 4;
    let progress = true;
    while (progress && safety-- > 0) {
      progress = false;
      for (let i = 0; i < labelInfos.length - 1; i++) {
        const a = labelInfos[i], b = labelInfos[i + 1];
        if (rightOf(a) <= leftOf(b)) continue;  // no overlap
        // Pick the wider un-rotated label to rotate. If both are already
        // rotated, accept the residual overlap (very rare; only happens
        // when bracket centers are physically too close even for vertical
        // text).
        if (!a.rotated && (!b.rotated ? a.textW >= b.textW : true)) {
          a.rotated = true; progress = true; break;
        } else if (!b.rotated) {
          b.rotated = true; progress = true; break;
        }
      }
    }

    const rotated = new Set(labelInfos.filter((l) => l.rotated).map((l) => l.key));
    let rowHeight = state.rowHeight;
    if (rotated.size > 0) {
      const maxRotW = labelInfos
        .filter((l) => l.rotated)
        .reduce((m, l) => Math.max(m, l.textW), 0);
      // 90° rotation: vertical span equals textWidth. Add fontSize
      // (descender allowance + bracket-line clearance) and a few px
      // padding for visual breathing room.
      rowHeight = Math.max(state.rowHeight, maxRotW + fs + 6);
    }
    return { rotated, rowHeight };
  });
}

// ── Layout ───────────────────────────────────────────────────────────
function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    e.setAttribute(k, String(v));
  }
  if (text != null) e.textContent = text;
  return e;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// Resolve the visible-image bounds (image-coord rectangle) from the three
// modes that can apply, IN PRECEDENCE ORDER:
//   1. hideLadders (with at least one flank ladder) — collapse horizontally
//      to just the inner non-ladder lanes. Vertical bounds stay = region.
//   2. croppedToRegion — clip to exactly the user's region.
//   3. otherwise (default after Draw region) — show the FULL image with
//      the region drawn as an overlay outline.
//
// Returned `cropped` is true if any clipping is in effect. The caller
// uses this to decide whether to attach a clip-path to the <image> and to
// shrink the canvas dimensions accordingly.
function resolveCropBounds() {
  const r = state.region;
  if (!r) return { cropX: 0, cropY: 0, cropW: state.imgWidth, cropH: state.imgHeight, cropped: false };
  if (state.hideLadders) {
    // Compute inner range using the original (uncollapsed) lane geometry.
    const lns = computeLanesRaw(r);
    const { lo, hi } = effectiveLaneRange();
    if (lns[lo] && lns[hi]) {
      return { cropX: lns[lo].x_left, cropY: r.y, cropW: lns[hi].x_right - lns[lo].x_left, cropH: r.h, cropped: true };
    }
    // No flank ladders to mask → fall through to region/full
  }
  if (state.croppedToRegion) {
    return { cropX: r.x, cropY: r.y, cropW: r.w, cropH: r.h, cropped: true };
  }
  return { cropX: 0, cropY: 0, cropW: state.imgWidth, cropH: state.imgHeight, cropped: false };
}

// computeLanes() resolves separators/region from `state` (and would also
// pick up a hide-ladders collapse if the renderer were to mutate region).
// We need a variant that takes the region directly so resolveCropBounds
// can compute the collapse without recursion.
function computeLanesRaw(r) {
  const n = state.laneCount;
  const inner = (Array.isArray(state.laneSeparators) && state.laneSeparators.length === n - 1)
    ? state.laneSeparators
    : defaultSeparators(n);
  const positions = [0, ...inner, 1];
  return Array.from({ length: n }, (_, i) => ({
    x_left:  r.x + positions[i]     * r.w,
    x_right: r.x + positions[i + 1] * r.w,
  }));
}

function computeLayout() {
  const r = state.region;
  const { cropX, cropY, cropW, cropH, cropped } = resolveCropBounds();
  const tickRowH = state.fontPx + state.tickHeight + 6;
  // Per-column row heights — rotated columns reserve more vertical space
  // than the default state.rowHeight. Falls back to N × default when the
  // region isn't drawn yet (lanes can't be resolved without a region).
  const lanesForLayout = r ? computeLanes() : null;
  const colInfo = lanesForLayout ? computeColumnLayout(lanesForLayout)
                                 : state.columns.map(() => ({ rotated: new Set(), rowHeight: state.rowHeight }));
  const colsH = colInfo.reduce((a, c) => a + c.rowHeight, 0);
  const reservedAbove = colsH + tickRowH + 10;

  // Base margins.
  //
  // When NOT cropped (region drawn on the full image), the canvas is the
  // entire image plus a small bracket area above — annotations have
  // tons of natural breathing room because the canvas is large.
  //
  // When CROPPED, the canvas shrinks to the cropped region plus margins.
  // The default 70px side / 30px bottom margins leave very little room
  // for free-form text / lines / ladder labels that sit OUTSIDE the
  // gel — the user's labels get clipped off the canvas. Bumping these
  // gives substantial working room (300 px on each side, 100 px below)
  // without unbounded growth on the happy path.
  const baseSideMargin   = cropped ? 300 : state.marginLeft;
  const baseBottomMargin = cropped ? 100 : state.marginBottom;
  // marginTop is the SVG y where the full image starts. Bracket + tick
  // rows render ABOVE the REGION TOP — when cropped, region top = image
  // top so we need reservedAbove space above the image. When NOT cropped,
  // the region sits LOWER in the image (region.y > 0 typically), so
  // bracket rows can occupy the area above the region INSIDE the image
  // pixels (the user typically draws a region that excludes the top
  // wells/loading area, so overlaying brackets there is fine).
  const baseMarginTop = (cropped || !r) ? reservedAbove : Math.max(0, reservedAbove - r.y);

  // Auto-expand the canvas to fit any annotation that extends past the
  // base margins. This is the "unlimited working space" fallback: drag a
  // text label way outside the gel, the canvas grows to keep it visible
  // (and exportable). Negative SVG-coords are NOT supported — the
  // origin stays at (0, 0) — so growth pushes outward by widening the
  // appropriate margin (or shrinking nothing).
  const PAD = 30;  // visual padding between the outermost annotation and the canvas edge
  const baseCanvasW = cropW + baseSideMargin * 2;
  const baseCanvasH = cropH + baseMarginTop + baseBottomMargin;
  let extraLeft = 0, extraRight = 0, extraTop = 0, extraBottom = 0;
  for (const ann of state.annotations) {
    const fs = ann.fontSize || state.fontPx;
    let xs, ys;
    if (ann.type === "text") {
      // Rough text bounding box. text-anchor=middle so it spans
      // cx ± textWidth/2; height ≈ fontSize.
      const tw = (ann.text || "").length * fs * 0.6 + 4;
      xs = [ann.x - tw / 2, ann.x + tw / 2];
      ys = [ann.y - fs / 2, ann.y + fs / 2];
    } else if (ann.type === "line") {
      xs = [ann.x, ann.x2 ?? ann.x];
      ys = [ann.y, ann.y2 ?? ann.y];
    } else {
      continue;
    }
    // Project image-coord bbox into base SVG coords.
    const sxMin = baseSideMargin + (Math.min(...xs) - cropX);
    const sxMax = baseSideMargin + (Math.max(...xs) - cropX);
    const syMin = baseMarginTop  + (Math.min(...ys) - cropY);
    const syMax = baseMarginTop  + (Math.max(...ys) - cropY);
    if (sxMin < PAD)               extraLeft   = Math.max(extraLeft,   PAD - sxMin);
    if (sxMax > baseCanvasW - PAD) extraRight  = Math.max(extraRight,  sxMax - (baseCanvasW - PAD));
    if (syMin < PAD)               extraTop    = Math.max(extraTop,    PAD - syMin);
    if (syMax > baseCanvasH - PAD) extraBottom = Math.max(extraBottom, syMax - (baseCanvasH - PAD));
  }

  const marginLeft   = baseSideMargin   + extraLeft;
  const marginRight  = baseSideMargin   + extraRight;
  const marginTop    = baseMarginTop    + extraTop;
  const marginBottom = baseBottomMargin + extraBottom;

  return {
    marginLeft, marginTop, marginRight, marginBottom,
    cropX, cropY, cropW, cropH, tickRowH, cropped,
    canvasW: cropW + marginLeft + marginRight,
    canvasH: cropH + marginTop  + marginBottom,
    // Stash colInfo so the renderer can reuse it without recomputing.
    colInfo,
  };
}
const imgToSvgX = (L, x) => L.marginLeft + (x - L.cropX);
const imgToSvgY = (L, y) => L.marginTop  + (y - L.cropY);
function clientToImage(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svg.getScreenCTM(); if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());
  const L = computeLayout();
  return { x: local.x - L.marginLeft + L.cropX, y: local.y - L.marginTop + L.cropY };
}

// ── Label override helpers ───────────────────────────────────────────
function getOverride(key) { return state.labelOverrides[key] || {}; }
function setOverride(key, patch) {
  state.labelOverrides[key] = { ...getOverride(key), ...patch };
}
function clearOverride(key) { delete state.labelOverrides[key]; }
// True when the user has explicitly hidden (deleted) this label.
// Lane numbers and bracket / row labels are always re-rendered from
// layout state, so a "delete" persists by setting this flag — the
// renderer just skips elements whose key is hidden.
function isLabelHidden(key) {
  return !!(state.labelOverrides[key] && state.labelOverrides[key].hidden);
}
// True when the column should render (default). False only if the user
// unchecked the "Show" box for this column in the metadata table.
function isColumnVisible(colid) {
  return state.columnVisible[colid] !== false;
}
// Apply font/color overrides + dx/dy to a freshly-built text element. The
// override transforms the SAME element the renderer painted, so once it's
// in the live SVG it exports identically. dx/dy are in image-px (1 SVG
// viewBox unit) so they survive zoom changes.
function applyOverrideToText(textEl, key, defaultFs, defaultColor) {
  const ov = getOverride(key);
  if (ov.fontSize) textEl.setAttribute("font-size", String(ov.fontSize));
  if (ov.color)    textEl.setAttribute("fill",      ov.color);
  // User-applied rotation (from rotate mode on a selected label). The
  // rotation is around the text's anchor point — for a label that's
  // text-anchor=middle at (cx, cy), rotation pivots around that point
  // naturally. For text-anchor=end (already-rotated bracket labels),
  // the user's additional rotation composes with the auto-rotation.
  if (ov.rotation) {
    const x = parseFloat(textEl.getAttribute("x") || "0");
    const y = parseFloat(textEl.getAttribute("y") || "0");
    const cur = textEl.getAttribute("transform") || "";
    textEl.setAttribute("transform", `rotate(${ov.rotation}, ${x}, ${y}) ${cur}`.trim());
  }
  if (ov.dx || ov.dy) {
    const tx = ov.dx || 0, ty = ov.dy || 0;
    const cur = textEl.getAttribute("transform") || "";
    // Prepend translate so it's applied AFTER any pre-existing transform
    // (in SVG coordinate-space order: rightmost transform is applied
    // first; leftmost last). For rotated bracket labels, the rotation
    // must run in the un-shifted bracket-center frame, then the user's
    // drag (dx, dy) is added on top in screen space. If we appended
    // translate, the drag would be applied in the rotated frame, so a
    // vertical drag would visually move the label diagonally.
    textEl.setAttribute("transform", `translate(${tx} ${ty}) ${cur}`.trim());
  }
  // Mark the element so click handlers can identify it as draggable.
  textEl.classList.add("label");
  textEl.dataset.labelKey = key;
  if ((state.selected && state.selected.kind === "label" && state.selected.key === key)
      || isInMultiSelected("label", key)) {
    textEl.classList.add("selected");
  }
  return textEl;
}

// Render a band label as a foreignObject + HTML <input> for inline edit.
// Width is fixed; the input is positioned so its anchor edge lands at the
// label's anchor x — exactly where the SVG text would have sat. The
// foreignObject carries data-export-hide so SVG/PNG exports drop the
// editor (the user is expected to commit before exporting anyway).
//
// Why foreignObject + HTML <input> instead of contenteditable on the
// text element directly: native <input> gets caret + IME + selection
// handling for free, and `isTextEntryFocused()` already excludes INPUT
// from shortcut handling. SVG contenteditable support varies by browser.
function renderBandLabelEditor(labelSvgX, labelSvgY, anchor, laneIdx, band) {
  const W = 90, H = state.fontPx + 8;
  // Foreign-object x is the LEFT edge of the box. Match the anchor:
  //   "end"   → label x sits at right edge of input  → fo.x = labelX - W
  //   "start" → label x sits at left edge            → fo.x = labelX
  //   "middle"→ centered                             → fo.x = labelX - W/2
  const fox = anchor === "end" ? labelSvgX - W : anchor === "start" ? labelSvgX : labelSvgX - W / 2;
  // Center the input's vertical-middle on labelSvgY (the leader / tick
  // line). View-mode SVG <text> uses default "alphabetic" baseline:
  // its y attribute sits at labelSvgY + fontPx/3, but the VISUAL
  // CENTER of digit-heavy ladder labels lands essentially at
  // labelSvgY (within ~1 px). The HTML <input> inside the
  // foreignObject centers its text on the foreignObject's vertical
  // middle (foy + H/2), so we want foy + H/2 == labelSvgY.
  //
  // The previous expression added an extra `+ state.fontPx / 3`
  // term, which placed the input ~6 px below the SVG text it was
  // replacing — so clicking a band label to edit it made the label
  // visually JUMP downward by a third of a font-height, and editing
  // committed a value that appeared to belong to a different band.
  // This was the "band annotations appear offset" glitch.
  const foy = labelSvgY - H / 2;
  const fo = el("foreignObject", {
    x: fox, y: foy, width: W, height: H,
    "data-export-hide": "true",
  });
  // Use a plain HTMLInputElement (foreignObject hosts XHTML, but for an
  // input element document.createElement is fine since the input element
  // implicitly upgrades to the right namespace inside foreignObject).
  const input = document.createElement("input");
  input.type = "text";
  input.value = band.label;
  input.setAttribute("data-band-lane", String(laneIdx));
  input.setAttribute("data-band-id", band.id);
  // Style: match the label's font + alignment so the user feels like
  // they're editing in place.
  input.style.cssText = [
    "width: 100%", "height: 100%", "box-sizing: border-box",
    "font-family: Arial, Helvetica, sans-serif",
    `font-size: ${state.fontPx}px`,
    `text-align: ${anchor === "end" ? "right" : anchor === "start" ? "left" : "center"}`,
    "padding: 0 3px", "border: 1px solid #3d8be0",
    "background: rgba(255, 255, 255, 0.95)", "color: #000",
    "outline: none",
  ].join("; ");
  // Commit on Enter / blur, cancel on Escape. clearEditingBand handles
  // the state transition + re-render so we don't leave a stale foreign-
  // object in the DOM.
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commitBandEdit(input.value); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancelBandEdit(); }
    // Stop bubbling so the global keydown handler doesn't see this and
    // try to handle Esc / Enter / shortcut letters at the same time.
    ev.stopPropagation();
  });
  input.addEventListener("blur", () => { commitBandEdit(input.value); });
  fo.appendChild(input);
  svg.appendChild(fo);
  // Auto-focus + select-all so the user can immediately overtype "?"
  // without having to clear it first. Run on next tick so the foreign-
  // object is laid out by the browser before focus hits.
  setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 0);
}

function commitBandEdit(newValue) {
  if (!state._editingBand) return;
  const { laneIdx, bandId } = state._editingBand;
  state._editingBand = null;
  const lane = state.bands[laneIdx]; if (!lane) { renderAll(); return; }
  const band = lane.find((b) => b.id === bandId); if (!band) { renderAll(); return; }
  const trimmed = (newValue || "").trim();
  // EMPTY commit removes the band entirely (label + tick + leader). This
  // gives the user a one-keystroke delete: click the "?" label, clear
  // the field, press Enter — both the inline label and the in-lane tick
  // disappear together. Same effect as the band-panel's × button.
  if (trimmed === "") {
    state.bands[laneIdx] = lane.filter((b) => b.id !== bandId);
    renderAll(); updateBandPanel();
    commitHistory(`Delete band${band.label ? " “" + band.label + "”" : ""}`);
    return;
  }
  const oldLabel = band.label;
  band.label = trimmed;
  renderAll(); updateBandPanel();
  if (band.label !== oldLabel) commitHistory(`Rename band to “${band.label}”`);
}

function cancelBandEdit() {
  if (!state._editingBand) return;
  state._editingBand = null;
  renderAll();
}

// ── Renderer ─────────────────────────────────────────────────────────
// True when a color is a dark background (perceived luminance < 0.5) using the
// Rec. 601 luma weights. Drives the choice of default ink in render() so labels
// stay readable on any chosen background. Accepts #rgb / #rrggbb.
function isBgDark(hex) {
  let s = (hex || "").toString().trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length !== 6) return false;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

function renderAll() {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!state.imageId) {
    svg.setAttribute("viewBox", "0 0 600 200");
    svg.style.width = "600px";
    return;
  }
  const L = computeLayout();
  svg.setAttribute("viewBox", `0 0 ${L.canvasW} ${L.canvasH}`);
  svg.setAttribute("width",  L.canvasW);
  // Base CSS width = "fit-to-container with 1200px cap", same as before.
  // Multiply by zoom scale so the wheel handler can grow / shrink the
  // visible canvas while leaving the viewBox + image-coord math intact.
  // preserveAspectRatio="xMidYMid meet" keeps the aspect ratio so we
  // only need to set width — height is computed by the browser.
  const baseWidth = Math.min(L.canvasW, 1200);
  svg.style.width = (baseWidth * (state._zoomScale || 1)) + "px";

  // Paper/background color: the user-chosen bgColor, else automatic (white,
  // or #1a1a1a when inverted). Default ink (structural lines + labels) then
  // adapts to the background's luminance so it stays readable on whatever
  // color is chosen — generalising the old invert-keyed swap. In every
  // pre-existing case (bgColor unset) this is identical to before.
  const bgFill = state.bgColor || (state.invertImage ? "#1a1a1a" : "#ffffff");
  const ink = isBgDark(bgFill) ? "#ffffff" : "#000000";

  // Background
  svg.appendChild(el("rect", { x: 0, y: 0, width: L.canvasW, height: L.canvasH, fill: bgFill }));

  // Image
  //
  // The image is ALWAYS rendered at its natural width × height. If a region
  // is set, the image is offset by (-cropX, -cropY) so the region's top-left
  // lands at (marginLeft, marginTop), then a clip-path is applied so only
  // the region's pixels are visible — exactly mirroring the saturation
  // overlay below. Without this, drawing a region used to render the full
  // image at width=cropW, height=cropH, which (with preserveAspectRatio="none")
  // squashed the entire image into the region rectangle — i.e. drawing a
  // region "distorted" the image instead of cropping it. We use SVG's <defs>
  // + <clipPath> rather than CSS clip-path: inset() so the clip survives
  // when the SVG is serialized for export.
  // Image
  //
  // The image is ALWAYS rendered at its natural width × height with the
  // top-left positioned so image-coord (cropX, cropY) lands at canvas
  // (marginLeft, marginTop). When `L.cropped` is true a clip-path
  // restricts the visible pixels to that crop rectangle; when false the
  // full image shows.
  //
  // Three modes resolved by resolveCropBounds():
  //   • Default after Draw region (croppedToRegion=false, hideLadders=false)
  //     → cropped=false. Full image visible; region drawn as overlay outline.
  //   • Crop to region toggled on → clipped to user's region rectangle.
  //   • Hide ladders on with flank ladders → clipped to inner non-flank
  //     lanes; vertical bounds = region.
  //
  // SVG <defs>+<clipPath> rather than CSS clip-path: inset() so the clip
  // survives serialization for export.
  if (state.imageDataUrl) {
    if (L.cropped) {
      const defs = el("defs");
      const cp = el("clipPath", { id: "region-clip", clipPathUnits: "userSpaceOnUse" });
      cp.appendChild(el("rect", {
        x: L.marginLeft, y: L.marginTop, width: L.cropW, height: L.cropH,
      }));
      defs.appendChild(cp);
      svg.appendChild(defs);
    }
    const im = el("image", {
      x: L.marginLeft - L.cropX, y: L.marginTop - L.cropY,
      width: state.imgWidth, height: state.imgHeight,
      href: state.imageDataUrl, preserveAspectRatio: "none",
    });
    if (L.cropped) im.setAttribute("clip-path", "url(#region-clip)");
    if (state.invertImage) im.setAttribute("style", "filter: invert(1)");
    // Live image-rotation preview: while the rotate popover is open with
    // target="image", apply transform="rotate(angle, cx, cy)" around the
    // image's display center. The transform is on the live element only —
    // committing the rotation goes through /api/image/{id}/rotate which
    // produces a NEW imageDataUrl. data-export-hide is NOT set because if
    // the user exports while previewing, the transform survives.
    if (state.rotateMode && state.rotateMode.target === "image" && state.rotateMode.angle !== 0) {
      const cx = L.marginLeft + L.cropW / 2;
      const cy = L.marginTop  + L.cropH / 2;
      im.setAttribute("transform", `rotate(${state.rotateMode.angle} ${cx} ${cy})`);
    }
    svg.appendChild(im);
  }

  // Alignment indicators — only during IMAGE rotation preview. Helps the
  // user line a feature up to true horizontal/vertical. Stripped from
  // exports (the user is expected to commit before exporting).
  if (state.rotateMode && state.rotateMode.target === "image") {
    const cx = L.marginLeft + L.cropW / 2;
    const cy = L.marginTop  + L.cropH / 2;
    const stroke = state.invertImage ? "#5cb1ff" : "#3d8be0";
    const guideAttrs = {
      stroke, "stroke-width": 1, "stroke-dasharray": "4 3",
      "data-role": "rotate-guide", "data-export-hide": "true",
      "pointer-events": "none",
    };
    // Horizontal center line
    svg.appendChild(el("line", { ...guideAttrs, x1: L.marginLeft, y1: cy, x2: L.marginLeft + L.cropW, y2: cy }));
    // Vertical center line
    svg.appendChild(el("line", { ...guideAttrs, x1: cx, y1: L.marginTop, x2: cx, y2: L.marginTop + L.cropH }));
    // Outer rectangle showing the original (un-rotated) image bounds.
    svg.appendChild(el("rect", {
      x: L.marginLeft, y: L.marginTop, width: L.cropW, height: L.cropH,
      fill: "none", stroke, "stroke-width": 1, "stroke-dasharray": "2 4",
      "data-role": "rotate-guide", "data-export-hide": "true",
      "pointer-events": "none",
    }));
  }

  // Saturation overlay (between gel image and other layers). Same
  // positioning + clip-path treatment as the gel image so it always
  // aligns with the visible region. Renders even before a region has
  // been drawn — for 8-bit images, the overlay flags clipped pixels
  // across the WHOLE image so the user can spot bad exposure
  // immediately on upload.
  if (state.showSaturation && state.satOverlayUrl) {
    const overlay = el("image", {
      x: L.marginLeft - L.cropX, y: L.marginTop - L.cropY,
      width: state.imgWidth, height: state.imgHeight,
      href: state.satOverlayUrl, preserveAspectRatio: "none",
      "data-role": "saturation-overlay",
    });
    if (L.cropped) overlay.setAttribute("clip-path", "url(#region-clip)");
    svg.appendChild(overlay);
  }

  // Region outline.
  //
  // When CROPPED (croppedToRegion or hide-ladders collapse), the outline
  // traces the visible gel edge. When NOT cropped, the outline is drawn
  // at the region's image-coord position so the user can see exactly
  // which area is being analyzed even though the full image is visible.
  //
  // The outline is also a click target: clicking it sets _regionSelected,
  // which reveals the corner resize handles and accents the outline blue.
  // Click elsewhere to deselect (corner handles disappear).
  if (state.region && state.regionOutline) {
    // Region border has its own dedicated thickness (Options → Region
    // border thickness). Fall back to the global strokeWidth if the
    // user hasn't set it, so existing projects keep their look.
    const sw = state.regionBorderWidth || state.strokeWidth, half = sw / 2;
    let rx, ry, rw, rh;
    if (L.cropped) {
      rx = L.marginLeft + half;
      ry = L.marginTop  + half;
      rw = L.cropW - sw;
      rh = L.cropH - sw;
    } else {
      rx = imgToSvgX(L, state.region.x) + half;
      ry = imgToSvgY(L, state.region.y) + half;
      rw = state.region.w - sw;
      rh = state.region.h - sw;
    }
    const isRegionSelected = !!state._regionSelected;
    // Visible outline (exported as part of the figure).
    svg.appendChild(el("rect", {
      x: rx, y: ry, width: rw, height: rh,
      fill: "none",
      stroke: isRegionSelected ? "#3d8be0" : ink,
      "stroke-width": isRegionSelected ? sw + 1 : sw,
    }));
    // Invisible wider hit-stroke so the outline is easy to click on
    // exactly. pointer-events: stroke means only the BORDER catches
    // events — clicks inside the region fall through to whatever is
    // there (annotation, marquee, etc.).
    svg.appendChild(el("rect", {
      x: rx - 4, y: ry - 4, width: rw + 8, height: rh + 8,
      fill: "none", stroke: "transparent", "stroke-width": 8,
      "data-role": "region-outline",
      "data-export-hide": "true",
      "pointer-events": "stroke",
      style: "cursor: pointer;",
    }));
  }

  // Lane ticks + lane numbers
  const lanes = computeLanes();

  // The "gel top" in canvas Y — where lane ticks/brackets/labels anchor.
  // When cropped, this equals marginTop (because cropY == region.y → the
  // region's top sits at the top of the visible gel area). When not
  // cropped, the region is BELOW the image top (region.y > 0 typically),
  // and the lane-tick row sits ABOVE the region — overlaying any image
  // pixels in the region.y..0 strip, which the user has already excluded
  // from the analysis area.
  const gelTopSvg    = state.region ? imgToSvgY(L, state.region.y) : L.marginTop;
  const gelBottomSvg = state.region ? imgToSvgY(L, state.region.y + state.region.h) : L.marginTop + L.cropH;
  const gelHeight    = gelBottomSvg - gelTopSvg;

  // fEMSA quantification rows. Drawn after the gel + region outline so
  // the measurement boxes sit visibly on top of the bands they
  // integrate, but before the marquee so a selection drag still reads
  // as the topmost thing on the canvas.
  if (window.FEMSA) FEMSA.render(L, lanes, ink);

  // Marquee rectangle (live during multi-element selection drag). Drawn
  // last so it appears over annotations + labels. data-export-hide
  // strips it from PNG/SVG exports.
  if (typeof drag !== "undefined" && drag && drag.kind === "marquee") {
    const x1i = Math.min(drag.startImg.x, drag.curImg.x);
    const y1i = Math.min(drag.startImg.y, drag.curImg.y);
    const x2i = Math.max(drag.startImg.x, drag.curImg.x);
    const y2i = Math.max(drag.startImg.y, drag.curImg.y);
    const sx = imgToSvgX(L, x1i), sy = imgToSvgY(L, y1i);
    const sw = imgToSvgX(L, x2i) - sx, sh = imgToSvgY(L, y2i) - sy;
    if (sw > 0 && sh > 0) {
      svg.appendChild(el("rect", {
        x: sx, y: sy, width: sw, height: sh,
        fill: state.invertImage ? "#5cb1ff" : "#3d8be0",
        "fill-opacity": "0.10",
        stroke: state.invertImage ? "#5cb1ff" : "#3d8be0",
        "stroke-width": 1, "stroke-dasharray": "4 3",
        "data-role": "marquee", "data-export-hide": "true",
        "pointer-events": "none",
      }));
    }
  }

  // "Armed" ladder-lane highlight — paint a faint overlay over the active
  // ladder lane's gel area so the user knows where to click. Runtime-only
  // (data-export-hide stripped from PNG/SVG exports).
  if (state._bandTargetLane != null
      && state.ladder[state._bandTargetLane]
      && state.region
      && lanes[state._bandTargetLane]) {
    const lane = lanes[state._bandTargetLane];
    const x = imgToSvgX(L, lane.x_left);
    const w = imgToSvgX(L, lane.x_right) - x;
    svg.appendChild(el("rect", {
      x, y: gelTopSvg, width: w, height: gelHeight,
      fill: state.invertImage ? "#5cb1ff" : "#3d8be0",
      "fill-opacity": "0.12",
      "data-role": "band-target-highlight",
      "data-export-hide": "true",
      "pointer-events": "none",
    }));
  }
  if (lanes.length) {
    const tickBottom = gelTopSvg, tickTop = gelTopSvg - state.tickHeight;
    const { lo, hi } = effectiveLaneRange();
    // Render ALL n+1 tick positions in one pass so each gets a hit-rect
    // with the correct data attributes. The visible <line> is `pointer-
    // events: none` so the hit-rect (sized 12 × tickH+12) catches drags
    // even when the user clicks slightly off the thin line.
    //   - tick-idx 0..n      ⇒ all tick positions (height drag enabled)
    //   - sep-idx  0..n-2    ⇒ INNER separators only (horizontal drag
    //                          adjusts state.laneSeparators[sep-idx])
    // Outer ticks (i=0 and i=n) have no sep-idx; they're region edges and
    // are moved via the region's resize handles, not the tick handles.
    const tickPositions = [];
    lanes.forEach((lane, i) => {
      tickPositions.push({ tickIdx: i,         x: lane.x_left,  laneIdx: i,            isOuter: i === 0 });
      if (i === lanes.length - 1)
        tickPositions.push({ tickIdx: i + 1,   x: lane.x_right, laneIdx: i,            isOuter: true });
    });
    // Two-pass: first pass paints all the tick lines + click-to-select
    // hit-rects so the user can pick any tick. Second pass paints the
    // square handles ON TOP of every visible tick — but only when SOME
    // tick is currently selected. The square handles are draggable;
    // dragging one vertically changes height for ALL ticks (because
    // tickHeight is shared); dragging one horizontally moves only that
    // tick's separator. The "all ticks have a square" pattern is the
    // visual cue that height is global / synchronous across ticks.
    const someSelected = state._selectedTick !== null;
    // Region edges in SVG coords — used to clamp outer-tick hit-rects and
    // squares so they don't overhang the region width. Inner ticks have
    // their hit areas centered on the line because they're naturally
    // inside the region; outer ticks (region edges) get their handles
    // INSET so the visual stays within the analysis area.
    // Region edges in SVG coords. When the layout is CROPPED (cropped-
    // to-region or hide-ladders collapse), `L.marginLeft` and
    // `L.marginLeft + L.cropW` are the LIVE visible-gel edges; use them
    // directly so the outer ticks align to whatever the outline is
    // tracing right now. When NOT cropped, the visible gel = full
    // image and the region is a sub-rect — translate the region's
    // image-space x into SVG coords.
    const regionLeftSvg = L.cropped
      ? L.marginLeft
      : (state.region ? imgToSvgX(L, state.region.x) : L.marginLeft);
    const regionRightSvg = L.cropped
      ? L.marginLeft + L.cropW
      : (state.region ? imgToSvgX(L, state.region.x + state.region.w) : L.marginLeft + L.cropW);
    tickPositions.forEach(({ tickIdx, x, laneIdx, isOuter }) => {
      // When hide-ladders is on, the visible region is collapsed to the
      // inner non-flank-ladder x-range. Only ticks at the new region
      // edges (lo, hi+1) and the inner separators (lo..hi) should render.
      if (state.hideLadders) {
        if (tickIdx < lo || tickIdx > hi + 1) return;
      }
      // Identify the LEFT-MOST and RIGHT-MOST currently-visible ticks.
      // Without hideLadders, those are tickIdx 0 and lanes.length. With
      // hideLadders, the flank ladder lanes are masked so the outer
      // visible ticks are at tickIdx === lo (left of inner range) and
      // tickIdx === hi + 1 (right of inner range). The flush-to-outline
      // shift must follow whichever ticks are currently rendered as the
      // gel boundary; otherwise the original outermost ticks are hidden
      // and the new edge ticks land at their un-shifted natural lane x,
      // overhanging the now-collapsed outline.
      const isVisibleLeftTick  = state.hideLadders ? (tickIdx === lo) : (tickIdx === 0);
      const isVisibleRightTick = state.hideLadders ? (tickIdx === hi + 1) : (tickIdx === lanes.length);
      // Compute the rendered X for this tick. For visible-outer ticks,
      // shift inward by half the stroke width so the tick line sits
      // FLUSH with the region outline instead of overhanging outside
      // it. The visible region outline has its centerline at
      // (regionLeftSvg + sw/2, regionRightSvg - sw/2); aligning the
      // tick's centerline with the outline's centerline makes them
      // coincide. Inner ticks stay at their natural lane-edge x.
      // (We use the REGION BORDER thickness for the inset, since that's
      // the outline we're aligning to — not the tick's own thickness.)
      const tickSw = state.tickWidth || state.strokeWidth;
      const regionSw = state.regionBorderWidth || state.strokeWidth;
      const sxNatural = imgToSvgX(L, x);
      const halfSw = regionSw / 2;
      let sx;
      if (isVisibleLeftTick) sx = regionLeftSvg + halfSw;
      else if (isVisibleRightTick) sx = regionRightSvg - halfSw;
      else sx = sxNatural;
      const isSelected = state._selectedTick === tickIdx;

      // Hit-target for click-to-select. 12 px wide, centered on the tick
      // line — except outer ticks, where the rect is shifted INWARD so
      // it stays entirely within the region width (no overhang into the
      // canvas margin).
      const HIT_W = 12;
      let hitX;
      if (isVisibleLeftTick) hitX = regionLeftSvg;                          // pin to inside-left
      else if (isVisibleRightTick) hitX = regionRightSvg - HIT_W;           // pin to inside-right
      else hitX = sx - HIT_W / 2;                                           // centered
      const hit = el("rect", {
        x: hitX, y: tickTop - 6, width: HIT_W, height: state.tickHeight + 12,
        fill: "transparent",
        "data-tick-idx": String(tickIdx),
        "data-export-hide": "true",
        style: "cursor: pointer;",
      });
      if (!isOuter) hit.dataset.sepIdx = String(tickIdx - 1);
      svg.appendChild(hit);

      // Visible tick line. The CLICKED tick is recolored + fattened so
      // the user can see which tick they last touched (relevant for
      // sep-move, which is per-tick). Width comes from the dedicated
      // `tickWidth` option (Options → Tick thickness), falling back to
      // the global strokeWidth.
      svg.appendChild(el("line", {
        x1: sx, y1: tickBottom, x2: sx, y2: tickTop,
        stroke: isSelected ? "#3d8be0" : ink,
        "stroke-width": isSelected ? tickSw + 1 : tickSw,
        "pointer-events": "none",
      }));

      // Square handle at the TIP of the tick. Appears on EVERY visible
      // tick whenever ANY tick is selected — so the user sees that
      // dragging any one square will adjust ALL tick heights together
      // (tickHeight is shared state). Horizontal drag on a square
      // moves only that tick's separator; vertical drag adjusts the
      // shared height. Outer ticks (region edges) have no separator,
      // so their square is height-only.
      if (someSelected) {
        const SIZE = 9;
        // Same inset logic as the hit-rect: outer-tick squares stay
        // pinned to the inside of the region edge, inner-tick squares
        // are centered on their line. Keeps the visual within the
        // region width.
        let sqX;
        if (isVisibleLeftTick) sqX = regionLeftSvg;
        else if (isVisibleRightTick) sqX = regionRightSvg - SIZE;
        else sqX = sx - SIZE / 2;
        const sq = el("rect", {
          x: sqX, y: tickTop - SIZE - 1,
          width: SIZE, height: SIZE,
          fill: isSelected ? "#3d8be0" : "#ffffff",
          stroke: "#000", "stroke-width": 1.5,
          "data-tick-handle": "square",
          "data-tick-idx": String(tickIdx),
          "data-export-hide": "true",
          style: isOuter ? "cursor: ns-resize;" : "cursor: move;",
        });
        if (!isOuter) sq.dataset.sepIdx = String(tickIdx - 1);
        svg.appendChild(sq);
      }
    });
    // Lane numbers (one per lane, centered above the lane's tick row).
    // Whole row gated on the "Show" checkbox in the Lane column.
    if (state.showLaneNumbers !== false) {
      lanes.forEach((lane, i) => {
        const masked = state.hideLadders && state.ladder[i] && (i < lo || i > hi);
        if (masked) return;
        const key = `lane-num-${i}`;
        // Skip lane numbers the user has explicitly deleted. Re-show via
        // undo or by clearing the override programmatically.
        if (isLabelHidden(key)) return;
        const cx = imgToSvgX(L, (lane.x_left + lane.x_right) / 2);
        const t = el("text", {
          x: cx, y: tickTop - 4,
          "text-anchor": "middle",
          "font-family": "Arial, Helvetica, sans-serif",
          "font-size": state.fontPx, fill: ink,
        }, String(i + 1));
        svg.appendChild(applyOverrideToText(t, key, state.fontPx, ink));
      });
    }
  }

  // Bracket rows — anchor to the GEL TOP (= imgToSvgY(region.y)) so they
  // sit just above the analysis area, not at the canvas top. Identical to
  // the old behavior when cropped (gelTop == marginTop).
  // Stack columns from the gel upward using per-column row heights.
  // colInfo[ridx] = { rotated: Set, rowHeight }. We position each
  // column's baseline (rowY) at its row CENTER so the bracket line
  // and label stay vertically centered in their allocated band.
  const colInfo = L.colInfo || state.columns.map(() => ({ rotated: new Set(), rowHeight: state.rowHeight }));
  // Cumulative offset from gel top, in SVG px.
  const rowYByCol = new Array(state.columns.length);
  {
    let cum = L.tickRowH;
    for (let ridx = state.columns.length - 1; ridx >= 0; ridx--) {
      const h = (colInfo[ridx] && colInfo[ridx].rowHeight) || state.rowHeight;
      rowYByCol[ridx] = gelTopSvg - cum - h / 2;
      cum += h;
    }
  }
  // Row label x: just LEFT of the region, not the image. When the
  // layout is CROPPED these are the same point (the image IS the
  // region). When NOT cropped, the region is a sub-rect of the
  // visible image — anchoring the row label to L.marginLeft would
  // park it at the IMAGE's left edge, which can be hundreds of px
  // away from the bracket row above the region. The bracket itself
  // already tracks the region (via imgToSvgX on the lane positions),
  // so this fix re-aligns the row label with its brackets.
  const rowLabelXBase = state.region
    ? (L.cropped ? L.marginLeft : imgToSvgX(L, state.region.x))
    : L.marginLeft;
  state.columns.forEach((col, ridx) => {
    // Skip the entire column if the user un-checked its "Show" box in
    // the metadata table. computeColumnLayout returned rowHeight=0 for
    // hidden columns, so the rowY computation above already collapsed
    // their vertical space.
    if (!isColumnVisible(col.id)) return;
    const rowY = rowYByCol[ridx];
    const rotatedSet = (colInfo[ridx] && colInfo[ridx].rotated) || new Set();
    // Row label — only render if the user hasn't deleted it.
    const rkey = `row-label-${col.id}`;
    if (!isLabelHidden(rkey)) {
      const rt = el("text", {
        x: rowLabelXBase - 10, y: rowY + 5,
        "text-anchor": "end",
        "font-family": "Arial, Helvetica, sans-serif",
        "font-size": state.fontPx, "font-weight": 600, fill: ink,
      }, col.name);
      svg.appendChild(applyOverrideToText(rt, rkey, state.fontPx, ink));
    }
    // Brackets
    const { lo: brkLo, hi: brkHi } = effectiveLaneRange();
    bracketsForColumn(col.id).forEach((g) => {
      const sl = lanes[g.start], el2 = lanes[g.end];
      if (!sl || !el2) return;
      // When hide-ladders is on, skip brackets that fall ENTIRELY on
      // collapsed flank lanes — otherwise they'd render off to the side
      // of the visible (shrunken) gel.
      if (state.hideLadders && (g.end < brkLo || g.start > brkHi)) return;
      const bkey = `bracket-${col.id}-${g.start}-${g.end}`;
      // Skip individually-deleted brackets. Bracket LINE for a deleted
      // label also disappears (the line's role is to connect the label
      // to the lanes it spans — without the label it's noise).
      if (isLabelHidden(bkey)) return;
      const xa = imgToSvgX(L, sl.x_left), xb = imgToSvgX(L, el2.x_right);
      const SHORT = 4, x1 = xa + SHORT, x2 = xb - SHORT, cx = (x1 + x2) / 2;
      if (g.start !== g.end) {
        const lineAttrs = {
          x1, y1: rowY, x2, y2: rowY,
          stroke: ink, "stroke-width": state.strokeWidth,
          "stroke-linecap": state.lineCap,
        };
        if (state.bracketLineStyle === "dashed") lineAttrs["stroke-dasharray"] = "6,4";
        svg.appendChild(el("line", lineAttrs));
      }
      // Per-label rotation: only labels in `rotatedSet` (those that
      // would otherwise overlap a neighbor) render vertically. The
      // rest stay horizontal at the bracket center.
      const isMulti = g.start !== g.end;
      const isRotated = rotatedSet.has(`${g.start}-${g.end}`);
      let textAttrs;
      if (!isRotated) {
        textAttrs = {
          x: cx, y: isMulti ? rowY - 5 : rowY + state.fontPx / 3,
          "text-anchor": "middle",
        };
      } else {
        // 90° vertical: anchor at the bracket pivot, text extends
        // upward from the pivot. text-anchor=end so the rendered
        // text's right edge (post-rotation, the BOTTOM) sits at the
        // pivot.
        const py = isMulti ? rowY - 4 : rowY + state.fontPx / 3;
        textAttrs = {
          x: cx, y: py,
          "text-anchor": "end",
          transform: `rotate(-90, ${cx}, ${py})`,
        };
      }
      const bt = el("text", {
        ...textAttrs,
        "font-family": "Arial, Helvetica, sans-serif",
        "font-size": state.fontPx, fill: ink,
      }, g.label);
      svg.appendChild(applyOverrideToText(bt, bkey, state.fontPx, ink));
    });
  });

  // Ladder bands.
  //
  // Geometry:
  //   • Each band has a y_center in image coords. Dragging the LABEL
  //     vertically updates band.y_center directly so the in-lane marker,
  //     the leader, and the label all move together.
  //   • Each LADDER LANE has a shared horizontal label offset
  //     state.ladderLabelDx[laneIdx] (image-px). All labels in that lane
  //     share the same x — dragging one drags them all → labels stay in
  //     a vertical column.
  //   • The LEADER line connects the label to the nearest gel edge. As
  //     the user drags labels left/right, the leader switches sides
  //     automatically when the label crosses the gel midline.
  //   • text-anchor flips based on the label's actual x relative to the
  //     gel center: labels left of gel → "end" (right-aligned), labels
  //     right of gel → "start" (left-aligned).
  // Right-flank ladders default their labels to the RIGHT side of the
  // gel; LEFT-flank and INTERNAL ladders default to the LEFT side.
  // (Internal ladders sit in the middle of the data lanes, so a label
  // at the lane center would obscure adjacent bands; the user wants
  // those leader-line'd out to the LEFT of the gel.) The shared dx
  // override still lets the user push labels around per-lane.
  const { lo: edgeLo, hi: edgeHi } = effectiveLaneRange();
  // Region edges in SVG coords for ladder-label anchoring. Mirrors the
  // outer-tick logic above: when CROPPED, the visible-gel edges are
  // already at (L.marginLeft, L.marginLeft + L.cropW). When NOT cropped
  // the full image is shown but the user's REGION is a sub-rect — we
  // want labels next to the REGION (defines the gel area being
  // analyzed), not the image margins which include flanking
  // un-analyzed pixels. Without this, a region drawn on a wider scan
  // gets its labels stranded far from the lanes.
  const regionLeftSvgL = L.cropped
    ? L.marginLeft
    : (state.region ? imgToSvgX(L, state.region.x) : L.marginLeft);
  const regionRightSvgL = L.cropped
    ? L.marginLeft + L.cropW
    : (state.region ? imgToSvgX(L, state.region.x + state.region.w) : L.marginLeft + L.cropW);
  const regionCenterSvgL = (regionLeftSvgL + regionRightSvgL) / 2;
  for (let i = 0; i < state.laneCount; i++) {
    if (!state.ladder[i]) continue;
    const lane = lanes[i]; if (!lane) continue;
    const bands = state.bands[i] || []; if (!bands.length) continue;
    const isRightFlank = i > edgeHi;
    const defaultOnLeft = !isRightFlank;
    // Default label x sits just outside the REGION on the chosen side.
    // The user's shared dx adds to that.
    const defaultOuterSvg = defaultOnLeft ? regionLeftSvgL : regionRightSvgL;
    const defaultLabelSvgX = defaultOuterSvg + (defaultOnLeft ? -state.bandLeaderGap : state.bandLeaderGap);
    const sharedDxImg = state.ladderLabelDx[i] || 0;
    const labelSvgX = defaultLabelSvgX + sharedDxImg;
    // Auto-orient: anchor depends on where the LABEL ends up, not where
    // the lane is. Cross the midline → anchor flips.
    const labelOnLeft = labelSvgX < regionCenterSvgL;
    const anchor = labelOnLeft ? "end" : "start";
    // Leader stops near the label, on the region-side closest to the label.
    const gelEdgeSvg = labelOnLeft ? regionLeftSvgL : regionRightSvgL;
    const leaderEndSvg = labelSvgX + (labelOnLeft ? 4 : -4);
    const lx = imgToSvgX(L, lane.x_left), rx = imgToSvgX(L, lane.x_right);
    const { lo, hi } = effectiveLaneRange();
    const isFlank = state.hideLadders && (i < lo || i > hi);
    bands.forEach((band) => {
      const y = imgToSvgY(L, band.y_center);
      // In-lane tick marker — runtime-only visual cue showing the
      // detected band position. Carries data-export-hide="true" so it's
      // stripped from PNG/SVG exports: the published figure should show
      // the GEL with its size labels + leaders + outer tick, but NOT
      // the blue overlay highlighting where the band was found
      // (otherwise readers see a band annotation for raw gel content
      // they're already looking at). Skipped entirely when this lane's
      // gel is masked by hide-ladders.
      if (!isFlank) {
        svg.appendChild(el("line", {
          x1: lx, y1: y, x2: rx, y2: y,
          stroke: state.invertImage ? "#5cb1ff" : "#3d8be0",
          "stroke-width": state.strokeWidth,
          "data-export-hide": "true",
        }));
      }
      // Leader line — gel edge → just before label
      svg.appendChild(el("line", {
        x1: gelEdgeSvg, y1: y, x2: leaderEndSvg, y2: y,
        stroke: ink, "stroke-width": Math.max(1, state.strokeWidth - 0.5),
      }));
      // Label — either an editable HTML input (foreignObject) when this
      // band is in edit mode, or an SVG text element otherwise.
      const key = `band-${i}-${band.id}`;
      const editing = state._editingBand && state._editingBand.laneIdx === i && state._editingBand.bandId === band.id;
      if (editing) {
        renderBandLabelEditor(labelSvgX, y, anchor, i, band);
      } else {
        const t = el("text", {
          x: labelSvgX, y: y + state.fontPx / 3,
          "text-anchor": anchor,
          "font-family": "Arial, Helvetica, sans-serif",
          "font-size": state.fontPx, fill: ink,
          "data-band-lane": String(i), "data-band-id": band.id,
        }, band.label);
        // Store the lane idx on the element so the drag handler knows which
        // lane's shared dx to update (without rescanning state.bands).
        t.classList.add("label", "ladder-band-label");
        t.dataset.labelKey = key;
        // Selected highlight: show on either single (state.selected) or
        // multi (_multiSelected) selection. Without the multi-select arm,
        // a marquee that picked up several bands wouldn't visually
        // distinguish them — making it impossible to confirm what Delete
        // would remove.
        const selectedSingle = state.selected && state.selected.kind === "label" && state.selected.key === key;
        const selectedMulti  = isInMultiSelected("label", key);
        if (selectedSingle || selectedMulti) {
          t.classList.add("selected");
        }
        svg.appendChild(t);
      }
    });
  }

  // Free-form annotations.
  //
  // Rotation: each annotation can carry `ann.rotation` (degrees, default 0)
  // applied as transform="rotate(deg, cx, cy)" around the element's center.
  // For text, that's the anchor (ann.x, ann.y); for lines, the midpoint.
  // The Illustrator-style rotate mode mutates ann.x/y/x2/y2/rotation
  // directly during the drag, so the renderer just reads the live values.
  // No special preview-target path is needed.
  state.annotations.forEach((ann) => {
    const rot = ann.rotation || 0;
    if (ann.type === "text") {
      const cx = imgToSvgX(L, ann.x);
      const cy = imgToSvgY(L, ann.y);
      // Empty + currently-pending text annotation: show a dashed-outline
      // placeholder rect so the user sees that a text box exists at the
      // click position even though no characters have been typed yet.
      // Once any character is entered, ann.text becomes non-empty and
      // the placeholder disappears (the rect predicate fails). The rect
      // carries data-export-hide so it can never leak into PNG/SVG output.
      const isPending = state.pendingTextAnn === ann.id;
      const isEmpty = !ann.text || ann.text.length === 0;
      if (isPending && isEmpty) {
        const fs = ann.fontSize || state.fontPx;
        // Box big enough to hint the typing area: ~60 wide × 1.4×fontSize tall,
        // centered on the click point. It's dashed + 30% opacity blue so it
        // reads as a placeholder, not a real annotation.
        const W = 60, H = fs * 1.4;
        svg.appendChild(el("rect", {
          x: cx - W / 2, y: cy - H / 2,
          width: W, height: H,
          fill: "none", stroke: state.invertImage ? "#5cb1ff" : "#3d8be0",
          "stroke-width": 1, "stroke-dasharray": "4 3",
          "data-role": "pending-text-placeholder",
          "data-export-hide": "true",
          "pointer-events": "none",
        }));
      }
      const t = el("text", {
        x: cx, y: cy + (ann.fontSize || state.fontPx) / 3,
        "text-anchor": "middle",
        "font-family": "Arial, Helvetica, sans-serif",
        "font-size": ann.fontSize || state.fontPx,
        fill: ann.color || ink,
      }, ann.text || "");
      if (rot) t.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);
      t.classList.add("annotation");
      t.dataset.annId = ann.id;
      if ((state.selected && state.selected.kind === "annotation" && state.selected.id === ann.id)
          || isInMultiSelected("annotation", ann.id)) t.classList.add("selected");
      svg.appendChild(t);
    } else if (ann.type === "line") {
      const x1 = imgToSvgX(L, ann.x), y1 = imgToSvgY(L, ann.y);
      const x2 = imgToSvgX(L, ann.x2), y2 = imgToSvgY(L, ann.y2);
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const lineAttrs = {
        x1, y1, x2, y2,
        stroke: ann.color || ink,
        "stroke-width": ann.thickness || state.strokeWidth,
      };
      if (ann.arrowhead) lineAttrs["marker-end"] = `url(#arrowhead)`;
      const ln = el("line", lineAttrs);
      if (rot) ln.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);
      ln.classList.add("annotation");
      ln.dataset.annId = ann.id;
      if ((state.selected && state.selected.kind === "annotation" && state.selected.id === ann.id)
          || isInMultiSelected("annotation", ann.id)) ln.classList.add("selected");
      // Defs-only-once: an arrowhead marker for any line that wants it.
      if (ann.arrowhead && !svg.querySelector("#arrowhead")) {
        const defs = el("defs");
        const marker = el("marker", {
          id: "arrowhead", markerWidth: 10, markerHeight: 10,
          refX: 8, refY: 5, orient: "auto-start-reverse",
        });
        marker.appendChild(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: ann.color || ink }));
        defs.appendChild(marker);
        svg.appendChild(defs);
      }
      svg.appendChild(ln);
    }
  });

  // Region resize handles — shown ONLY when the region is selected (the
  // user clicked the outline). Without this gate, handles cluttered the
  // canvas every render. Export-hidden so they don't appear in PNG/SVG.
  //
  // Position math mirrors the outline above: when cropped, the region
  // fills (marginLeft, marginTop, cropW, cropH); when not cropped, we
  // map the region's image-coords back into SVG space.
  if (state.region && state._regionSelected) {
    let rx, ry, rw, rh;
    if (L.cropped) {
      rx = L.marginLeft; ry = L.marginTop; rw = L.cropW; rh = L.cropH;
    } else {
      rx = imgToSvgX(L, state.region.x);
      ry = imgToSvgY(L, state.region.y);
      rw = state.region.w;
      rh = state.region.h;
    }
    const handles = [["nw", rx, ry], ["ne", rx + rw, ry], ["sw", rx, ry + rh], ["se", rx + rw, ry + rh]];
    const hg = el("g", { "data-export-hide": "true" });
    handles.forEach(([h, x, y]) => {
      hg.appendChild(el("rect", {
        x: x - 4, y: y - 4, width: 8, height: 8,
        fill: "#ffffff", stroke: "#3d8be0", "stroke-width": 1.2,
        "data-handle": h, style: "cursor: nwse-resize",
      }));
    });
    svg.appendChild(hg);
  }
}

// ── Selection + drag of annotations / labels ────────────────────────
function selectAnnotation(id) { state.selected = { kind: "annotation", id }; renderAll(); refreshSelectionPanel(); }
function selectLabel(key) { state.selected = { kind: "label", key }; renderAll(); refreshSelectionPanel(); }
function clearSelection() { state.selected = null; state._multiSelected = []; renderAll(); refreshSelectionPanel(); }

// Multi-select helpers.
//
// Marquee tests intersection in IMAGE coordinates: an annotation's center
// (or line bounding box) must be inside the rect to count. We don't bother
// with sub-pixel rotation math — the user is dragging a marquee, exact
// edge-case semantics aren't important. Labels are tested by their
// effective rendered SVG position, mapped back to image coords via the
// inverse of imgToSvg.
function collectElementsInImageRect(x1, y1, x2, y2) {
  const refs = [];
  // Annotations — test the annotation's center (text) or whether the
  // marquee overlaps the line's bbox.
  state.annotations.forEach((ann) => {
    if (ann.type === "text") {
      if (ann.x >= x1 && ann.x <= x2 && ann.y >= y1 && ann.y <= y2) {
        refs.push({ kind: "annotation", id: ann.id });
      }
    } else if (ann.type === "line") {
      // Line bbox vs marquee bbox overlap test (axis-aligned).
      const lx1 = Math.min(ann.x, ann.x2), lx2 = Math.max(ann.x, ann.x2);
      const ly1 = Math.min(ann.y, ann.y2), ly2 = Math.max(ann.y, ann.y2);
      if (lx2 >= x1 && lx1 <= x2 && ly2 >= y1 && ly1 <= y2) {
        refs.push({ kind: "annotation", id: ann.id });
      }
    }
  });
  // Labels — read each rendered text element's image-coord position. We
  // walk the live SVG since label positions depend on layout state
  // (margins, lane positions, dx/dy overrides) that's tedious to
  // re-derive from scratch.
  const L = computeLayout();
  svg.querySelectorAll("text[data-label-key]").forEach((el) => {
    const key = el.dataset.labelKey;
    let bx;
    let by;
    try {
      const bb = el.getBBox();
      bx = bb.x + bb.width / 2;
      by = bb.y + bb.height / 2;
    } catch (_) { return; }
    // SVG → image coords (inverse of imgToSvg)
    const ix = bx + L.cropX - L.marginLeft;
    const iy = by + L.cropY - L.marginTop;
    if (ix >= x1 && ix <= x2 && iy >= y1 && iy <= y2) {
      refs.push({ kind: "label", key });
    }
  });
  return refs;
}

function isInMultiSelected(kind, id) {
  return state._multiSelected.some((r) => r.kind === kind && (r.id === id || r.key === id));
}

// Build a multi-move drag descriptor from the current state._multiSelected
// list, snapshotting each element's pre-drag position so pointermove can
// apply a uniform delta and cancelDrag can revert cleanly.
function startMultiMoveDrag(evt, ic) {
  const refs = state._multiSelected.slice();
  const origs = refs.map((r) => {
    if (r.kind === "annotation") {
      const a = state.annotations.find((x) => x.id === r.id);
      return a ? { ...a } : null;
    } else {
      const ov = getOverride(r.key);
      return { dx: ov.dx || 0, dy: ov.dy || 0 };
    }
  });
  try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
  return { kind: "multi-move", pointerId: evt.pointerId, startImg: ic, refs, origs };
}

function refreshSelectionPanel() {
  const panel = $("selection-panel");
  // The top-bar inputs (font-size, thickness, color) mirror the same
  // values the sidebar shows. Reset them on every selection change so
  // the disabled state and current values stay in sync regardless of
  // which path we took (mouse click, undo, programmatic select).
  syncTopBarSelectionInputs();
  if (!state.selected) { panel.style.display = "none"; return; }
  panel.style.display = "block";
  const lineRow = $("sel-line-row");
  if (state.selected.kind === "annotation") {
    const ann = state.annotations.find((a) => a.id === state.selected.id);
    if (!ann) { panel.style.display = "none"; return; }
    $("selection-kind").textContent = `(${ann.type})`;
    if (ann.type === "text") {
      $("sel-font-size").value = ann.fontSize || state.fontPx;
      $("sel-color").value = (ann.color || "#000000").startsWith("#") ? ann.color : "#000000";
      lineRow.hidden = true;
    } else {
      $("sel-thickness").value = ann.thickness || 2;
      $("sel-color").value = (ann.color || "#000000").startsWith("#") ? ann.color : "#000000";
      $("sel-arrowhead").checked = !!ann.arrowhead;
      lineRow.hidden = false;
    }
  } else if (state.selected.kind === "label") {
    const ov = getOverride(state.selected.key);
    $("selection-kind").textContent = `(label)`;
    $("sel-font-size").value = ov.fontSize || state.fontPx;
    $("sel-color").value = (ov.color || "#000000").startsWith("#") ? ov.color : "#000000";
    lineRow.hidden = true;
  }
}

// Top-bar selection inputs (font-size, thickness, color) — mirror the
// sidebar editor's values, but always visible. Disabled when no element
// is selected, and individual fields are disabled based on element type
// (font-size doesn't apply to lines; thickness doesn't apply to text or
// labels). Color applies to everything selectable.
function syncTopBarSelectionInputs() {
  const fs = $("top-font-size"), th = $("top-thickness"), col = $("top-color");
  if (!fs || !th || !col) return;
  const disable = () => { fs.disabled = th.disabled = col.disabled = true; fs.value = ""; th.value = ""; col.value = "#000000"; };
  if (!state.selected) { disable(); return; }
  if (state.selected.kind === "annotation") {
    const ann = state.annotations.find((a) => a.id === state.selected.id);
    if (!ann) { disable(); return; }
    col.disabled = false;
    col.value = (ann.color || "#000000").startsWith("#") ? ann.color : "#000000";
    if (ann.type === "text") {
      fs.disabled = false; fs.value = ann.fontSize || state.fontPx;
      th.disabled = true;  th.value = "";
    } else {  // line
      fs.disabled = true;  fs.value = "";
      th.disabled = false; th.value = ann.thickness || 2;
    }
  } else if (state.selected.kind === "label") {
    const ov = getOverride(state.selected.key);
    col.disabled = false;
    col.value = (ov.color || "#000000").startsWith("#") ? ov.color : "#000000";
    fs.disabled = false; fs.value = ov.fontSize || state.fontPx;
    th.disabled = true;  th.value = "";
  } else {
    disable();
  }
}

$("sel-font-size").addEventListener("change", (e) => {
  const v = Math.max(6, parseFloat(e.target.value) || state.fontPx);
  if (!state.selected) return;
  if (state.selected.kind === "annotation") {
    const ann = state.annotations.find((a) => a.id === state.selected.id);
    if (ann) ann.fontSize = v;
  } else {
    setOverride(state.selected.key, { fontSize: v });
  }
  renderAll();
  commitHistory(`Set font size ${v}`);
});
$("sel-color").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!state.selected) return;
  if (state.selected.kind === "annotation") {
    const ann = state.annotations.find((a) => a.id === state.selected.id);
    if (ann) ann.color = v;
  } else {
    setOverride(state.selected.key, { color: v });
  }
  renderAll();
  commitHistory(`Set color ${v}`);
});
$("sel-thickness").addEventListener("change", (e) => {
  const v = Math.max(0.5, parseFloat(e.target.value) || 2);
  if (!state.selected || state.selected.kind !== "annotation") return;
  const ann = state.annotations.find((a) => a.id === state.selected.id);
  if (ann) { ann.thickness = v; renderAll(); commitHistory(`Set thickness ${v}`); }
});

// Top-bar mirror inputs — same semantics as the sidebar's sel-* inputs,
// just always visible. Internally each delegates to the matching sel-*
// input by setting its value and dispatching change. That keeps the
// commit-history wording, dedup, and event-listener wiring in ONE place
// instead of duplicating the application logic.
$("top-font-size").addEventListener("change", (e) => {
  if (!state.selected) return;
  $("sel-font-size").value = e.target.value;
  $("sel-font-size").dispatchEvent(new Event("change", { bubbles: true }));
});
$("top-thickness").addEventListener("change", (e) => {
  if (!state.selected || state.selected.kind !== "annotation") return;
  $("sel-thickness").value = e.target.value;
  $("sel-thickness").dispatchEvent(new Event("change", { bubbles: true }));
});
$("top-color").addEventListener("change", (e) => {
  if (!state.selected) return;
  $("sel-color").value = e.target.value;
  $("sel-color").dispatchEvent(new Event("change", { bubbles: true }));
});
$("sel-arrowhead").addEventListener("change", (e) => {
  if (!state.selected || state.selected.kind !== "annotation") return;
  const ann = state.annotations.find((a) => a.id === state.selected.id);
  if (ann) { ann.arrowhead = !!e.target.checked; renderAll(); commitHistory(`${ann.arrowhead ? "Add" : "Remove"} arrowhead`); }
});
$("sel-reset").addEventListener("click", () => {
  if (!state.selected) return;
  if (state.selected.kind === "label") {
    clearOverride(state.selected.key);
    renderAll(); refreshSelectionPanel();
    commitHistory("Reset label position");
  }
});
$("sel-delete").addEventListener("click", () => {
  if (!state.selected) return;
  let label;
  if (state.selected.kind === "annotation") {
    const ann = state.annotations.find((a) => a.id === state.selected.id);
    label = `Delete ${ann?.type || "annotation"}`;
    state.annotations = state.annotations.filter((a) => a.id !== state.selected.id);
  } else if (deleteBandIfBandKey(state.selected.key)) {
    // Ladder band — already deleted (band + tick gone) inside helper.
    label = "Delete ladder band";
  } else {
    // Lane number / bracket / row label — mark hidden so the renderer
    // stops emitting it. (Clearing the override alone would only reset
    // dx/dy/font/etc.; the label would re-appear because it's rebuilt
    // from layout state on every frame.)
    label = "Delete label";
    setOverride(state.selected.key, { hidden: true });
  }
  clearSelection();
  commitHistory(label);
});

// Helper: if `key` matches the "band-{laneIdx}-{bandId}" pattern, remove
// the band from state.bands (the in-lane tick is rendered only when the
// band exists, so it disappears automatically) and return true. Returns
// false if the key isn't a band key or the band wasn't found.
function deleteBandIfBandKey(key) {
  if (typeof key !== "string" || !key.startsWith("band-")) return false;
  const m = key.match(/^band-(\d+)-(.+)$/);
  if (!m) return false;
  const laneIdx = parseInt(m[1], 10);
  const bandId  = m[2];
  const lane = state.bands[laneIdx];
  if (!lane) return false;
  const before = lane.length;
  state.bands[laneIdx] = lane.filter((b) => b.id !== bandId);
  if (state.bands[laneIdx].length === before) return false;
  if (state.bands[laneIdx].length === 0) delete state.bands[laneIdx];
  // The band panel reflects the count for the active ladder lane —
  // refresh it so the deletion shows up immediately if the deleted
  // band's lane is currently expanded.
  if (typeof updateBandPanel === "function") updateBandPanel();
  return true;
}

// ── Pointer interactions on the SVG ─────────────────────────────────
//
// DRAG LIFECYCLE — invariants the rest of the file relies on
//   • `drag` is null OR holds { kind, pointerId?, ...kindSpecific }
//   • Anything that mutates application state in a way that invalidates
//     the in-flight drag (image upload, tool-toggle-off, ESC, pointercancel,
//     window blur) MUST call cancelDrag() — never just `drag = null`.
//   • cancelDrag() is idempotent and safe to call when no drag is active.
//   • The region-preview rectangle is owned by the region-draw drag; its
//     lifecycle is bounded by startDrag/cancel/finish for that kind.
//
// This is the foundation that makes "Draw region" robust against future
// feature additions: as long as new code respects these invariants, the
// region tool stays correct.
let drag = null;

// Last clicked ladder band — for timing-based dblclick detection on
// the ladder labels. See the ladder-label-pending pointerup branch.
let _lastBandClick = null;

function cancelDrag(reason) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.pointerId != null) {
    try { svg.releasePointerCapture(d.pointerId); } catch (_) { /* already released */ }
  }
  // Per-kind cleanup. Keep simple — just rollback whatever the drag built.
  if (d.kind === "region-draw") {
    const prev = svg.querySelector('[data-role="region-preview"]'); if (prev) prev.remove();
    if (reason) setStatus(reason);
  } else if (d.kind === "region-resize") {
    // Resize was applied incrementally to state.region; restore the
    // pre-drag value so the user gets a clean revert on ESC/cancel.
    state.region = d.orig;
    renderAll();
    if (reason) setStatus(reason);
  } else if (d.kind === "ann-line-draw") {
    // Cancelled mid-draw → drop the half-built line annotation.
    state.annotations = state.annotations.filter((a) => a.id !== d.id);
    renderAll();
  } else if (d.kind === "sep-move" || d.kind === "tick-height" || d.kind === "tick-pending") {
    // Tick drags mutate state on every pointermove; on cancel, revert to
    // the snapshot taken at pointerdown so the user's seen position
    // matches the pre-drag state. tick-pending hasn't mutated anything
    // yet (still in dead-zone), so the restore is a no-op.
    if (d.origSeparators !== undefined) state.laneSeparators = d.origSeparators;
    if (d.origTickHeight !== undefined) state.tickHeight = d.origTickHeight;
    renderAll();
    if (reason) setStatus(reason);
  } else if (d.kind === "ladder-label-pending" || d.kind === "ladder-label-drag") {
    // Revert: restore band y_center + shared lane dx to pre-drag values.
    const lane = state.bands[d.laneIdx];
    const band = lane && lane.find((b) => b.id === d.bandId);
    if (band && d.origYcenter !== undefined) band.y_center = d.origYcenter;
    if (d.origLaneDx !== undefined) state.ladderLabelDx[d.laneIdx] = d.origLaneDx;
    renderAll();
    if (reason) setStatus(reason);
  } else if (d.kind === "marquee") {
    // Marquee is a pure read-only drag — cancellation just stops drawing.
    renderAll();
  } else if (d.kind === "rotate-drag") {
    // Cancel: the rotateMode revert path lives in exitRotateMode(false),
    // which restores the snapshots and clears state.rotateMode. We
    // call it here so cancelling a drag mid-rotation also exits the
    // mode cleanly.
    exitRotateMode(false);
    if (reason) setStatus(reason);
  } else if (d.kind === "multi-move") {
    // Restore each element's pre-drag position.
    if (d.refs && d.origs) {
      d.refs.forEach((r, i) => {
        const orig = d.origs[i]; if (!orig) return;
        if (r.kind === "annotation") {
          const ann = state.annotations.find((a) => a.id === r.id);
          if (!ann) return;
          ann.x = orig.x; ann.y = orig.y;
          if (ann.type === "line") { ann.x2 = orig.x2; ann.y2 = orig.y2; }
        } else if (r.kind === "label") {
          setOverride(r.key, { dx: orig.dx, dy: orig.dy });
        }
      });
    }
    renderAll();
    if (reason) setStatus(reason);
  }
  // ann-move / label-move have committed their state on every pointermove,
  // so cancellation is a no-op for them (the user's seen position stands).
}

svg.addEventListener("pointerdown", (evt) => {
  if (!state.imageId) return;
  if (evt.button !== 0) return;     // left button only — right-click shouldn't start a drag
  const ic = clientToImage(evt); if (!ic) return;

  // If a text annotation is mid-typing, ANY pointerdown commits it. Without
  // this, the user's next click goes through to start a new drag/selection
  // while pendingTextAnn stays set — subsequent keystrokes would land in the
  // ghost annotation instead of where the user expects. commitPendingText
  // also removes the annotation if its text is empty, so a click-without-
  // typing doesn't leave invisible orphans behind.
  if (state.pendingTextAnn) commitPendingText();

  // Defensive: if any drag is somehow still active, kill it before starting a new one.
  if (drag) cancelDrag();

  // ROTATE MODE — every pointerdown on the SVG starts an angular drag
  // around the rotateMode pivot, regardless of what's underneath. This
  // matches Adobe Illustrator's rotate tool: once active, click-and-
  // drag anywhere rotates the selection.
  if (state.rotateMode) {
    state.rotateMode.dragStart = ic;
    drag = { kind: "rotate-drag", pointerId: evt.pointerId };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return;
  }

  // fEMSA row placement / move / resize. Claims the event only when the
  // draw-row tool is armed or the pointer went down on one of its own
  // elements, so every gesture below still behaves normally in quant
  // mode. Returns true iff it took ownership.
  if (window.FEMSA && FEMSA.onPointerDown(evt, ic)) return;

  // Region resize handle?
  if (evt.target.dataset && evt.target.dataset.handle && state.region) {
    drag = { kind: "region-resize", pointerId: evt.pointerId, handle: evt.target.dataset.handle, orig: { ...state.region }, startImg: ic };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return;
  }

  // Click on the region OUTLINE → select the region (reveals corner
  // resize handles). The outline is exposed as a wider invisible
  // pointer-events: stroke rect, so only border clicks count — clicks
  // inside the region fall through to annotation / marquee handlers.
  if (evt.target.dataset && evt.target.dataset.role === "region-outline" && state.region) {
    state._regionSelected = true;
    renderAll();
    evt.preventDefault();
    return;
  }

  // Any other pointerdown deselects the region (it stays selected only
  // while the user is interacting with its outline or its handles).
  // Note: this fires AFTER the region-resize-handle and outline checks
  // above, so dragging a handle or clicking the outline doesn't
  // accidentally deselect itself.
  //
  // We don't call renderAll() here — that caused a flicker on the
  // "click inside region to select" path: the deselect would render
  // (handles vanish) just before marquee-finalize re-set the flag and
  // re-rendered (handles flash back in). All downstream branches in
  // this handler call renderAll themselves, so deferring the render
  // is safe.
  if (state._regionSelected) {
    state._regionSelected = false;
  }

  // Square HANDLE on a tick tip → start an axis-pending drag.
  //   • Vertical movement       → adjust shared tick height (all ticks)
  //   • Horizontal movement     → move only this tick's separator (inner
  //                               ticks only — outer ticks ignore)
  // Squares are visible only when a tick is selected, so dragging one
  // implicitly means the user has already clicked into "tick edit mode".
  if (evt.target.dataset && evt.target.dataset.tickHandle === "square" && state.region) {
    const tickIdx = parseInt(evt.target.dataset.tickIdx, 10);
    const sepIdx = evt.target.dataset.sepIdx != null ? parseInt(evt.target.dataset.sepIdx, 10) : null;
    drag = {
      kind: "tick-pending",   // resolves to "sep-move" or "tick-height" after dead-zone
      pointerId: evt.pointerId,
      tickIdx, sepIdx,
      startImg: ic,
      startClientX: evt.clientX, startClientY: evt.clientY,
      origSeparators: state.laneSeparators ? state.laneSeparators.slice() : null,
      origTickHeight: state.tickHeight,
    };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return;
  }

  // Tick body — supports BOTH click-to-select (no movement) AND direct
  // drag (axis-pending → sep-move/height after dead-zone). This dual
  // behavior makes ticks immediately useful without forcing the user to
  // discover the click-then-drag-square workflow:
  //   • Drag horizontally → sep-move (only inner ticks, where sepIdx exists)
  //   • Drag vertically   → tick-height (every tick — height is shared)
  //   • Click + release   → select tick (squares appear on all ticks as
  //                         a visual cue + alternative drag target)
  if (evt.target.dataset && evt.target.dataset.tickIdx != null && state.region) {
    const tickIdx = parseInt(evt.target.dataset.tickIdx, 10);
    const sepIdx = evt.target.dataset.sepIdx != null ? parseInt(evt.target.dataset.sepIdx, 10) : null;
    drag = {
      kind: "tick-pending",   // resolves to "sep-move" or "tick-height" after dead-zone
      pointerId: evt.pointerId,
      tickIdx, sepIdx,
      fromBody: true,          // pointerup with no movement → select this tick
      startImg: ic,
      startClientX: evt.clientX, startClientY: evt.clientY,
      origSeparators: state.laneSeparators ? state.laneSeparators.slice() : null,
      origTickHeight: state.tickHeight,
    };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return;
  }

  // Drawing region?
  if (state.tool === "region") {
    drag = { kind: "region-draw", pointerId: evt.pointerId, x0: ic.x, y0: ic.y, x1: ic.x, y1: ic.y };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return;
  }

  // Drawing line annotation?
  if (state.tool === "line") {
    const ann = { id: newId(), type: "line", x: ic.x, y: ic.y, x2: ic.x, y2: ic.y, color: "#000000", thickness: state.strokeWidth, arrowhead: false, rotation: 0 };
    state.annotations.push(ann);
    drag = { kind: "ann-line-draw", pointerId: evt.pointerId, id: ann.id, anchor: { x: ic.x, y: ic.y } };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    renderAll(); return;
  }

  // Placing text annotation?
  if (state.tool === "text") {
    const ann = { id: newId(), type: "text", x: ic.x, y: ic.y, text: "", fontSize: state.fontPx, color: state.invertImage ? "#ffffff" : "#000000", rotation: 0 };
    state.annotations.push(ann);
    state.pendingTextAnn = ann.id;
    setTool(null);
    selectAnnotation(ann.id);
    setStatus("Type your label. Press Enter or click outside to commit.");
    return;
  }

  // Click on a free-form annotation? → if it's part of a multi-select,
  // drag the WHOLE group together; otherwise select just this one.
  if (evt.target.dataset && evt.target.dataset.annId) {
    const id = evt.target.dataset.annId;
    if (isInMultiSelected("annotation", id) && state._multiSelected.length > 1) {
      drag = startMultiMoveDrag(evt, ic);
      return;
    }
    selectAnnotation(id);
    const ann = state.annotations.find((a) => a.id === id);
    if (ann) {
      drag = { kind: "ann-move", pointerId: evt.pointerId, id, ann, startImg: ic, orig: { ...ann } };
      try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    }
    return;
  }

  // Click on a LADDER-BAND label? Ladder bands have their own drag mode
  // because they need to:
  //   • move the band's y_center (so the in-lane tick + leader follow
  //     the label vertically)
  //   • move ALL labels in that lane horizontally together (shared dx)
  //   • differentiate click-to-edit from drag-to-move via a 3-px dead-
  //     zone, so a plain click opens the inline editor
  if (evt.target.classList && evt.target.classList.contains("ladder-band-label")) {
    const laneIdx = parseInt(evt.target.dataset.bandLane, 10);
    const bandId  = evt.target.dataset.bandId;
    const band = (state.bands[laneIdx] || []).find((b) => b.id === bandId);
    if (band) {
      drag = {
        kind: "ladder-label-pending",
        pointerId: evt.pointerId,
        laneIdx, bandId,
        startImg: ic,
        startClientX: evt.clientX, startClientY: evt.clientY,
        origYcenter: band.y_center,
        origLaneDx:  state.ladderLabelDx[laneIdx] || 0,
        didMove: false,
      };
      try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
      evt.preventDefault();
      return;
    }
  }

  // Click on a label? → group drag if multi-selected, else single select.
  if (evt.target.dataset && evt.target.dataset.labelKey) {
    const key = evt.target.dataset.labelKey;
    if (isInMultiSelected("label", key) && state._multiSelected.length > 1) {
      drag = startMultiMoveDrag(evt, ic);
      return;
    }
    selectLabel(key);
    drag = { kind: "label-move", pointerId: evt.pointerId, key, startImg: ic, origDx: getOverride(key).dx || 0, origDy: getOverride(key).dy || 0 };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    return;
  }

  // Click inside ANY ladder lane → drop a band into that lane.
  //
  // Multi-ladder support: rather than requiring the user to first
  // "activate" a specific ladder via the band panel, every lane marked
  // as ladder accepts clicks independently. We walk all ladder lanes
  // and find the one whose horizontal extent contains the click. The
  // band panel auto-switches to that lane so the user can immediately
  // see / rename / preset-apply the bands they're adding.
  //
  // No prompt: just place the tick + a "?" placeholder label. The user
  // can click the "?" later to inline-edit the value, or use the band
  // panel's input. This makes adding many ladder bands quick — the user
  // can click-click-click to drop ticks, then go back and label them.
  if (state.region
      && ic.y >= state.region.y && ic.y <= state.region.y + state.region.h) {
    const lns = computeLanes();
    for (let i = 0; i < state.laneCount; i++) {
      if (!state.ladder[i]) continue;
      const lane = lns[i]; if (!lane) continue;
      if (ic.x < lane.x_left || ic.x > lane.x_right) continue;
      if (!state.bands[i]) state.bands[i] = [];
      state.bands[i].push({ id: newId(), y_center: ic.y, label: "?" });
      state.bands[i].sort((a, b) => a.y_center - b.y_center);
      // Auto-activate this ladder so the band panel reflects what the
      // user is editing right now.
      state._bandTargetLane = i;
      // Sync table-side selection so updateBandPanel's "single selected
      // ladder lane" rule resolves to this one even with multiple
      // ladders present, and so the table visually highlights the row.
      state.selectedLanes = new Set([i]);
      const tbody = $("metadata-table").querySelector("tbody");
      if (tbody) tbody.querySelectorAll("tr").forEach((tr, idx) =>
        tr.classList.toggle("selected", state.selectedLanes.has(idx)));
      updateBandPanel(); renderAll();
      commitHistory(`Add band to lane ${i + 1}`);
      return;
    }
  }

  // Click on empty SVG area → start a MARQUEE drag for multi-element
  // selection. If the user releases without moving (a plain click on
  // empty space), pointerup clears all selection state. If they drag,
  // pointerup finalizes the multi-selection.
  drag = {
    kind: "marquee",
    pointerId: evt.pointerId,
    startImg: ic,
    curImg: ic,
  };
  try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
});

svg.addEventListener("pointermove", (evt) => {
  if (!drag) return;
  // Multi-touch / multi-pointer: ignore moves from other pointers.
  if (drag.pointerId != null && evt.pointerId !== drag.pointerId) return;
  const ic = clientToImage(evt); if (!ic) return;
  if (drag.kind === "region-draw") {
    drag.x1 = ic.x; drag.y1 = ic.y; drawRegionPreview();
  } else if (drag.kind === "region-resize") {
    // Apply the delta to the original region. Use clamp + min-size so the
    // user can't shrink the region below 20×20 image-px or extend it past
    // the image edges. Without these, reloads / exports could blow up on
    // a degenerate region.
    let { x, y, w, h } = drag.orig;
    const dx = ic.x - drag.startImg.x;
    const dy = ic.y - drag.startImg.y;
    if (drag.handle.includes("w")) { x = drag.orig.x + dx; w = drag.orig.w - dx; }
    if (drag.handle.includes("e")) {                       w = drag.orig.w + dx; }
    if (drag.handle.includes("n")) { y = drag.orig.y + dy; h = drag.orig.h - dy; }
    if (drag.handle.includes("s")) {                       h = drag.orig.h + dy; }
    const minW = 20, minH = 20;
    if (w < minW) { if (drag.handle.includes("w")) x = drag.orig.x + drag.orig.w - minW; w = minW; }
    if (h < minH) { if (drag.handle.includes("n")) y = drag.orig.y + drag.orig.h - minH; h = minH; }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > state.imgWidth)  w = state.imgWidth  - x;
    if (y + h > state.imgHeight) h = state.imgHeight - y;
    if (w >= minW && h >= minH) { state.region = { x, y, w, h }; renderAll(); }
  } else if (drag.kind === "ann-line-draw") {
    const ann = state.annotations.find((a) => a.id === drag.id); if (!ann) return;
    ann.x2 = ic.x; ann.y2 = ic.y; renderAll();
  } else if (drag.kind === "ann-move") {
    const ann = state.annotations.find((a) => a.id === drag.id); if (!ann) return;
    const dx = ic.x - drag.startImg.x, dy = ic.y - drag.startImg.y;
    ann.x = drag.orig.x + dx; ann.y = drag.orig.y + dy;
    if (ann.type === "line") { ann.x2 = drag.orig.x2 + dx; ann.y2 = drag.orig.y2 + dy; }
    renderAll();
  } else if (drag.kind === "label-move") {
    const dx = drag.origDx + (ic.x - drag.startImg.x);
    const dy = drag.origDy + (ic.y - drag.startImg.y);
    setOverride(drag.key, { dx, dy });
    renderAll();
  } else if (drag.kind === "ladder-label-pending" || drag.kind === "ladder-label-drag") {
    // Same dead-zone pattern as the tick drag: a plain click (no movement)
    // becomes an edit, a drag (movement > 3 client-px) starts modifying
    // y_center / shared dx in real-time.
    const adx = Math.abs(evt.clientX - drag.startClientX);
    const ady = Math.abs(evt.clientY - drag.startClientY);
    if (drag.kind === "ladder-label-pending") {
      if (adx < 3 && ady < 3) return;
      drag.kind = "ladder-label-drag";
      drag.didMove = true;
    }
    // Vertical → only this band's y_center; in-lane marker + leader +
    // label all key off y_center so they follow as one.
    const band = (state.bands[drag.laneIdx] || []).find((b) => b.id === drag.bandId);
    if (band) {
      const newY = drag.origYcenter + (ic.y - drag.startImg.y);
      // Clamp to the region (or image bounds) so the band doesn't fly
      // off-canvas. Region.y .. region.y+region.h is the meaningful range.
      const r = state.region;
      const yLo = r ? r.y : 0;
      const yHi = r ? r.y + r.h : state.imgHeight;
      band.y_center = Math.max(yLo, Math.min(yHi, newY));
    }
    // Horizontal → shared per-lane dx for ALL labels in this ladder lane.
    const newDx = drag.origLaneDx + (ic.x - drag.startImg.x);
    state.ladderLabelDx[drag.laneIdx] = newDx;
    renderAll();
  } else if (drag.kind === "marquee") {
    // Live marquee: just update the rect; pointerup tests intersection.
    drag.curImg = ic;
    renderAll();
  } else if (drag.kind === "rotate-drag" && state.rotateMode) {
    // Compute angular delta from the drag-start vector (relative to the
    // rotate pivot) to the current pointer vector. atan2 returns a
    // signed angle in (−π, π]; subtraction wraps cleanly so a 180°+
    // sweep around the pivot reads as +180°/−180° rather than 0.
    const m = state.rotateMode;
    if (!m.dragStart) return;
    const a0 = Math.atan2(m.dragStart.y - m.pivot.y, m.dragStart.x - m.pivot.x);
    const a1 = Math.atan2(ic.y - m.pivot.y, ic.x - m.pivot.x);
    let angleDeg = (a1 - a0) * 180 / Math.PI;
    // Normalize to (−180, 180]
    while (angleDeg > 180)  angleDeg -= 360;
    while (angleDeg < -180) angleDeg += 360;
    // Shift snaps to 15° increments — matches Illustrator's constraint key
    if (evt.shiftKey) angleDeg = Math.round(angleDeg / 15) * 15;
    m.angle = angleDeg;
    if (m.target === "elements") {
      applyElementRotation(m.refs, m.origs, m.pivot, angleDeg);
    }
    // Image preview is applied in the renderer reading m.angle directly.
    renderAll();
  } else if (drag.kind === "multi-move") {
    // Group drag: apply the same image-coord delta to every selected
    // element. Annotations move via x/y (and x2/y2 for lines); labels
    // move via labelOverrides[key].dx/dy.
    const dx = ic.x - drag.startImg.x;
    const dy = ic.y - drag.startImg.y;
    drag.refs.forEach((r, i) => {
      const orig = drag.origs[i];
      if (r.kind === "annotation") {
        const ann = state.annotations.find((a) => a.id === r.id);
        if (!ann) return;
        ann.x = orig.x + dx; ann.y = orig.y + dy;
        if (ann.type === "line") {
          ann.x2 = orig.x2 + dx; ann.y2 = orig.y2 + dy;
        }
      } else if (r.kind === "label") {
        const od = orig.dx || 0, oy = orig.dy || 0;
        setOverride(r.key, { dx: od + dx, dy: oy + dy });
      }
    });
    renderAll();
  } else if (drag.kind === "tick-pending" || drag.kind === "sep-move" || drag.kind === "tick-height") {
    // Dead-zone resolution. Until the user has moved >3 client-px we
    // don't know if they want to slide a separator or change tick height.
    //
    // Gate vertical-axis (height) adjustment on tick selection: a user
    // who hasn't clicked a tick yet can ONLY do horizontal sep-move from
    // the tick body. Vertical movement in that state stays in the
    // pending kind so pointerup falls through to "click-to-select"
    // (squares appear, height becomes adjustable on a SECOND drag).
    // This protects the user from accidentally enlarging the tick row
    // while trying to nudge a separator.
    //
    // Square handles (rendered only after a tick has been selected) are
    // exempt — they have `fromBody: false` and always allow both axes.
    if (drag.kind === "tick-pending") {
      const adx = Math.abs(evt.clientX - drag.startClientX);
      const ady = Math.abs(evt.clientY - drag.startClientY);
      if (adx < 3 && ady < 3) return;
      const heightAllowed = !drag.fromBody || state._selectedTick !== null;
      if (adx >= ady && drag.sepIdx != null) {
        drag.kind = "sep-move";
      } else if (heightAllowed) {
        drag.kind = "tick-height";
      } else {
        // Vertical drag from an unselected tick body: don't transition.
        // Pointerup will then run the "fromBody no-axis-resolution" path
        // which selects the tick.
        return;
      }
    }
    if (drag.kind === "sep-move") {
      // Convert the new pointer x into a fractional position within the
      // region. Clamp so neighbouring separators stay strictly ordered with
      // a minimum lane width (2% of region.w) — without this, two separators
      // could converge into a zero-width lane and break downstream rendering.
      const r = state.region;
      const frac = (ic.x - r.x) / r.w;
      const seps = (drag.origSeparators ? drag.origSeparators.slice() : defaultSeparators(state.laneCount));
      const minGap = 0.02;
      const lo = drag.sepIdx === 0 ? 0 : seps[drag.sepIdx - 1];
      const hi = drag.sepIdx === seps.length - 1 ? 1 : seps[drag.sepIdx + 1];
      seps[drag.sepIdx] = Math.max(lo + minGap, Math.min(hi - minGap, frac));
      state.laneSeparators = seps;
      renderAll();
    } else if (drag.kind === "tick-height") {
      // Drag the tick/handle UP (decreasing client-y) makes it taller.
      // Lower bound 2 image-px (must remain visible); upper bound 60
      // (otherwise it eats into the bracket / lane-number area).
      const dy = drag.startClientY - evt.clientY;
      // Convert client-y delta → image-y delta via the SVG screen CTM scale.
      const ctm = svg.getScreenCTM();
      const scale = ctm ? Math.abs(1 / ctm.a) : 1;  // approx — uniform scale
      const newH = drag.origTickHeight + dy * scale;
      state.tickHeight = Math.max(2, Math.min(60, newH));
      renderAll();
    }
  }
});

svg.addEventListener("pointerup", (evt) => {
  if (!drag) return;
  if (drag.pointerId != null && evt && evt.pointerId !== drag.pointerId) return;
  const d = drag; drag = null;
  if (d.pointerId != null) {
    try { svg.releasePointerCapture(d.pointerId); } catch (_) {}
  }
  if (d.kind === "region-draw") {
    // Clamp drag rectangle to the image bounds, then validate min size.
    const x = Math.max(0, Math.min(d.x0, d.x1));
    const y = Math.max(0, Math.min(d.y0, d.y1));
    const x2 = Math.min(state.imgWidth,  Math.max(d.x0, d.x1));
    const y2 = Math.min(state.imgHeight, Math.max(d.y0, d.y1));
    const w = x2 - x, h = y2 - y;
    const prev = svg.querySelector('[data-role="region-preview"]'); if (prev) prev.remove();
    if (w >= 10 && h >= 10) {
      state.region = { x, y, w, h };
      setStatus(`Region drawn: ${Math.round(w)} × ${Math.round(h)} at (${Math.round(x)}, ${Math.round(y)}). Drag corners to resize.`);
      setTool(null); renderAll();
      commitHistory("Draw region");
    } else {
      // Below threshold — reject without setting region. Status tells the user
      // why nothing happened (otherwise a brief click looks like the tool's broken).
      setStatus("Drag was too small — click and drag a larger area to define the region.", true);
    }
  } else if (d.kind === "region-resize") {
    setStatus(`Region: ${Math.round(state.region.w)} × ${Math.round(state.region.h)} at (${Math.round(state.region.x)}, ${Math.round(state.region.y)}).`);
    commitHistory("Resize region");
  } else if (d.kind === "ann-line-draw") {
    // Threshold: a click without meaningful drag is treated as cancellation
    // — otherwise the user gets an invisible zero-length line saved into the
    // project. Mirror the region tool's drag-too-small rejection.
    const ann = state.annotations.find((a) => a.id === d.id);
    let kept = true;
    if (ann) {
      const dx = ann.x2 - ann.x, dy = ann.y2 - ann.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 9) {  // < 3 image-px total displacement
        state.annotations = state.annotations.filter((a) => a.id !== d.id);
        setStatus("Line drag was too small — click and drag a longer line.", true);
        renderAll();
        kept = false;
      }
    }
    setTool(null);
    if (kept) commitHistory("Draw line");
  } else if (d.kind === "ann-move") {
    // Only commit if the annotation actually moved — clicking on an
    // annotation without dragging it shouldn't create an undo step.
    const ann = state.annotations.find((a) => a.id === d.id);
    if (ann && d.orig && (ann.x !== d.orig.x || ann.y !== d.orig.y)) {
      commitHistory(`Move ${ann.type} annotation`);
    }
  } else if (d.kind === "label-move") {
    const ov = state.labelOverrides[d.key] || {};
    if ((ov.dx || 0) !== d.origDx || (ov.dy || 0) !== d.origDy) {
      commitHistory("Move label");
    }
  } else if (d.kind === "sep-move") {
    // Only commit if the separator actually moved (small dead-zone movements
    // that locked into sep-move but didn't end up shifting will produce no
    // diff and dedup will skip).
    commitHistory(`Adjust lane separator ${d.sepIdx + 1}`);
  } else if (d.kind === "tick-height") {
    if (state.tickHeight !== d.origTickHeight) {
      commitHistory(`Set tick height to ${Math.round(state.tickHeight)}`);
    }
  } else if (d.kind === "tick-pending") {
    // No movement crossed the dead-zone. If the drag started from the
    // tick body, treat it as click-to-select (squares appear on all
    // ticks). If it started from a square, no-op — selection stays.
    if (d.fromBody) {
      state._selectedTick = d.tickIdx;
      renderAll();
    }
  } else if (d.kind === "marquee") {
    // Finalize the marquee: any annotation or label whose rendered bbox
    // intersects the rectangle becomes part of the multi-selection. If
    // the rectangle is too small (just a click), clear all selection
    // state — same as the old empty-area click semantics.
    const x1 = Math.min(d.startImg.x, d.curImg.x);
    const y1 = Math.min(d.startImg.y, d.curImg.y);
    const x2 = Math.max(d.startImg.x, d.curImg.x);
    const y2 = Math.max(d.startImg.y, d.curImg.y);
    const w = x2 - x1, h = y2 - y1;
    if (w < 3 && h < 3) {
      // Plain click on empty SVG area. If the click landed INSIDE the
      // analysis region (and a region exists), treat it as "select
      // region" — equivalent to clicking the outline. This is much
      // easier than hitting the 8-px stroke band: the user just
      // clicks anywhere within the gel region (where no annotation,
      // label, or ladder band is in the way) to reveal the corner
      // resize handles. Empty-area clicks OUTSIDE the region clear
      // all selection (the historical behavior).
      const r = state.region;
      const insideRegion = !!r
        && d.startImg.x >= r.x && d.startImg.x <= r.x + r.w
        && d.startImg.y >= r.y && d.startImg.y <= r.y + r.h;
      // Mutate all selection state in one batch, then render once —
      // no flicker. clearSelection() is intentionally NOT used here
      // because it would render before we've set _regionSelected.
      state._multiSelected = [];
      state.selected = null;
      state._selectedTick = null;
      state._regionSelected = insideRegion;
      renderAll();
      refreshSelectionPanel();
    } else {
      // Real marquee — collect intersecting elements. We test intersection
      // against the LIVE SVG bounding boxes (after any rotation, dx/dy
      // overrides, etc) by mapping each annotation/label's center back
      // through imgToSvg. For lines, the bbox is the (x,y)-(x2,y2) bounds.
      const refs = collectElementsInImageRect(x1, y1, x2, y2);
      state._multiSelected = refs;
      state.selected = null;
      state._selectedTick = null;
      refreshSelectionPanel();
      renderAll();
      setStatus(refs.length === 0
        ? "Marquee was empty — try drawing it over annotations or labels."
        : `Selected ${refs.length} element${refs.length === 1 ? "" : "s"}.`);
    }
  } else if (d.kind === "multi-move") {
    // Group drag committed — one history entry covers the whole group.
    if (d.refs && d.refs.length) commitHistory(`Move ${d.refs.length} element${d.refs.length === 1 ? "" : "s"}`);
  } else if (d.kind === "rotate-drag") {
    // Pointerup commits the rotation and exits rotate mode. The user can
    // chain rotations by clicking Rotate again — each enter/commit cycle
    // is one history entry.
    exitRotateMode(true);
  } else if (d.kind === "ladder-label-drag") {
    // Drag completed — commit history. Dedup will skip if y_center and
    // shared dx both ended at their starting values.
    commitHistory("Move ladder band");
  } else if (d.kind === "ladder-label-pending") {
    // Plain click on a band label →
    //   • SECOND click within 500 ms on the same band → enter edit
    //     mode (timing-based dblclick).
    //   • Otherwise → SELECT the band (it can be deleted, marqueed,
    //     etc.). The next click within the window will treat it as a
    //     dblclick.
    //
    // Timing-based dblclick instead of the browser's `dblclick` event:
    // the first click runs `renderAll()`, which replaces the SVG
    // <text> element. The browser's native dblclick detection
    // sometimes fails when the click target is destroyed and
    // recreated between the two clicks of a fast double-click. Also,
    // the ladder-label pointerdown path calls `evt.preventDefault()`
    // (needed to suppress text-selection inside the label), which
    // suppresses the synthetic click → dblclick chain in some
    // browsers. Detecting dblclick from our own pointerup events is
    // robust to both.
    const lane = state.bands[d.laneIdx];
    const band = lane && lane.find((b) => b.id === d.bandId);
    if (band) {
      const key = `band-${d.laneIdx}-${d.bandId}`;
      const now = Date.now();
      const last = _lastBandClick;
      const isDouble = last
        && last.laneIdx === d.laneIdx
        && last.bandId === d.bandId
        && (now - last.time) < 500;
      if (isDouble) {
        _lastBandClick = null;
        state._editingBand = { laneIdx: d.laneIdx, bandId: d.bandId };
        // Clear other selection while editing — the input field's own
        // background is enough visual cue, and a leftover .selected
        // outline would clash with the editor.
        state.selected = null;
        state._multiSelected = [];
      } else {
        _lastBandClick = { time: now, laneIdx: d.laneIdx, bandId: d.bandId };
        state._multiSelected = [];
        state.selected = { kind: "label", key };
      }
      renderAll();
      refreshSelectionPanel();
    }
  }
});

// (The earlier `svg.addEventListener("dblclick", …)` for entering band
// edit mode has been removed. Detection now lives in the
// ladder-label-pending pointerup branch via _lastBandClick timing —
// robust to renderAll between the two clicks of a fast double-click.)

// Pointer cancellation: the OS / browser took the pointer away (window
// switch, touch interrupt, gesture cancel, etc). Without this, an in-flight
// drag would survive forever, blocking subsequent interactions and leaving
// the preview rectangle stuck on screen.
svg.addEventListener("pointercancel", (evt) => {
  if (!drag) return;
  if (drag.pointerId != null && evt.pointerId !== drag.pointerId) return;
  cancelDrag("Drag cancelled.");
});

// Window blur: if the user alt-tabs mid-drag, the browser may not fire
// pointerup. Release the drag so the next interaction starts clean.
window.addEventListener("blur", () => { if (drag) cancelDrag(); });

// ── Scroll-wheel zoom + right-click drag pan ────────────────────────
//
// Wheel-up zooms in, wheel-down zooms out, centered on the cursor.
// The zoom factor is proportional to the wheel delta so:
//   • A single trackpad nudge produces a tiny smooth step.
//   • A full mouse-wheel detent produces a noticeable but not jarring
//     step (~5–10 %).
//   • Continuous scrolling integrates smoothly without the staircase
//     "jump" the old constant 1.1× factor produced.
// Math: factor = exp(−deltaY × SENSITIVITY). The exp formulation
// guarantees that scrolling up then down by the same amount returns
// EXACTLY to the original scale (factor × 1/factor = 1). A constant
// 1.1 step accumulates floating-point drift on long up/down sequences.
//
// Right-click drag pans the canvas-wrap viewport. We keep the
// browser's contextmenu suppressed via preventDefault so a quick
// right-click doesn't pop up the menu mid-drag.
//
// We listen on the canvas-wrap (not the SVG) so wheels / pans in the
// margin area also work — and we passive: false + preventDefault so
// the page doesn't scroll behind us. Modifier-less wheel zooms;
// Ctrl+wheel is the OS browser-zoom and we leave that alone.
{
  const canvasWrap = document.getElementById("canvas-wrap");
  if (canvasWrap) {
    // Smooth zoom via exponential factor proportional to wheel delta.
    // SENSITIVITY tuned so a typical mouse-wheel detent (deltaY ≈ 100)
    // gives ~ exp(0.0015 × 100) = ~1.16 (16 % zoom step) and a small
    // trackpad nudge (deltaY ≈ 4) gives ~ exp(0.006) = ~0.6 % step.
    const ZOOM_SENSITIVITY = 0.0015;
    canvasWrap.addEventListener("wheel", (evt) => {
      if (evt.ctrlKey || evt.metaKey) return;
      if (!state.imageId) return;
      evt.preventDefault();
      // deltaMode-aware sensitivity: deltaMode=0 (DOM_DELTA_PIXEL) is
      // the common case; line-mode (1) and page-mode (2) are rare but
      // we scale them to match per-event amplitude.
      const lineHeight = 16, pageHeight = 800;
      let dy = evt.deltaY;
      if (evt.deltaMode === 1) dy *= lineHeight;
      else if (evt.deltaMode === 2) dy *= pageHeight;
      const factor = Math.exp(-dy * ZOOM_SENSITIVITY);
      const oldScale = state._zoomScale || 1;
      let newScale = oldScale * factor;
      newScale = Math.max(0.1, Math.min(10, newScale));
      if (Math.abs(newScale - oldScale) < 1e-6) return;
      const wrapRect = canvasWrap.getBoundingClientRect();
      const cursorX = evt.clientX - wrapRect.left + canvasWrap.scrollLeft;
      const cursorY = evt.clientY - wrapRect.top  + canvasWrap.scrollTop;
      const ratio = newScale / oldScale;
      state._zoomScale = newScale;
      renderAll();
      canvasWrap.scrollLeft = cursorX * ratio - (evt.clientX - wrapRect.left);
      canvasWrap.scrollTop  = cursorY * ratio - (evt.clientY - wrapRect.top);
      setStatus(`Zoom ${(newScale * 100).toFixed(0)}%. Wheel to adjust, right-click drag to pan.`);
    }, { passive: false });

    // Right-click drag to pan. We key off button === 2 so left-click
    // operations (drag select / draw / etc.) on the SVG are
    // untouched. Captured at the canvas-wrap level so panning works
    // even when starting in the empty margin area outside the gel.
    let _panState = null;
    canvasWrap.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 2) return;  // right click only
      if (!state.imageId) return;
      evt.preventDefault();
      _panState = {
        pointerId: evt.pointerId,
        startClientX: evt.clientX,
        startClientY: evt.clientY,
        startScrollLeft: canvasWrap.scrollLeft,
        startScrollTop: canvasWrap.scrollTop,
      };
      canvasWrap.style.cursor = "grabbing";
      try { canvasWrap.setPointerCapture(evt.pointerId); } catch (_) {}
    });
    canvasWrap.addEventListener("pointermove", (evt) => {
      if (!_panState || _panState.pointerId !== evt.pointerId) return;
      evt.preventDefault();
      const dx = evt.clientX - _panState.startClientX;
      const dy = evt.clientY - _panState.startClientY;
      // Pan is the OPPOSITE of cursor motion: dragging right pulls the
      // content right, which is achieved by SCROLLING LEFT.
      canvasWrap.scrollLeft = _panState.startScrollLeft - dx;
      canvasWrap.scrollTop  = _panState.startScrollTop  - dy;
    });
    const endPan = (evt) => {
      if (!_panState) return;
      if (evt && _panState.pointerId !== evt.pointerId) return;
      try { canvasWrap.releasePointerCapture(_panState.pointerId); } catch (_) {}
      _panState = null;
      canvasWrap.style.cursor = "";
    };
    canvasWrap.addEventListener("pointerup", endPan);
    canvasWrap.addEventListener("pointercancel", endPan);
    // Suppress the browser's right-click context menu over the canvas
    // so a click-and-drag pan doesn't pop a menu when released.
    canvasWrap.addEventListener("contextmenu", (evt) => {
      if (state.imageId) evt.preventDefault();
    });
  }
}

// ── Toolbar dropdowns (Project ▾, Export ▾) ─────────────────────────
//
// Two compact dropdowns replace the original four flat buttons (Save,
// Load, Export PNG, Export SVG). The hidden originals — kept in the
// DOM as targets for the existing event handlers in this file — are
// triggered via .click() from the menu items, so we don't have to
// duplicate any of the save / load / export logic here.
//
// Menus are siblings of <header> (not children) so the header's
// overflow-y: hidden doesn't clip them. JS positions each menu via
// `position: fixed` directly under its toggle button so they always
// anchor correctly regardless of toolbar horizontal scroll.
//
// Outside-click and Escape both close all open dropdowns. Clicking a
// disabled menu item is a no-op (the underlying handler is gated on
// state.imageId anyway, and the menu item's `disabled` attr is kept
// in sync via the NEEDS_IMAGE array).
{
  const DROPDOWNS = [
    { btnId: "project-dd-btn", menuId: "project-dd-menu" },
    { btnId: "export-dd-btn",  menuId: "export-dd-menu"  },
  ];

  function closeAllDropdowns() {
    DROPDOWNS.forEach(({menuId}) => {
      const m = document.getElementById(menuId);
      if (m) { m.classList.remove("open"); m.hidden = true; }
    });
  }

  function openDropdown(btn, menu) {
    closeAllDropdowns();
    // Show first so offsetWidth measures correctly, then position.
    menu.hidden = false;
    menu.classList.add("open");
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    // Right-align the menu to the toggle's right edge — matches the
    // "drop-down to the left" pattern users expect from buttons near
    // the right end of a toolbar. Clamp to a 4px viewport margin so a
    // narrow window can't push the menu off-screen.
    let left = r.right - menu.offsetWidth;
    if (left < 4) left = 4;
    menu.style.left = left + "px";
  }

  DROPDOWNS.forEach(({btnId, menuId}) => {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      if (btn.disabled) return;
      e.stopPropagation();
      if (menu.classList.contains("open")) closeAllDropdowns();
      else openDropdown(btn, menu);
    });
  });

  // Menu-item click → forward to the corresponding hidden handler.
  // For the Load action we click the <input type="file"> directly,
  // which opens the OS file picker; for everything else we click the
  // hidden <button> so its existing change/click listener runs.
  document.querySelectorAll(".dropdown-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      closeAllDropdowns();
      const action = item.dataset.action;
      const targetId =
        action === "project-save" ? "save-btn" :
        action === "project-load" ? "load-input" :
        action === "export-png"   ? "export-png-btn" :
        action === "export-svg"   ? "export-svg-btn" : null;
      const target = targetId && document.getElementById(targetId);
      if (target) target.click();
    });
  });

  // Outside-click and Escape both close the menu. We attach to document
  // (not window) and use the capture phase implicitly — by NOT calling
  // stopPropagation in the toggle handler above, the document handler
  // runs AFTER the toggle, so we'd accidentally close what we just
  // opened. The stopPropagation in the toggle prevents that race.
  document.addEventListener("click", (e) => {
    if (e.target.closest(".dropdown-toggle")) return;
    if (e.target.closest(".dropdown-menu")) return;
    closeAllDropdowns();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllDropdowns();
  });
  // Close on window resize / scroll so the floating menu doesn't end
  // up detached from its toggle button after the layout shifts.
  window.addEventListener("resize", closeAllDropdowns);
  window.addEventListener("scroll", closeAllDropdowns, true);
}

function drawRegionPreview() {
  const prev = svg.querySelector('[data-role="region-preview"]'); if (prev) prev.remove();
  const L = computeLayout();
  const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
  const x1 = Math.max(drag.x0, drag.x1), y1 = Math.max(drag.y0, drag.y1);
  svg.appendChild(el("rect", {
    x: imgToSvgX(L, x0), y: imgToSvgY(L, y0),
    width: x1 - x0, height: y1 - y0,
    fill: "rgba(61,139,224,0.18)", stroke: "#3d8be0",
    "stroke-width": 2.5, "stroke-dasharray": "8,4",
    // pointer-events: none — the preview rectangle must not block subsequent
    // pointermove events, which target the SVG underneath.
    "pointer-events": "none",
    "data-role": "region-preview", "data-export-hide": "true",
  }));
}

// ── Pending-text-annotation typing ──────────────────────────────────
//
// Commit semantics: a pending text annotation (just placed via the +Text
// tool) is committed when the user presses Enter, Escape, or clicks anywhere
// (including outside the SVG). On commit, if the text is still empty the
// annotation is REMOVED — a click without typing should not leave invisible
// orphan annotations cluttering the project file.
function commitPendingText(reason) {
  if (!state.pendingTextAnn) return;
  const id = state.pendingTextAnn;
  state.pendingTextAnn = null;
  const ann = state.annotations.find((a) => a.id === id);
  let kept = false;
  if (ann && ann.text.trim() === "") {
    // Empty → drop it. If the user had selected it, also clear selection
    // so the sidebar doesn't show a stale "selected (text)" panel.
    state.annotations = state.annotations.filter((a) => a.id !== id);
    if (state.selected && state.selected.kind === "annotation" && state.selected.id === id) {
      state.selected = null;
      refreshSelectionPanel();
    }
  } else if (ann) {
    kept = true;
  }
  if (reason) setStatus(reason);
  renderAll();
  // Only commit history when a non-empty text annotation was actually
  // saved — discarding an empty placeholder isn't an undoable user action.
  if (kept) commitHistory(`Add text “${ann.text}”`);
}

// True if `el` is something the user is actively typing into / interacting
// with via keystrokes. Used by the keyboard-shortcut handler to bail out
// so single-letter keys land in the field (or trigger select type-ahead)
// instead of being hijacked as global shortcuts. Covers:
//   • INPUT      — text/number/color/checkbox (all of them, defensively)
//   • TEXTAREA   — none in current UI but defensive against future use
//   • SELECT     — has built-in first-letter type-ahead (s → "Solid")
//   • contentEditable — table cells, column-rename header span
function isTextEntryFocused(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (state.pendingTextAnn) {
    const ann = state.annotations.find((a) => a.id === state.pendingTextAnn);
    if (!ann) { state.pendingTextAnn = null; return; }
    if (e.key === "Escape") { commitPendingText("Text cancelled."); return; }
    if (e.key === "Enter")  { commitPendingText("Text committed."); return; }
    if (e.key === "Backspace") { ann.text = ann.text.slice(0, -1); e.preventDefault(); renderAll(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      ann.text += e.key; e.preventDefault(); renderAll(); return;
    }
  }
  // Global shortcut: Esc cancels in-flight drag first (region-draw,
  // region-resize, ann-line-draw, etc.); if nothing is being dragged, falls
  // back to clearing selection. This is what users press when they realize
  // they started a wrong drag.
  if (e.key === "Escape") {
    if (state.rotateMode) {
      // In rotate mode but not yet dragging → exit cleanly. If a drag IS
      // in flight the cancelDrag branch below catches rotate-drag and
      // routes through exitRotateMode anyway.
      if (!drag) { e.preventDefault(); exitRotateMode(false); return; }
    }
    if (drag) {
      e.preventDefault();
      cancelDrag("Cancelled.");
      return;
    }
    clearSelection();
    if (state._selectedTick !== null) {
      state._selectedTick = null;
      renderAll();
    }
    if (state._regionSelected) {
      state._regionSelected = false;
      renderAll();
    }
    // Clear any active cell-range selection (mirrors Excel: Esc cancels
    // a multi-cell drag). The highlight is on td.editable elements
    // inside the metadata table; remove the class directly here so
    // we don't depend on rebuildTable being called.
    if (state._cellRange) {
      state._cellRange = null;
      document.querySelectorAll("#metadata-table td.editable.cell-selected")
        .forEach((td) => td.classList.remove("cell-selected"));
    }
  }
  // Delete key removes selected annotation/label, or every element in
  // the multi-selection. Skipped if the user is editing a text field.
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.pendingTextAnn) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.isContentEditable)) return;
    if (state._multiSelected.length > 0) {
      e.preventDefault();
      // Bulk delete all multi-selected elements in one history entry.
      // Ladder-band labels (key prefix "band-") delete the band entry
      // itself — that also removes the in-lane tick line, since the
      // tick is rendered only when state.bands[lane] contains a record
      // with that id. Regular label keys (lane numbers, brackets, row
      // labels) get a `hidden` flag on their override so the renderer
      // skips them; clearing only the dx/dy/etc. wouldn't actually
      // make them disappear because the renderer rebuilds them from
      // layout state every frame.
      const refs = state._multiSelected.slice();
      let nDel = 0;
      refs.forEach((r) => {
        if (r.kind === "annotation") {
          const before = state.annotations.length;
          state.annotations = state.annotations.filter((a) => a.id !== r.id);
          if (state.annotations.length !== before) nDel++;
        } else if (r.kind === "label") {
          if (deleteBandIfBandKey(r.key)) {
            nDel++;
          } else {
            setOverride(r.key, { hidden: true });
            nDel++;
          }
        }
      });
      state._multiSelected = [];
      renderAll(); refreshSelectionPanel();
      if (nDel > 0) commitHistory(`Delete ${nDel} element${nDel === 1 ? "" : "s"}`);
      return;
    }
    if (state.selected) {
      e.preventDefault();
      $("sel-delete").click();
    }
  }
  // Undo / Redo. Ctrl+Z = undo, Ctrl+Y or Ctrl+Shift+Z = redo. Don't
  // trigger when typing in an input/contenteditable — the OS / browser
  // will handle text-field undo there. macOS uses Cmd; we accept both.
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    if (isTextEntryFocused(e.target)) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
    if (isTextEntryFocused(e.target)) return;
    e.preventDefault();
    redo();
    return;
  }

  // ── Single-key shortcuts ────────────────────────────────────────────
  // D draw, T text, R rotate-CW, I invert, S saturation, H hide-ladders,
  // L LUT popover, O options popover, + add column. All require an image
  // to be loaded (the actions need state) and skip when:
  //   • the user is typing in an INPUT / TEXTAREA / SELECT / contenteditable
  //     element. SELECT supports first-letter type-ahead — typing "s" in
  //     opt-line-style jumps to "Solid" — so we MUST skip there too.
  //   • a text annotation is mid-typing (state.pendingTextAnn) — that
  //     handler ran above and consumed the key already, so this path is
  //     unreachable then, but the explicit check makes the intent clear
  //   • any modifier key is held (Ctrl+S = save in browser, etc.)
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTextEntryFocused(e.target)) return;
  if (state.pendingTextAnn) return;
  if (!state.imageId) return;
  switch (e.key) {
    case "d": case "D": e.preventDefault(); $("draw-region-btn").click(); return;
    case "t": case "T": e.preventDefault(); $("add-text-btn").click(); return;
    case "l": case "L": e.preventDefault(); $("add-line-btn").click(); return;
    case "c": case "C": e.preventDefault(); $("crop-btn").click(); return;
    case "r": case "R": e.preventDefault(); $("rotate-btn").click(); return;
    case "i": case "I": e.preventDefault(); $("invert-btn").click(); return;
    case "s": case "S": e.preventDefault(); $("saturation-btn").click(); return;
    case "h": case "H": e.preventDefault(); $("hide-ladders-btn").click(); return;
    case "o": case "O": e.preventDefault(); $("options-btn").click(); return;
    // "+" requires Shift on US keyboards (= → +). Accept both.
    case "+": case "=": e.preventDefault(); addColumn(); return;
  }
});

// Toolbar Undo/Redo buttons
$("undo-btn").addEventListener("click", () => undo());
$("redo-btn").addEventListener("click", () => redo());

// Native clipboard copy when a cell range is selected. Builds a TSV
// (tab-separated cells, newline-separated rows) and writes it to the
// clipboardData. The browser's default copy would only capture text
// inside the focused cell; we want the entire rectangular range.
//
// Trigger: standard Ctrl+C / Cmd+C (the browser fires a "copy" event).
// We only intercept when state._cellRange covers more than one cell —
// single-cell selections fall through to default browser behavior so
// in-cell text selections work normally.
document.addEventListener("copy", (e) => {
  const r = state._cellRange;
  if (!r) return;
  const r1 = Math.min(r.startRow, r.endRow);
  const r2 = Math.max(r.startRow, r.endRow);
  const c1 = Math.min(r.startCol, r.endCol);
  const c2 = Math.max(r.startCol, r.endCol);
  const cells = (r2 - r1 + 1) * (c2 - c1 + 1);
  if (cells <= 1) return;
  const lines = [];
  for (let row = r1; row <= r2; row++) {
    const rowCells = [];
    for (let col = c1; col <= c2; col++) {
      const cid = state.columns[col]?.id;
      const v = (state.cells[cid] || [])[row] || "";
      rowCells.push(v);
    }
    lines.push(rowCells.join("\t"));
  }
  const tsv = lines.join("\n");
  e.clipboardData.setData("text/plain", tsv);
  e.preventDefault();
  setStatus(`Copied ${(r2 - r1 + 1)} × ${(c2 - c1 + 1)} cells.`);
});

// ── Crop to region ───────────────────────────────────────────────────
//
// Toggles state.croppedToRegion. When ON, the image clip-path restricts
// pixels to the user's region; when OFF (default after a fresh region
// draw), the full image shows with the region as an overlay outline.
// Disabled until both an image AND a region exist — without a region
// there's nothing to crop to.
$("crop-btn").addEventListener("click", () => {
  if (!state.region) {
    setStatus("Draw a region first, then crop to it.", true);
    return;
  }
  state.croppedToRegion = !state.croppedToRegion;
  $("crop-btn").classList.toggle("toggle-on", state.croppedToRegion);
  renderAll();
  setStatus(state.croppedToRegion
    ? "Cropped to region. Toggle off to see the full image again."
    : "Showing full image. Region drawn as overlay.");
  commitHistory(state.croppedToRegion ? "Crop to region" : "Show full image");
});

// ── Hide ladders ─────────────────────────────────────────────────────
//
// Collapses the visible region to exclude flank ladder lanes — the
// image, the region outline, and the tick marks all shrink to fit just
// the inner non-flank-ladder lanes. Band labels still render outside
// the (now smaller) gel area. Implies a crop, so the canvas dimensions
// also shrink to the collapsed bounds.
$("hide-ladders-btn").addEventListener("click", () => {
  if (!state.ladder.some(Boolean)) {
    // Defensive — the button is disabled in this state, but in case the
    // shortcut fires before the disable propagates, no-op cleanly.
    setStatus("Mark at least one lane as a ladder before hiding ladders.", true);
    return;
  }
  state.hideLadders = !state.hideLadders;
  $("hide-ladders-btn").classList.toggle("toggle-on", state.hideLadders);
  renderAll();
  setStatus(state.hideLadders
    ? "Hide ladders on. Region collapsed to exclude flank ladder lanes."
    : "Hide ladders off.");
  commitHistory(`${state.hideLadders ? "Enable" : "Disable"} hide-ladders`);
});

// ── Saturation overlay ──────────────────────────────────────────────
$("saturation-btn").addEventListener("click", async () => {
  if (!state.imageId) return;
  state.showSaturation = !state.showSaturation;
  $("saturation-btn").classList.toggle("toggle-on", state.showSaturation);
  if (state.showSaturation && !state.satOverlayUrl) {
    setStatus("Computing saturation overlay…");
    await loadSaturation();
  }
  renderAll();
  setStatus(state.showSaturation
    ? "Saturation overlay on. Red pixels are clipped (over-exposed)."
    : "Saturation overlay off.");
  commitHistory(`${state.showSaturation ? "Show" : "Hide"} saturation overlay`);
});

// ── Invert ───────────────────────────────────────────────────────────
$("invert-btn").addEventListener("click", () => {
  state.invertImage = !state.invertImage;
  $("invert-btn").classList.toggle("toggle-on", state.invertImage);
  document.body.classList.toggle("inverted", state.invertImage);
  renderAll();
  commitHistory(`${state.invertImage ? "Invert" : "Un-invert"} image`);
});

// ── LUT popover ──────────────────────────────────────────────────────
//
// The popover hosts an interactive graph (histogram + LUT curve + three
// draggable handles) PLUS the existing min/max/gamma number inputs for
// precise typing. The graph and inputs are bidirectionally linked: drag
// a handle → input updates → applyLut(); type in input → graph re-renders.
const lutBtn = $("lut-btn"), lutMenu = $("lut-menu"), lutGraph = $("lut-graph");

// Histogram cache. Keyed by imageId so re-uploads invalidate. Fetched on
// first popover open after upload. `null` means "not fetched yet"; once
// populated, it stays valid until imageId changes.
let _histogramCache = { imageId: null, bins: null, edges: null };

async function fetchHistogramIfNeeded() {
  if (!state.imageId) return null;
  if (_histogramCache.imageId === state.imageId && _histogramCache.bins) return _histogramCache;
  try {
    const r = await fetch(`/api/image/${state.imageId}/histogram?bins=128`);
    if (!r.ok) return null;
    const data = await r.json();
    _histogramCache = { imageId: state.imageId, bins: data.bins, edges: data.edges };
    return _histogramCache;
  } catch (_) { return null; }
}

// Layout constants for the LUT graph. Inset axes leave room for tick
// labels; the inner box is where the histogram + curve actually draw.
const LUT_GRAPH = { W: 320, H: 180, padL: 30, padR: 12, padT: 10, padB: 22 };
function lutGraphBox() {
  const G = LUT_GRAPH;
  return { x0: G.padL, x1: G.W - G.padR, y0: G.padT, y1: G.H - G.padB };
}
function lutInputXtoSvg(v) {
  // Map raw intensity v ∈ [rawMin, rawMax] to SVG x in the graph box.
  const b = lutGraphBox();
  const range = Math.max(1e-6, state.rawMax - state.rawMin);
  return b.x0 + (v - state.rawMin) / range * (b.x1 - b.x0);
}
function lutSvgXtoInput(sx) {
  const b = lutGraphBox();
  const range = state.rawMax - state.rawMin;
  return state.rawMin + (sx - b.x0) / (b.x1 - b.x0) * range;
}
function lutOutputYtoSvg(out01) {
  // out01 ∈ [0, 1] → SVG y (flipped because SVG y increases downward).
  const b = lutGraphBox();
  return b.y1 - out01 * (b.y1 - b.y0);
}

// Render the LUT graph: histogram bars, LUT curve, three handles. Pure
// function — re-called on every state change while the popover is open.
function renderLutGraph() {
  if (!lutGraph) return;
  while (lutGraph.firstChild) lutGraph.removeChild(lutGraph.firstChild);
  const NS = SVG_NS;
  const G = LUT_GRAPH; const b = lutGraphBox();

  const make = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    return e;
  };

  // Histogram bars (drawn first → end up behind the curve)
  const hist = _histogramCache.bins || [];
  if (hist.length) {
    const maxCount = Math.max(1, ...hist);
    const barW = (b.x1 - b.x0) / hist.length;
    hist.forEach((c, i) => {
      const h = (c / maxCount) * (b.y1 - b.y0);
      lutGraph.appendChild(make("rect", {
        class: "lut-hist",
        x: b.x0 + i * barW, y: b.y1 - h, width: Math.max(0.5, barW - 0.5), height: h,
      }));
    });
  }

  // Axes (x along bottom, y along left)
  lutGraph.appendChild(make("line", { class: "lut-axis", x1: b.x0, y1: b.y1, x2: b.x1, y2: b.y1 }));
  lutGraph.appendChild(make("line", { class: "lut-axis", x1: b.x0, y1: b.y0, x2: b.x0, y2: b.y1 }));
  lutGraph.appendChild(make("text", { class: "lut-axis-label", x: b.x0, y: G.H - 6, "text-anchor": "start" }, formatLutAxisValue(state.rawMin)));
  lutGraph.appendChild(make("text", { class: "lut-axis-label", x: b.x1, y: G.H - 6, "text-anchor": "end" },   formatLutAxisValue(state.rawMax)));
  lutGraph.appendChild(make("text", { class: "lut-axis-label", x: b.x0 - 4, y: b.y1 + 3, "text-anchor": "end" }, "0"));
  lutGraph.appendChild(make("text", { class: "lut-axis-label", x: b.x0 - 4, y: b.y0 + 8, "text-anchor": "end" }, "255"));

  // LUT curve. Below lut_min → output 0; above lut_max → output 1; in
  // between → t = (v - min) / (max - min), output = t^(1/gamma).
  // Sample 64 points across the visible input range so the curve is
  // smooth even when gamma != 1.
  const lo = state.lut.min, hi = state.lut.max, gamma = state.lut.gamma;
  const N = 64;
  const points = [];
  for (let i = 0; i <= N; i++) {
    const v = state.rawMin + (i / N) * (state.rawMax - state.rawMin);
    let out01;
    if (v <= lo) out01 = 0;
    else if (v >= hi) out01 = 1;
    else {
      let t = (v - lo) / Math.max(1e-9, hi - lo);
      out01 = (gamma > 0 && gamma !== 1) ? Math.pow(t, 1 / gamma) : t;
    }
    points.push(`${lutInputXtoSvg(v).toFixed(2)},${lutOutputYtoSvg(out01).toFixed(2)}`);
  }
  lutGraph.appendChild(make("polyline", { class: "lut-curve", points: points.join(" ") }));

  // Black-point handle — circle at (lut_min, 0). User drags it to set
  // lut_min. clamped to [rawMin, lut_max - epsilon].
  const minX = lutInputXtoSvg(lo);
  const maxX = lutInputXtoSvg(hi);
  const minHandle = make("circle", {
    class: "lut-handle min", cx: minX, cy: b.y1, r: 6,
    fill: "#000", "data-lut-handle": "min",
  });
  lutGraph.appendChild(minHandle);

  // White-point handle — circle at (lut_max, 1). User drags to set lut_max.
  const maxHandle = make("circle", {
    class: "lut-handle max", cx: maxX, cy: b.y0, r: 6,
    fill: "#fff", stroke: "#000", "stroke-width": 1.5,
    "data-lut-handle": "max",
  });
  lutGraph.appendChild(maxHandle);

  // Gamma midpoint handle — sits ON the curve at the midpoint of [lo, hi].
  // Drag UP/DOWN: gamma decreases (curve dips low) / increases (curve
  // arcs high). Horizontal drags are ignored.
  const midV = (lo + hi) / 2;
  const midX = lutInputXtoSvg(midV);
  let midOut01 = 0.5;
  if (midV > lo && midV < hi) {
    const t = (midV - lo) / (hi - lo);
    midOut01 = (gamma > 0 && gamma !== 1) ? Math.pow(t, 1 / gamma) : t;
  }
  const midY = lutOutputYtoSvg(midOut01);
  const midHandle = make("circle", {
    class: "lut-handle gamma", cx: midX, cy: midY, r: 5,
    fill: "#3d8be0", "data-lut-handle": "gamma",
  });
  lutGraph.appendChild(midHandle);
}

function formatLutAxisValue(v) {
  // Compact axis label: integer for typical 8-bit images, fixed-point
  // for larger ranges (16-bit gel scans go up to 65535).
  if (Math.abs(v) >= 1000) return Math.round(v).toString();
  if (Math.abs(v) >= 10)   return v.toFixed(0);
  return v.toFixed(2);
}

// Drag handlers for the three LUT handles. Pointer-capture-based so the
// user can drag past the SVG edges.
//
// Throttled apply: debouncing the loadPreview() call would skip the
// snappy live-preview the user expects. Instead we update state.lut +
// inputs synchronously on every pointermove (cheap), and only re-fetch
// the preview on pointerup. The graph re-renders synchronously so the
// curve follows the cursor without server round-trips.
let _lutDrag = null;
lutGraph.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (!t || !t.dataset || !t.dataset.lutHandle) return;
  e.preventDefault();
  _lutDrag = { kind: t.dataset.lutHandle, pointerId: e.pointerId, startClientY: e.clientY, startGamma: state.lut.gamma };
  try { lutGraph.setPointerCapture(e.pointerId); } catch (_) {}
});
lutGraph.addEventListener("pointermove", (e) => {
  if (!_lutDrag) return;
  if (_lutDrag.pointerId != null && e.pointerId !== _lutDrag.pointerId) return;
  const rect = lutGraph.getBoundingClientRect();
  const G = LUT_GRAPH;
  // Convert client coords into the SVG's viewBox (uniform scale).
  const sx = (e.clientX - rect.left) / rect.width  * G.W;
  const sy = (e.clientY - rect.top)  / rect.height * G.H;
  if (_lutDrag.kind === "min") {
    let v = lutSvgXtoInput(sx);
    v = Math.max(state.rawMin, Math.min(state.lut.max - 1e-3, v));
    state.lut.min = v;
    $("lut-min").value = (v % 1 === 0 ? v.toFixed(0) : v.toFixed(2));
  } else if (_lutDrag.kind === "max") {
    let v = lutSvgXtoInput(sx);
    v = Math.max(state.lut.min + 1e-3, Math.min(state.rawMax, v));
    state.lut.max = v;
    $("lut-max").value = (v % 1 === 0 ? v.toFixed(0) : v.toFixed(2));
  } else if (_lutDrag.kind === "gamma") {
    // Vertical drag → gamma. Match what the user expects from the LUT
    // graph: dragging the midpoint UP arches the curve UP (brighter
    // mid-tones), which mathematically means INCREASING gamma. The
    // earlier sign convention had this backwards (drag-up decreased
    // gamma), confusing users who think of "up = brighter".
    //
    //   out = t^(1/gamma)
    //   gamma > 1: 1/gamma < 1 ⇒ curve arches UP    (out > t for t∈(0,1))
    //   gamma < 1: 1/gamma > 1 ⇒ curve dips DOWN
    //
    // SVG y increases downward, so dragging UP gives a NEGATIVE clientY
    // delta — negate so positive factor = upward = gamma↑.
    const totalDy = (e.clientY - _lutDrag.startClientY) / rect.height * G.H;
    const factor = Math.exp(-totalDy * 0.025);
    const newGamma = Math.max(0.1, Math.min(5, _lutDrag.startGamma * factor));
    state.lut.gamma = newGamma;
    $("lut-gamma").value = newGamma.toFixed(2);
  }
  refreshLutReadout();
  renderLutGraph();
});
lutGraph.addEventListener("pointerup", async (e) => {
  if (!_lutDrag) return;
  const kind = _lutDrag.kind;
  try { lutGraph.releasePointerCapture(_lutDrag.pointerId); } catch (_) {}
  _lutDrag = null;
  // Sync the input fields to state, then trigger applyLut for the
  // server preview re-fetch + history commit.
  $("lut-min").value = state.lut.min;
  $("lut-max").value = state.lut.max;
  $("lut-gamma").value = state.lut.gamma;
  await applyLut(`Set LUT ${kind}`);
});

lutBtn.addEventListener("click", async () => {
  const open = lutMenu.classList.toggle("show");
  if (open) {
    const r = lutBtn.getBoundingClientRect();
    lutMenu.style.left = `${r.left}px`; lutMenu.style.top = `${r.bottom + 4}px`;
    refreshLutReadout();
    // Fetch histogram lazily on first open per imageId — kept off the
    // critical upload path so it doesn't extend the "Loading..." state.
    await fetchHistogramIfNeeded();
    renderLutGraph();
  }
});
function refreshLutReadout() {
  $("lut-readout-min").textContent = formatLutAxisValue(state.lut.min);
  $("lut-readout-max").textContent = formatLutAxisValue(state.lut.max);
  $("lut-readout-gamma").textContent = `γ: ${(+state.lut.gamma).toFixed(2)}`;
}
async function applyLut(commitLabel) {
  state.lut = {
    min:   parseFloat($("lut-min").value)   || 0,
    max:   parseFloat($("lut-max").value)   || 255,
    gamma: Math.max(0.1, parseFloat($("lut-gamma").value) || 1),
  };
  refreshLutReadout(); renderLutGraph(); await loadPreview(); renderAll();
  if (commitLabel) commitHistory(commitLabel);
}
["lut-min","lut-max","lut-gamma"].forEach(id => $(id).addEventListener("change", () => applyLut(`Set LUT ${id.replace("lut-", "")}`)));
$("lut-reset").addEventListener("click", async () => {
  state.lut = { min: state.rawMin, max: state.rawMax, gamma: 1.0 };
  $("lut-min").value = state.lut.min; $("lut-max").value = state.lut.max; $("lut-gamma").value = state.lut.gamma;
  await applyLut("Reset LUT");
});
document.addEventListener("click", (e) => {
  if (!lutMenu.contains(e.target) && e.target !== lutBtn) lutMenu.classList.remove("show");
});

// ── Options popover ──────────────────────────────────────────────────
const optBtn = $("options-btn"), optMenu = $("options-menu");
optBtn.addEventListener("click", () => {
  const open = optMenu.classList.toggle("show");
  if (open) {
    const r = optBtn.getBoundingClientRect();
    optMenu.style.right = `${window.innerWidth - r.right}px`; optMenu.style.top = `${r.bottom + 4}px`;
  }
});
$("opt-region-outline").addEventListener("change", (e) => { state.regionOutline = e.target.checked; renderAll(); commitHistory(`${e.target.checked ? "Show" : "Hide"} region outline`); });
$("opt-line-style").addEventListener("change", (e) => { state.bracketLineStyle = e.target.value; renderAll(); commitHistory(`Bracket line style: ${e.target.value}`); });
$("opt-line-cap").addEventListener("change", (e) => { state.lineCap = e.target.value; renderAll(); commitHistory(`Line cap: ${e.target.value}`); });
$("opt-tick-height").addEventListener("change", (e) => {
  const v = Math.max(2, Math.min(60, parseFloat(e.target.value) || 10));
  e.target.value = String(v);  // reflect clamped value back
  state.tickHeight = v; renderAll();
  commitHistory(`Set tick height to ${v}`);
});
$("opt-region-border-width").addEventListener("change", (e) => {
  const v = Math.max(0.5, Math.min(20, parseFloat(e.target.value) || 2));
  e.target.value = String(v);
  state.regionBorderWidth = v; renderAll();
  commitHistory(`Set region border thickness to ${v}`);
});
$("opt-tick-width").addEventListener("change", (e) => {
  const v = Math.max(0.5, Math.min(20, parseFloat(e.target.value) || 2));
  e.target.value = String(v);
  state.tickWidth = v; renderAll();
  commitHistory(`Set tick thickness to ${v}`);
});
// Background color: live local preview while dragging the picker (no history
// churn), committed once on `change`. "Auto" clears the override back to
// white / dark-on-invert.
$("opt-bg-color").addEventListener("input", (e) => { state.bgColor = e.target.value; renderAll(); });
$("opt-bg-color").addEventListener("change", (e) => {
  state.bgColor = e.target.value; renderAll();
  commitHistory(`Set background color to ${e.target.value}`);
});
$("opt-bg-reset").addEventListener("click", () => {
  if (!state.bgColor) return;            // already auto — nothing to commit
  state.bgColor = ""; renderAll();
  $("opt-bg-color").value = state.invertImage ? "#1a1a1a" : "#ffffff";
  commitHistory("Reset background color to auto");
});
document.addEventListener("click", (e) => {
  if (!optMenu.contains(e.target) && e.target !== optBtn) optMenu.classList.remove("show");
});

// ── Splitter ─────────────────────────────────────────────────────────
const splitter = $("splitter"); let splitDrag = false;
splitter.addEventListener("pointerdown", (e) => { splitDrag = true; splitter.classList.add("dragging"); splitter.setPointerCapture(e.pointerId); });
splitter.addEventListener("pointermove", (e) => {
  if (!splitDrag) return;
  const w = Math.max(220, Math.min(window.innerWidth - 200, window.innerWidth - e.clientX));
  document.querySelector("main").style.gridTemplateColumns = `1fr 6px ${w}px`;
});
splitter.addEventListener("pointerup", () => { splitDrag = false; splitter.classList.remove("dragging"); });

// ── Band panel ───────────────────────────────────────────────────────
function updateBandPanel() {
  const panel = $("band-panel");
  const ladders = []; for (let i = 0; i < state.laneCount; i++) if (state.ladder[i]) ladders.push(i);
  let active = null;
  if (state.selectedLanes.size === 1) { const sel = [...state.selectedLanes][0]; if (state.ladder[sel]) active = sel; }
  if (active === null && ladders.length === 1) active = ladders[0];
  if (active === null) { panel.style.display = "none"; state._bandTargetLane = null; return; }
  panel.style.display = "block";
  $("band-panel-lane").textContent = `(lane ${active + 1})`;
  // Auto-detect + preset controls. Built once per updateBandPanel and
  // re-bound to `active`. We render them above the list so they're always
  // visible — even when no bands exist yet, the user wants the auto-detect
  // button right there.
  const controls = $("band-panel-controls");
  controls.innerHTML = `
    <div class="band-controls-row">
      <button class="button" id="band-autodetect-btn" title="Find peaks in this lane and create a band at each, labelled '?'.">Auto-detect bands</button>
      <select id="band-preset-select" title="Apply a common-ladder preset bottom-up to the existing bands.">
        <option value="">Apply preset…</option>
        ${["protein", "dna", "rna"].map((kind) => `
          <optgroup label="${kind.toUpperCase()}">
            ${Object.keys(LADDER_PRESETS[kind]).map((name) =>
              `<option value="${kind}::${escapeHtml(name)}">${escapeHtml(name)}</option>`
            ).join("")}
          </optgroup>`).join("")}
      </select>
    </div>`;
  $("band-autodetect-btn").addEventListener("click", () => autoDetectBands(active));
  $("band-preset-select").addEventListener("change", (e) => {
    const v = e.target.value; e.target.value = "";  // reset so the same preset can re-apply
    if (!v) return;
    const [kind, name] = v.split("::", 2);
    applyLadderPreset(active, kind, name);
  });

  const list = $("band-panel-list"); list.innerHTML = "";
  const bands = state.bands[active] || [];
  if (!bands.length) { list.innerHTML = '<div class="muted">No bands yet — click on the lane in the gel to drop one, or use Auto-detect.</div>'; }
  else {
    bands.forEach((b) => {
      const row = document.createElement("div");
      row.className = "band-row";
      row.innerHTML = `
        <input type="text" value="${escapeHtml(b.label)}" data-bid="${b.id}" />
        <span class="y-coord">y=${Math.round(b.y_center)}</span>
        <button class="x-btn" data-delbid="${b.id}" title="Remove">×</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll("input[data-bid]").forEach((inp) => inp.addEventListener("change", (e) => {
      const b = (state.bands[active] || []).find((x) => x.id === e.target.dataset.bid);
      if (b) {
        const oldLabel = b.label;
        b.label = e.target.value;
        renderAll();
        if (oldLabel !== b.label) commitHistory(`Rename band to “${b.label}”`);
      }
    }));
    list.querySelectorAll("button[data-delbid]").forEach((btn) => btn.addEventListener("click", (e) => {
      const removed = (state.bands[active] || []).find((x) => x.id === e.target.dataset.delbid);
      state.bands[active] = (state.bands[active] || []).filter((x) => x.id !== e.target.dataset.delbid);
      updateBandPanel(); renderAll();
      commitHistory(`Delete band${removed ? " “" + removed.label + "”" : ""}`);
    }));
  }
  state._bandTargetLane = active;
}

// Auto-detect bands by hitting the backend's peak-detection endpoint. The
// detection happens on the FULL-resolution source image (server-side),
// not on the LUT-quantised PNG preview. Results replace any existing
// bands in the lane — the user can undo if they wanted to keep them.
async function autoDetectBands(laneIdx) {
  if (!state.imageId || !state.region) {
    setStatus("Draw a region first, then auto-detect.", true);
    return;
  }
  const lns = computeLanes();
  const lane = lns[laneIdx];
  if (!lane) { setStatus("Select a ladder lane first.", true); return; }
  setStatus("Detecting bands…");
  try {
    const resp = await fetch(`/api/image/${state.imageId}/detect-bands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lane_x_left:  lane.x_left,
        lane_x_right: lane.x_right,
        lane_y_top:   state.region.y,
        lane_y_bot:   state.region.y + state.region.h,
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    if (!data.bands || data.bands.length === 0) {
      setStatus("No bands found — try adjusting the LUT or the region.", true);
      return;
    }
    // Bands come back sorted bottom-up (largest y first). Build state
    // bands in the SAME order so [0] is the bottom band — that's what
    // `applyLadderPreset` expects when it zips preset values onto bands.
    state.bands[laneIdx] = data.bands.map((b) => ({ id: newId(), y_center: b.y, label: "?" }));
    renderAll(); updateBandPanel();
    setStatus(`Found ${data.bands.length} bands. Click any '?' to label, or apply a ladder preset.`);
    commitHistory(`Auto-detect ${data.bands.length} bands in lane ${laneIdx + 1}`);
  } catch (err) {
    setStatus("Detection failed: " + err.message, true);
  }
}

// Apply a preset's labels in BOTTOM-UP order to the lane's existing
// bands. The preset is also stored bottom-up, so we can just zip them.
// Bands beyond the preset's length keep their existing labels (typically
// "?"). If there are FEWER bands than preset entries, extras are skipped.
function applyLadderPreset(laneIdx, kind, name) {
  const preset = LADDER_PRESETS[kind] && LADDER_PRESETS[kind][name];
  if (!preset) return;
  const bands = state.bands[laneIdx] || [];
  if (!bands.length) {
    setStatus("No bands yet — auto-detect or place bands first, then apply a preset.", true);
    return;
  }
  // Bands are stored as the user added them. The convention here: index 0
  // is the bottom-most band (auto-detect creates them this way; manual
  // placement may create them in any order, but we sort by y_center
  // descending before zipping so "bottom-up" is well-defined).
  const ordered = bands.slice().sort((a, b) => b.y_center - a.y_center);
  ordered.forEach((band, i) => {
    if (i < preset.length) band.label = preset[i];
  });
  renderAll(); updateBandPanel();
  setStatus(`Applied “${name}” to ${Math.min(ordered.length, preset.length)} bands.`);
  commitHistory(`Apply preset “${name}”`);
}

// ── Save / Load ──────────────────────────────────────────────────────
$("save-btn").addEventListener("click", () => {
  if (!state.imageId) return;
  const proj = {
    version: 2, image_filename: state.filename, image_data_url: state.imageDataUrl,
    image_width: state.imgWidth, image_height: state.imgHeight,
    lut: state.lut, raw_min: state.rawMin, raw_max: state.rawMax,
    invert_image: state.invertImage, bg_color: state.bgColor,
    region: state.region, region_outline: state.regionOutline,
    cropped_to_region: state.croppedToRegion,
    bracket_line_style: state.bracketLineStyle, line_cap: state.lineCap,
    hide_ladders: state.hideLadders,
    lane_count: state.laneCount, ladder: state.ladder,
    columns: state.columns, cells: state.cells, bands: state.bands,
    lane_separators: state.laneSeparators, tick_height: state.tickHeight,
    ladder_label_dx: state.ladderLabelDx,
    annotations: state.annotations, label_overrides: state.labelOverrides,
    region_border_width: state.regionBorderWidth, tick_width: state.tickWidth,
    column_visible: state.columnVisible,
    show_lane_numbers: state.showLaneNumbers,
    bit_depth: state.bitDepth,
    // Row geometry + concentrations + probe conc. Measured RESULTS are
    // not saved — they're re-derived from the raw image in one click,
    // and persisting them would let a stale number outlive the row that
    // produced it.
    quant: state.quant,
  };
  const blob = new Blob([JSON.stringify(proj, null, 2)], { type: "application/json" });
  download(blob, (state.filename.replace(/\.[^.]+$/, "") || "project") + ".gelproj.json");
});

$("load-input").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const proj = JSON.parse(await f.text());
    if (proj.version !== 1 && proj.version !== 2) throw new Error("Unsupported project version: " + proj.version);
    if (proj.image_data_url) {
      const blob = await (await fetch(proj.image_data_url)).blob();
      const fd = new FormData(); fd.append("file", new File([blob], proj.image_filename || "project.png", { type: blob.type || "image/png" }));
      const resp = await fetch("/api/upload", { method: "POST", body: fd });
      if (!resp.ok) throw new Error("Image upload failed: " + (await resp.text()));
      state.imageId = (await resp.json()).image_id;
    }
    state.filename = proj.image_filename || "";
    state.imgWidth = proj.image_width; state.imgHeight = proj.image_height;
    state.lut = proj.lut || { min: 0, max: 255, gamma: 1 };
    state.rawMin = proj.raw_min || 0; state.rawMax = proj.raw_max || 255;
    state.invertImage = !!proj.invert_image;
    state.bgColor = (typeof proj.bg_color === "string") ? proj.bg_color : "";
    state.imageDataUrl = proj.image_data_url || null;
    state.region = proj.region || null;
    state.regionOutline = proj.region_outline !== false;
    state.croppedToRegion = !!proj.cropped_to_region;
    state.bracketLineStyle = proj.bracket_line_style || "solid";
    state.lineCap = proj.line_cap || "butt";
    state.hideLadders = !!proj.hide_ladders;
    state.laneCount = proj.lane_count || 10;
    state.ladder = proj.ladder || Array(state.laneCount).fill(false);
    state.columns = proj.columns || []; state.cells = proj.cells || {}; state.bands = proj.bands || {};
    // Backward-compat: older projects don't have lane_separators or
    // tick_height. null/undefined falls back to default even spacing /
    // default tick height.
    state.laneSeparators = Array.isArray(proj.lane_separators) ? proj.lane_separators : null;
    state.tickHeight = (typeof proj.tick_height === "number") ? proj.tick_height : 10;
    state.regionBorderWidth = (typeof proj.region_border_width === "number") ? proj.region_border_width : 2;
    state.tickWidth = (typeof proj.tick_width === "number") ? proj.tick_width : 2;
    state.columnVisible = (proj.column_visible && typeof proj.column_visible === "object") ? proj.column_visible : {};
    state.showLaneNumbers = (typeof proj.show_lane_numbers === "boolean") ? proj.show_lane_numbers : true;
    state.bitDepth = (typeof proj.bit_depth === "number") ? proj.bit_depth : 16;
    state.ladderLabelDx = (proj.ladder_label_dx && typeof proj.ladder_label_dx === "object") ? proj.ladder_label_dx : {};
    state._editingBand = null;
    state.annotations = proj.annotations || []; state.labelOverrides = proj.label_overrides || {};
    if (window.FEMSA) FEMSA.adoptSavedState(proj.quant);
    state.selectedLanes.clear(); state.selected = null;
    NEEDS_IMAGE.forEach((id) => $(id).disabled = false);
    $("lane-count").disabled = false; $("lane-minus").disabled = false; $("lane-plus").disabled = false;
    $("lane-count").value = state.laneCount;
    $("lut-min").value = state.lut.min; $("lut-max").value = state.lut.max; $("lut-gamma").value = state.lut.gamma;
    $("opt-region-outline").checked = state.regionOutline;
    $("opt-line-style").value = state.bracketLineStyle; $("opt-line-cap").value = state.lineCap;
    $("opt-tick-height").value = state.tickHeight;
    $("opt-region-border-width").value = state.regionBorderWidth;
    $("opt-tick-width").value = state.tickWidth;
    $("invert-btn").classList.toggle("toggle-on", state.invertImage);
    $("hide-ladders-btn").classList.toggle("toggle-on", state.hideLadders);
    document.body.classList.toggle("inverted", state.invertImage);
    $("empty-state").style.display = "none";
    if (state.imageId) await loadPreview();
    rebuildTable(); renderAll();
    updateHideLaddersBtn(); updateCropBtn();
    applyBitDepthGates();   // gate LUT/saturation per loaded project's bit depth
    setStatus(`Loaded project: ${state.filename}.`);
    // Reset history — undoing past a "load" would mean popping the user
    // into a stale prior project's state, which is confusing. Treat the
    // load as a fresh starting point.
    state.history = []; state.historyIndex = -1;
    commitHistory(`Load project: ${state.filename}`);
  } catch (err) { setStatus("Load failed: " + err.message, true); }
  e.target.value = "";
});

// ── Export ───────────────────────────────────────────────────────────
function buildExportableSvg() {
  const clone = svg.cloneNode(true);
  clone.querySelectorAll('[data-export-hide="true"]').forEach((n) => n.remove());
  const vb = clone.getAttribute("viewBox");
  if (vb) {
    const [, , w, h] = vb.split(/\s+/).map(Number);
    clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
  }
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return clone;
}
$("export-svg-btn").addEventListener("click", () => {
  if (!state.imageId) return;
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(buildExportableSvg());
  download(new Blob([xml], { type: "image/svg+xml" }),
           (state.filename.replace(/\.[^.]+$/, "") || "gel") + "_annotated.svg");
  setStatus("Exported SVG.");
});
$("export-png-btn").addEventListener("click", async () => {
  if (!state.imageId) return;
  const clone = buildExportableSvg();
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image(); img.decoding = "async"; img.src = url;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("SVG → Image decode failed."));
    });
    const [, , w, h] = clone.getAttribute("viewBox").split(/\s+/).map(Number);
    // Output-resolution policy:
    //   • Small gels  → 2× super-sampling for crisp typography.
    //   • Large gels  → cap at MAX_DIM on the longest dimension so
    //     the PNG doesn't balloon to tens of megabytes.
    //
    // Why 3200 px: that's a clean 600-dpi print at ~5.3 inches wide —
    // wider than a single-column journal figure, comfortably more
    // than slide-deck width. Anyone needing larger should use SVG,
    // which is the proper vector deliverable for publication.
    //
    // Previously the export used a fixed 2× scale, so a 4000×3000 px
    // gel produced an 8000×6000 px PNG (~48 MP, 30-50 MB). Now the
    // same input produces 3200×2400 px (~7.7 MP, ~5-10 MB) with no
    // visible quality loss for screen / print at typical figure sizes.
    const MAX_DIM = 3200;
    const BASE_SCALE = 2;
    const scale = Math.min(BASE_SCALE, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width  = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Canvas → PNG encoding returned null.");
    download(blob, (state.filename.replace(/\.[^.]+$/, "") || "gel") + "_annotated.png");
    const mb = (blob.size / (1024 * 1024)).toFixed(2);
    setStatus(`Exported PNG (${canvas.width} × ${canvas.height}, ${mb} MB).`);
  } catch (err) {
    setStatus(`PNG export failed: ${err.message}. Try the SVG export instead.`, true);
  } finally {
    URL.revokeObjectURL(url);
  }
});
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Drag-and-drop image upload ───────────────────────────────────────
//
// Only react to drags that carry FILES from the OS — any internal
// drag-and-drop (e.g., the metadata-table column reorder) advertises
// types like 'text/plain' but NOT 'Files'. Without this guard, a user
// dragging a column header was greeted with the "Drop image to upload"
// overlay, which is wrong and visually disruptive.
//
// `dataTransfer.types` is a DOMStringList in some browsers and a
// regular array in others. Treat it as iterable and check for "Files".
const dropOverlay = $("drop-overlay"); let dragCount = 0;
function dragHasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  // types.contains exists on DOMStringList; arrays / iterables fall
  // through to indexOf via Array.from.
  if (typeof types.contains === "function") return types.contains("Files");
  return Array.from(types).indexOf("Files") !== -1;
}
window.addEventListener("dragenter", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragCount++; dropOverlay.classList.add("show");
});
window.addEventListener("dragleave", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragCount = Math.max(0, dragCount - 1);
  if (dragCount === 0) dropOverlay.classList.remove("show");
});
window.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragCount = 0; dropOverlay.classList.remove("show");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) await uploadImage(f);
});

// ── Init ─────────────────────────────────────────────────────────────
initTableHandlers();
rebuildTable();
renderAll();
// Stash the LUT and saturation buttons' default tooltips so we can
// restore them after a 16-bit image upload re-enables those features
// (applyBitDepthGates swaps the title to a "raw16-only" message for
// 8-bit images). Doing this once at init avoids capturing the
// tooltip AFTER it's already been swapped.
{
  const lutBtn = $("lut-btn"), satBtn = $("saturation-btn");
  if (lutBtn) lutBtn.dataset.defaultTitle = lutBtn.title;
  if (satBtn) satBtn.dataset.defaultTitle = satBtn.title;
}


// ════════════════════════════════════════════════════════════════════
// INFO PANEL + GUIDED TOUR
// ════════════════════════════════════════════════════════════════════
//
// Two small features that share their wiring with the toolbar pills
// (`#info-btn`, `#help-btn`):
//
//   • Info panel — modal overlay listing version, citation, references,
//     methods, and the version history. Read once, dismissed; not part
//     of the workflow.
//   • Guided tour — spotlight-style step-by-step walkthrough of the
//     annotator's main features. Each step targets a `data-tour`
//     element in the DOM, dims the rest of the screen, and shows a
//     card next to the highlighted area.
//
// The tour engine is generic — to add or reorder steps, just edit
// `TOUR_STEPS` below; no other code needs to change.

// ── Info modal ──────────────────────────────────────────────────────
{
  const panel = document.getElementById("info-panel");
  const versionField = document.getElementById("info-version");
  // The version is exposed by the server template via a global
  // `window.SLOTS_VERSION`. If absent (e.g. when the file is loaded
  // out of context for tests), fall back to the literal "1.0.0".
  if (versionField) versionField.textContent = window.SLOTS_VERSION || "1.0.0";

  const open = () => {
    if (!panel) return;
    panel.classList.remove("hidden");
  };
  const close = () => {
    if (!panel) return;
    panel.classList.add("hidden");
  };

  const infoBtn = document.getElementById("info-btn");
  if (infoBtn) infoBtn.addEventListener("click", open);

  // Click on the dimmed backdrop (but NOT the card) closes the panel.
  if (panel) panel.addEventListener("click", (e) => {
    if (e.target === panel) close();
  });
}


// ── Guided tour ─────────────────────────────────────────────────────
//
// State machine:
//   _tourStep = -1       → tour inactive
//   _tourStep = 0..N-1   → that step is showing
// `_renderTourStep()` paints the four spotlight strips around the
// target, places the card with an arrow pointing to it, and binds the
// nav buttons. Re-rendering on every state change is cheap (the
// overlay only contains a handful of absolutely-positioned divs) and
// avoids drift between state and DOM.
let _tourStep = -1;

const TOUR_STEPS = [
  {
    target: "open", title: "1. Open a gel image", position: "bottom",
    desc:
      "Start by loading an image of your gel:" +
      '<div class="tl">Click <b>Open</b>, or drag &amp; drop a file onto the canvas.</div>' +
      '<div class="tl">Supported: PNG, JPEG, TIFF (8-bit), <code>.raw16</code> / 16-bit TIFF.</div>' +
      '<div class="tl">Bio-Rad / GelDoc / ChemiDoc TIFs with imager-baked red highlights are decoded with channel-max so the saturation marks survive.</div>' +
      '<div class="td">8-bit uploads auto-enable the saturation overlay so clipped pixels stand out from the moment the image loads.</div>',
  },
  {
    target: "draw-region", title: "2. Draw the analysis region", position: "bottom",
    desc:
      "Click <b>Draw Region (D)</b> and trace a rectangle around the gel content:" +
      '<div class="tl">Drag from one corner to the opposite to set the bounds.</div>' +
      '<div class="tl">After drawing, click the outline to select it and reveal corner handles for resizing.</div>' +
      '<div class="tl">Lane separators auto-distribute evenly across the width; drag any tick to fine-tune.</div>',
  },
  {
    target: "metadata", title: "3. Label your lanes", position: "left",
    desc:
      "The metadata table on the right drives every label that ends up on the gel:" +
      '<div class="tl">Click a cell and type. <b>Tab</b> / <b>Enter</b> commit and move to the next.</div>' +
      '<div class="tl">Drag-select a rectangular range, then type to fill all selected cells with the same value.</div>' +
      '<div class="tl">Add columns with the <b>+</b> header; drag column headers left / right to reorder.</div>' +
      '<div class="tl">Consecutive cells with the same non-empty value auto-merge into a bracket above the gel.</div>' +
      '<div class="td">Tick the <b>Ladder</b> checkbox on a lane, then click on the gel to drop ladder-size bands.</div>',
  },
  {
    target: "lut", title: "4. Tune the LUT", position: "bottom",
    desc:
      "<b>LUT</b> opens the histogram editor:" +
      '<div class="tl">Drag the black / white / gamma handles to map raw pixel values onto display brightness.</div>' +
      '<div class="tl">The default auto-stretches to the central 98 % (p1 .. p99.5) so dark gels are visible immediately.</div>' +
      '<div class="td">Disabled for 8-bit images — only 16-bit raws have the dynamic range that makes this useful.</div>',
  },
  {
    target: "saturation", title: "5. Saturation overlay", position: "bottom",
    desc:
      "<b>Saturation (S)</b> overlays clipped pixels in red:" +
      '<div class="tl">Threshold is relative to the source dynamic range (default 99.5 %).</div>' +
      '<div class="tl">Tracks the imager&rsquo;s clipped-pixel intent — not the auto-stretched preview &mdash; so it shows you which bands are actually saturated.</div>' +
      '<div class="td">Auto-on for new uploads; toggle off if you want to read the raw band intensities.</div>',
  },
  {
    target: "hide-ladders", title: "6. Hide ladder lanes", position: "bottom",
    desc:
      "<b>Hide Ladders (H)</b> collapses left- and right-flank ladder lanes out of view:" +
      '<div class="tl">Useful for figures that should focus on the data lanes, with the ladder annotated to the side.</div>' +
      '<div class="tl">Internal ladders (between data lanes) stay visible; their labels route to the LEFT.</div>' +
      '<div class="tl">The outer-tick separators stay flush with the (now-collapsed) region outline.</div>',
  },
  {
    target: "rotate", title: "7. Rotate, annotate, free-form", position: "bottom",
    desc:
      "Free-form annotation lives on the toolbar:" +
      '<div class="tl"><b>Rotate (R)</b> &mdash; click and drag on the canvas to rotate the image, or rotate the currently-selected element. Hold <b>Shift</b> to snap to 15° increments.</div>' +
      '<div class="tl"><b>+Text (T)</b> &mdash; click to drop a text label.</div>' +
      '<div class="tl"><b>+Line (L)</b> &mdash; drag to draw a line / arrow. The selection panel turns on the arrowhead.</div>' +
      '<div class="td">Mouse wheel zooms (proportional to delta); right-click drag pans the canvas.</div>',
  },
  {
    target: "save", title: "8. Save your work", position: "bottom",
    desc:
      "<b>Project ▾ → Save</b> downloads a self-contained JSON with the image base64-embedded:" +
      '<div class="tl">Reload anywhere, anytime, without needing the original raw image.</div>' +
      '<div class="tl">Reopen via <b>Project ▾ → Load</b>.</div>',
  },
  {
    target: "export", title: "9. Export for publication", position: "bottom",
    desc:
      "<b>Export ▾</b> opens two formats:" +
      '<div class="tl"><b>SVG</b> &mdash; vector. Every text element stays as text. Editable in Illustrator / Inkscape / Figma.</div>' +
      '<div class="tl"><b>PNG</b> &mdash; raster, 2× scale. Best for slides &amp; quick previews.</div>' +
      '<div class="td">The display IS the export &mdash; what you see is what gets saved. There is no second renderer to drift from the preview.</div>',
  },
];

function _startTour() {
  _tourStep = 0;
  _renderTourStep();
}
function _endTour() {
  _tourStep = -1;
  const ov = document.getElementById("tour-overlay");
  if (ov) {
    ov.classList.add("hidden");
    ov.innerHTML = "";
  }
}
function _tourNext() {
  if (_tourStep < TOUR_STEPS.length - 1) { _tourStep++; _renderTourStep(); }
  else _endTour();
}
function _tourPrev() {
  if (_tourStep > 0) { _tourStep--; _renderTourStep(); }
}
function _tourGo(idx) {
  if (idx < 0 || idx >= TOUR_STEPS.length) return;
  _tourStep = idx;
  _renderTourStep();
}

function _renderTourStep() {
  const ov = document.getElementById("tour-overlay");
  if (!ov) return;
  ov.classList.remove("hidden");

  const s = TOUR_STEPS[_tourStep];
  const targetEl = document.querySelector(`[data-tour="${s.target}"]`);
  const r = targetEl ? targetEl.getBoundingClientRect() : null;
  const PAD = 8;
  const GAP = 12;
  const CARD_W = 380;
  const CARD_H_EST = 280;  // upper bound; the actual card is auto-height

  // Spotlight: four dimmed strips (top / bottom / left / right) and a
  // bright outline around the target rect. When there's no target,
  // dim the entire viewport (the user is just reading the card).
  let spotHTML = "";
  if (r) {
    const st = Math.max(0, r.top - PAD);
    const sl = Math.max(0, r.left - PAD);
    const sw = r.width + PAD * 2;
    const sh = r.height + PAD * 2;
    const dim = "rgba(0, 0, 0, 0.55)";
    const z = 5001;
    spotHTML = `
      <div style="position:fixed;top:0;left:0;right:0;height:${st}px;background:${dim};z-index:${z};pointer-events:none"></div>
      <div style="position:fixed;top:${st + sh}px;left:0;right:0;bottom:0;background:${dim};z-index:${z};pointer-events:none"></div>
      <div style="position:fixed;top:${st}px;left:0;width:${sl}px;height:${sh}px;background:${dim};z-index:${z};pointer-events:none"></div>
      <div style="position:fixed;top:${st}px;left:${sl + sw}px;right:0;height:${sh}px;background:${dim};z-index:${z};pointer-events:none"></div>
      <div style="position:fixed;top:${st}px;left:${sl}px;width:${sw}px;height:${sh}px;border-radius:6px;border:2px solid rgba(255,255,255,0.35);box-shadow:0 0 0 1px rgba(0,0,0,0.6) inset;z-index:${z};pointer-events:none;box-sizing:border-box"></div>`;
  } else {
    spotHTML = `<div style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:5001;pointer-events:none"></div>`;
  }

  // Card position: prefer below the target; flip above if there isn't
  // room. For "left" or "right" anchors we place the card to the side.
  let cardTop, cardLeft, arrowDir = "up";
  const winW = window.innerWidth, winH = window.innerHeight;
  if (!r) {
    cardTop = (winH - CARD_H_EST) / 2;
    cardLeft = (winW - CARD_W) / 2;
    arrowDir = null;
  } else {
    const pos = s.position || "bottom";
    if (pos === "left") {
      cardTop = Math.max(12, r.top + r.height / 2 - CARD_H_EST / 2);
      cardLeft = Math.max(12, r.left - GAP - CARD_W);
      arrowDir = null;
    } else if (pos === "right") {
      cardTop = Math.max(12, r.top + r.height / 2 - CARD_H_EST / 2);
      cardLeft = Math.min(winW - CARD_W - 12, r.right + GAP);
      arrowDir = null;
    } else if (r.bottom + GAP + CARD_H_EST <= winH) {
      cardTop = r.bottom + GAP;
      cardLeft = r.left + r.width / 2 - CARD_W / 2;
      arrowDir = "up";
    } else {
      cardTop = r.top - GAP - CARD_H_EST;
      cardLeft = r.left + r.width / 2 - CARD_W / 2;
      arrowDir = "down";
    }
    cardLeft = Math.max(12, Math.min(winW - CARD_W - 12, cardLeft));
    cardTop = Math.max(12, Math.min(winH - CARD_H_EST - 12, cardTop));
  }

  const arrowOffset = r && arrowDir
    ? Math.max(20, Math.min(CARD_W - 20, r.left + r.width / 2 - cardLeft))
    : null;

  // Pagination dots — click any dot to jump to that step.
  let dotsHTML = "";
  for (let i = 0; i < TOUR_STEPS.length; i++) {
    dotsHTML += `<div class="tour-dot ${i === _tourStep ? "active" : ""}" data-tour-dot="${i}"></div>`;
  }

  const arrow = arrowDir
    ? `<div class="tour-arrow ${arrowDir}" style="left:${arrowOffset - 8}px"></div>`
    : "";

  ov.innerHTML = `
    <div style="position:fixed;inset:0;z-index:5000" data-tour-backdrop="1"></div>
    ${spotHTML}
    <div class="tour-card" style="top:${cardTop}px;left:${cardLeft}px">
      ${arrow}
      <div class="tour-step-label">Step ${_tourStep + 1} of ${TOUR_STEPS.length}</div>
      <div class="tour-title">${s.title}</div>
      <div class="tour-desc">${s.desc}</div>
      <div class="tour-dots">${dotsHTML}</div>
      <div class="tour-foot">
        <button class="tour-skip" data-tour-action="skip">Skip Tour</button>
        <div class="tour-nav">
          <button class="tour-btn" data-tour-action="prev" ${_tourStep === 0 ? "disabled" : ""}>Previous</button>
          <button class="tour-btn primary" data-tour-action="next">${_tourStep === TOUR_STEPS.length - 1 ? "Finish" : "Next"}</button>
        </div>
      </div>
    </div>`;

  // Wire up the buttons and dots after the innerHTML rebuild. Using
  // event delegation here would also work, but direct binding keeps
  // the lifecycle local to each render.
  ov.querySelector('[data-tour-backdrop]')?.addEventListener("click", _endTour);
  ov.querySelector('[data-tour-action="skip"]')?.addEventListener("click", _endTour);
  ov.querySelector('[data-tour-action="prev"]')?.addEventListener("click", _tourPrev);
  ov.querySelector('[data-tour-action="next"]')?.addEventListener("click", _tourNext);
  ov.querySelectorAll('[data-tour-dot]').forEach((d) => {
    d.addEventListener("click", () => _tourGo(parseInt(d.dataset.tourDot, 10)));
  });
}

// Help button → start the tour. Also listen for F1 globally as long
// as the user isn't typing in a text field.
{
  const helpBtn = document.getElementById("help-btn");
  if (helpBtn) helpBtn.addEventListener("click", _startTour);
}

window.addEventListener("keydown", (e) => {
  // Esc closes the Info panel and ends the tour. We check the panel
  // first because the existing global Esc handler in this file (which
  // cancels in-flight drags / clears selections) would otherwise
  // swallow the keystroke.
  if (e.key === "Escape") {
    const panel = document.getElementById("info-panel");
    if (panel && !panel.classList.contains("hidden")) {
      panel.classList.add("hidden");
      e.stopPropagation();
      return;
    }
    if (_tourStep >= 0) {
      _endTour();
      e.stopPropagation();
      return;
    }
  }
  // Tour navigation while active.
  if (_tourStep >= 0) {
    if (e.key === "ArrowRight" || e.key === "Enter") { _tourNext(); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { _tourPrev(); e.preventDefault(); }
  }
  // F1 from anywhere (except text inputs) starts the tour.
  if (e.key === "F1") {
    const t = e.target;
    const inText = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (!inText) { _startTour(); e.preventDefault(); }
  }
}, true);  // capture phase so we get Esc before the rest of the keydown chain

// Re-position the tour card on viewport changes so it doesn't drift
// off-screen if the user resizes the window mid-tour.
window.addEventListener("resize", () => {
  if (_tourStep >= 0) _renderTourStep();
});
