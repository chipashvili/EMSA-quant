/* fEMSA quantification layer.
 *
 * Loaded AFTER app.js, which means every top-level binding in app.js
 * (`state`, `svg`, `computeLanes`, `renderAll`, `commitHistory`, …) is
 * visible here through the shared global lexical scope of classic
 * scripts. app.js reaches back through exactly five `window.FEMSA`
 * hooks — render, onPointerDown, resetForNewImage, adoptSavedState, and
 * the `quant` slot in state/UNDOABLE_FIELDS. Keeping the surface that
 * small is deliberate: the fork tracks upstream Slots releases, and
 * everything in this file is a new file that can never conflict.
 *
 * ── The measurement model ──────────────────────────────────────────
 *
 * A ROW is a horizontal stripe spanning the whole analysis region at a
 * fixed y-range. Crossing it with the existing lane geometry yields one
 * ROI per lane, all at the same y and (by default) the same width.
 *
 * This is the shape the fEMSA spec actually asks for — "identical ROI
 * box for every lane, sized to the widest band in the series" — and it
 * makes that property structural rather than something the user has to
 * achieve by hand with N free-floating rectangles. A titration is two
 * or three rows total: free probe, shifted complex, and a background
 * stripe in empty gel.
 *
 * Rows carry a ROLE (free / bound / other) rather than being positional,
 * because supershifts and multiple bound species are common: any number
 * of rows can be role=bound and the analysis sums them.
 */

"use strict";

window.FEMSA = (() => {

// Minimum row height in image pixels. Below this the row is more likely
// a stray click than an intended ROI, and the background mean gets too
// few pixels to be a useful estimate.
const MIN_ROW_H = 4;

// Lane-width spread above which a uniform-width warning fires. Lane
// separators are draggable, so unequal boxes are easy to create by
// accident — and unequal boxes silently break the depletion method,
// which compares free-probe intensity ACROSS lanes.
const WIDTH_TOLERANCE = 0.02;

// Median |f_ratio − f_depletion| above which the two methods are called
// divergent. Below ~0.05 the gap is ordinary background-estimation
// noise; above ~0.10 it is signal loss (probe stuck in wells, smeared,
// or in a non-migrating complex) and the ratio method is understating
// binding. 0.08 sits between those.
const DIVERGENCE_TOLERANCE = 0.08;

const ROLE_COLORS = {
  free:       "#2f7fd1",
  bound:      "#e07b39",
  other:      "#8e6fc4",
  background: "#6f7780",
};

const ROLES = ["free", "bound", "other"];

// ── State ────────────────────────────────────────────────────────────
//
// Persistent (undo/redo + saved projects): state.quant.
// Transient (deliberately NOT persisted): the module-locals below.
//
// `measurement` is transient because a saved result could outlive the
// row that produced it — reopen a project, nudge a row 3 px, and a
// stale CSV would still export. Re-measuring is one click and one
// numpy pass, so there is no reason to cache it across sessions.

let measurement = null;     // { byId: Map, meta, rowsAtMeasure }
let selectedRowId = null;
let qdrag = null;
let pendingKind = null;     // { kind, role } armed by the +Row buttons

function blankState() {
  return {
    active: false,
    rows: [],               // [{ id, kind, role, name, y0, y1, bgFor }]
    uniformWidth: true,
    insetPct: 0,
    concColId: null,
    probeNM: 8,             // Dt — total probe concentration in the reaction
    replicate: "1",
    excluded: {},           // { laneIdx: true }
    showInExport: false,
  };
}

function st() {
  if (!state.quant) state.quant = blankState();
  return state.quant;
}

// Any geometry change invalidates the last measurement. Called from
// every mutator rather than diffed at measure time, so the results
// table can never show numbers that don't match the drawn boxes.
function invalidate() {
  measurement = null;
}

// ── Row helpers ──────────────────────────────────────────────────────

function signalRows() { return st().rows.filter((r) => r.kind === "signal"); }
function bgRows()     { return st().rows.filter((r) => r.kind === "background"); }

/** Background row serving `rowId`: a dedicated one if present, else the
 *  shared ("all rows") one, else none. Per-species backgrounds matter
 *  when the gel above the free band and the gel above the shifted band
 *  have visibly different backgrounds — common when the complex smears. */
function bgRowFor(rowId) {
  const bgs = bgRows();
  return bgs.find((b) => b.bgFor === rowId)
      || bgs.find((b) => !b.bgFor || b.bgFor === "*")
      || null;
}

function rowById(id) { return st().rows.find((r) => r.id === id) || null; }

function defaultRowName(kind, role) {
  const q = st();
  if (kind === "background") {
    const n = bgRows().length;
    return n === 0 ? "bg" : `bg${n + 1}`;
  }
  const same = q.rows.filter((r) => r.kind === "signal" && r.role === role).length;
  return same === 0 ? role : `${role}${same + 1}`;
}

function regionYBounds() {
  const r = state.region;
  return r ? { lo: r.y, hi: r.y + r.h } : { lo: 0, hi: state.imgHeight };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function addRow(kind, role, y0, y1) {
  const b = regionYBounds();
  const row = {
    id: newId(),
    kind,
    role: kind === "signal" ? role : null,
    name: defaultRowName(kind, role),
    y0: clamp(Math.min(y0, y1), b.lo, b.hi),
    y1: clamp(Math.max(y0, y1), b.lo, b.hi),
    bgFor: kind === "background" ? "*" : null,
  };
  st().rows.push(row);
  selectedRowId = row.id;
  invalidate();
  renderAll(); refreshPanel();
  commitHistory(`Add ${row.name} row`);
  return row;
}

function deleteRow(id) {
  const q = st();
  const row = rowById(id);
  if (!row) return;
  q.rows = q.rows.filter((r) => r.id !== id);
  // Background rows pointed at the deleted signal row would silently
  // fall back to "all rows"; re-point them explicitly so the UI shows
  // what actually happens.
  for (const b of bgRows()) if (b.bgFor === id) b.bgFor = "*";
  if (selectedRowId === id) selectedRowId = null;
  invalidate();
  renderAll(); refreshPanel();
  commitHistory(`Delete ${row.name} row`);
}

// ── Lane geometry ────────────────────────────────────────────────────

/** Per-lane integration boxes in image-x.
 *
 *  With `uniformWidth` on (the default) every box takes the width of the
 *  NARROWEST lane and is centered in its own lane. That guarantees equal
 *  pixel counts across the series, which the depletion method requires —
 *  it divides free-probe intensity in one lane by free-probe intensity in
 *  another, and unequal box areas put a bias straight into that ratio.
 *  The ratio method is immune (both species share a lane), which is
 *  exactly why the two methods disagreeing is diagnostic. */
function laneBoxes(lanes) {
  const q = st();
  const widths = lanes.map((l) => l.x_right - l.x_left);
  const base = q.uniformWidth ? Math.min(...widths) : null;
  const inset = clamp(Number(q.insetPct) || 0, 0, 45) / 100;
  return lanes.map((l, i) => {
    const w = (base !== null ? base : widths[i]) * (1 - 2 * inset);
    const cx = (l.x_left + l.x_right) / 2;
    return { laneIdx: i, x0: cx - w / 2, x1: cx + w / 2, w };
  });
}

function laneWidthSpread(lanes) {
  if (lanes.length < 2) return 0;
  const w = lanes.map((l) => l.x_right - l.x_left);
  const lo = Math.min(...w), hi = Math.max(...w);
  return hi > 0 ? (hi - lo) / hi : 0;
}

// ── Concentrations ───────────────────────────────────────────────────

/** Protein concentration for a lane, read from the chosen metadata
 *  column. Returns NaN when unset or unparseable — the caller treats
 *  that as "exclude from the fit" rather than as zero, because a blank
 *  cell and a genuine 0 nM no-protein control are very different things
 *  and conflating them would anchor the curve at a fictitious origin. */
function laneConc(i) {
  const col = st().concColId;
  if (!col || !state.cells[col]) return NaN;
  const raw = String(state.cells[col][i] ?? "").trim();
  if (!raw) return NaN;
  // Tolerate "1,000", "12 nM", "1.5e-9" — users paste from all sorts of
  // places. Strip thousands separators and a trailing unit.
  const cleaned = raw.replace(/,/g, "").replace(/\s*n?M\s*$/i, "");
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : NaN;
}

function laneStatus(i) {
  if (state.ladder[i])          return { included: false, reason: "ladder lane" };
  if (st().excluded[i])         return { included: false, reason: "excluded by user" };
  const c = laneConc(i);
  if (!Number.isFinite(c))      return { included: false, reason: "no concentration" };
  if (c < 0)                    return { included: false, reason: "negative concentration" };
  return { included: true, reason: "" };
}

// ── Rendering ────────────────────────────────────────────────────────

function render(L, lanes, ink) {
  const q = state.quant;
  if (!q || !q.active) return;

  const g = el("g", { "data-role": "femsa-layer" });
  // ROI boxes are measurement scaffolding, not figure content, so they
  // are stripped from PNG / SVG export unless the user opts in (useful
  // for a supplementary "here is what we integrated" panel).
  if (!q.showInExport) g.setAttribute("data-export-hide", "true");

  // Live preview of the row being dragged out.
  if (qdrag && qdrag.kind === "draw" && state.region) {
    const y0 = Math.min(qdrag.startY, qdrag.curY);
    const y1 = Math.max(qdrag.startY, qdrag.curY);
    const color = ROLE_COLORS[pendingKind?.kind === "background" ? "background" : (pendingKind?.role || "other")];
    g.appendChild(el("rect", {
      x: imgToSvgX(L, state.region.x), y: imgToSvgY(L, y0),
      width: state.region.w, height: Math.max(1, y1 - y0),
      fill: color, "fill-opacity": 0.15, stroke: color,
      "stroke-width": 1.5, "stroke-dasharray": "4 3", "pointer-events": "none",
    }));
  }

  if (state.region && lanes.length && q.rows.length) {
    const boxes = laneBoxes(lanes);
    const rx0 = imgToSvgX(L, state.region.x);
    const rw  = state.region.w;

    // Sorted so overlapping rows stack predictably rather than in
    // creation order.
    const ordered = q.rows.slice().sort((a, b) => a.y0 - b.y0);

    for (const row of ordered) {
      const isBg = row.kind === "background";
      const color = ROLE_COLORS[isBg ? "background" : (row.role || "other")];
      const sy0 = imgToSvgY(L, row.y0);
      const sy1 = imgToSvgY(L, row.y1);
      const h = Math.max(1, sy1 - sy0);
      const isSel = row.id === selectedRowId;

      // Full-width tint: reads as "this stripe is one row" even where a
      // lane box happens to sit over dark gel.
      g.appendChild(el("rect", {
        x: rx0, y: sy0, width: rw, height: h,
        fill: color, "fill-opacity": isBg ? 0.06 : 0.10,
        "pointer-events": "none",
      }));

      // The actual integration boxes.
      for (const b of boxes) {
        const included = laneStatus(b.laneIdx).included;
        g.appendChild(el("rect", {
          x: imgToSvgX(L, b.x0), y: sy0, width: b.x1 - b.x0, height: h,
          fill: "none", stroke: color,
          "stroke-width": isSel ? 2 : 1.25,
          "stroke-dasharray": isBg ? "5 4" : null,
          "stroke-opacity": included ? 1 : 0.28,
          "pointer-events": "none",
        }));
      }

      // Row label in the left margin.
      g.appendChild(el("text", {
        x: rx0 - 10, y: (sy0 + sy1) / 2 + 4,
        "text-anchor": "end", fill: color,
        "font-size": 13, "font-family": "system-ui, -apple-system, sans-serif",
        "font-weight": isSel ? 700 : 500,
        "data-femsa-row": row.id, "data-femsa-grab": "select",
        style: "cursor: pointer;",
      }, row.name));

      // Interaction targets, above the visuals. Body drags the row;
      // 8 px strips at each edge resize it.
      g.appendChild(el("rect", {
        x: rx0, y: sy0 + 4, width: rw, height: Math.max(1, h - 8),
        fill: "transparent", "pointer-events": "all",
        "data-femsa-row": row.id, "data-femsa-grab": "move",
        style: "cursor: move;",
      }));
      for (const [edge, ey] of [["top", sy0 - 4], ["bottom", sy1 - 4]]) {
        g.appendChild(el("rect", {
          x: rx0, y: ey, width: rw, height: 8,
          fill: "transparent", "pointer-events": "all",
          "data-femsa-row": row.id, "data-femsa-grab": edge,
          style: "cursor: ns-resize;",
        }));
      }
    }
  }

  svg.appendChild(g);
}

// ── Pointer interaction ──────────────────────────────────────────────

function onPointerDown(evt, ic) {
  const q = state.quant;
  if (!q || !q.active) return false;
  const ds = evt.target.dataset || {};

  if (ds.femsaRow) {
    const row = rowById(ds.femsaRow);
    if (!row) return false;
    selectedRowId = row.id;
    if (ds.femsaGrab === "select") { renderAll(); refreshPanel(); return true; }
    qdrag = {
      kind: ds.femsaGrab, rowId: row.id, pointerId: evt.pointerId,
      startY: ic.y, y0: row.y0, y1: row.y1, moved: false,
    };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    renderAll(); refreshPanel();
    return true;
  }

  if (state.tool === "qrow" && pendingKind) {
    if (!state.region) { setStatus("Draw an analysis region first (D).", true); return true; }
    qdrag = { kind: "draw", pointerId: evt.pointerId, startY: ic.y, curY: ic.y };
    try { svg.setPointerCapture(evt.pointerId); } catch (_) {}
    evt.preventDefault();
    return true;
  }

  return false;
}

svg.addEventListener("pointermove", (evt) => {
  if (!qdrag) return;
  if (qdrag.pointerId != null && evt.pointerId !== qdrag.pointerId) return;
  const ic = clientToImage(evt); if (!ic) return;
  qdrag.moved = true;

  if (qdrag.kind === "draw") { qdrag.curY = ic.y; renderAll(); return; }

  const row = rowById(qdrag.rowId); if (!row) return;
  const d = ic.y - qdrag.startY;
  const b = regionYBounds();
  if (qdrag.kind === "move") {
    const h = qdrag.y1 - qdrag.y0;
    const ny0 = clamp(qdrag.y0 + d, b.lo, b.hi - h);
    row.y0 = ny0; row.y1 = ny0 + h;
  } else if (qdrag.kind === "top") {
    row.y0 = clamp(Math.min(qdrag.y0 + d, qdrag.y1 - MIN_ROW_H), b.lo, b.hi - MIN_ROW_H);
  } else if (qdrag.kind === "bottom") {
    row.y1 = clamp(Math.max(qdrag.y1 + d, qdrag.y0 + MIN_ROW_H), b.lo + MIN_ROW_H, b.hi);
  }
  invalidate();
  renderAll(); refreshPanel();
});

function endQDrag(evt, cancelled) {
  if (!qdrag) return;
  if (qdrag.pointerId != null && evt && evt.pointerId !== qdrag.pointerId) return;
  const d = qdrag; qdrag = null;
  if (d.pointerId != null) { try { svg.releasePointerCapture(d.pointerId); } catch (_) {} }

  if (cancelled) { renderAll(); refreshPanel(); return; }

  if (d.kind === "draw") {
    const y0 = Math.min(d.startY, d.curY), y1 = Math.max(d.startY, d.curY);
    if (y1 - y0 < MIN_ROW_H) {
      setStatus(`Row too thin (< ${MIN_ROW_H} px) — drag down across the band.`, true);
      renderAll();
      return;
    }
    addRow(pendingKind.kind, pendingKind.role, y0, y1);
    // One row per arming: the common case is one free row and one bound
    // row, and staying armed makes the next ordinary click create a
    // phantom row.
    setTool(null);
    return;
  }

  const row = rowById(d.rowId);
  if (d.moved && row) commitHistory(`Adjust ${row.name} row`);
  renderAll(); refreshPanel();
}

svg.addEventListener("pointerup",     (evt) => endQDrag(evt, false));
svg.addEventListener("pointercancel", (evt) => endQDrag(evt, true));

// ── Measurement ──────────────────────────────────────────────────────

const roiId = (rowId, laneIdx) => `${rowId}|${laneIdx}`;

async function measure() {
  const q = st();
  if (!state.imageId)      return setStatus("Open an image first.", true);
  if (!state.region)       return setStatus("Draw an analysis region first (D).", true);
  if (!q.rows.length)      return setStatus("Add at least one row before measuring.", true);
  if (!signalRows().length) return setStatus("Add at least one signal (free / bound) row.", true);

  const lanes = computeLanes();
  const boxes = laneBoxes(lanes);
  const rois = [];
  for (const row of q.rows) {
    for (const b of boxes) {
      rois.push({ id: roiId(row.id, b.laneIdx), x: b.x0, y: row.y0, w: b.x1 - b.x0, h: row.y1 - row.y0 });
    }
  }

  setStatus(`Measuring ${rois.length} ROIs from raw pixel values…`);
  let resp;
  try {
    resp = await fetch(`/api/image/${state.imageId}/quantify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rois }),
    });
  } catch (e) { return setStatus("Measurement failed: " + e.message, true); }
  if (!resp.ok) return setStatus("Measurement failed: " + (await resp.text()), true);

  const data = await resp.json();
  measurement = {
    byId: new Map(data.results.map((r) => [r.id, r])),
    meta: data,
    rowsAtMeasure: JSON.parse(JSON.stringify(q.rows)),
  };
  refreshPanel();
  setStatus(
    `Measured ${rois.length} ROIs from raw ${data.dtype} pixels ` +
    `(clipping reference ${data.saturation_value} via ${data.saturation_method}).`
  );
}

// ── Analysis ─────────────────────────────────────────────────────────

/** Turn the raw ROI stats into per-lane fractions bound, both ways.
 *
 *  Both f_bound estimators from the spec are computed unconditionally
 *  and compared, because their disagreement is the only cheap readout of
 *  invisible probe loss:
 *
 *    ratio      f = I_bound / (I_bound + I_free)      internally normalized
 *    depletion  f = 1 − I_free / I_free(no protein)   external reference
 *
 *  If probe vanishes into the wells or into a smear that neither row
 *  covers, the ratio method still sees a plausible-looking split of
 *  whatever remained on the gel and understates binding, while depletion
 *  correctly counts the missing free probe as bound. */
function analyze() {
  if (!measurement) return null;
  const q = st();
  const sig = signalRows();
  const lanes = [];

  for (let i = 0; i < state.laneCount; i++) {
    const status = laneStatus(i);
    const rec = {
      lane: i, label: i + 1, conc: laneConc(i),
      included: status.included, reason: status.reason,
      species: [], flags: [],
    };
    for (const row of sig) {
      const m = measurement.byId.get(roiId(row.id, i));
      if (!m) continue;
      const bg = bgRowFor(row.id);
      const bgm = bg ? measurement.byId.get(roiId(bg.id, i)) : null;
      const bgMean = bgm ? bgm.mean : 0;
      // Background is subtracted as mean × band-pixel-count rather than
      // sum − sum, so the background row does NOT have to be the same
      // height as the band row. A taller background stripe just gives a
      // better-averaged estimate of the same per-pixel offset.
      const bgIntensity = bgMean * m.n_pixels;
      const entry = { row, m, bgRow: bg, bgMean, bgIntensity, net: m.sum - bgIntensity };
      rec.species.push(entry);

      if (m.saturated) rec.flags.push(`${row.name}: ${m.sat_pixels} px at full scale`);
      else if (m.plateau) rec.flags.push(`${row.name}: ${m.plateau_pixels} px flat-topped at image max`);
      if (m.clipped_to_image) rec.flags.push(`${row.name}: ROI clipped at image edge`);
      if (entry.net <= 0) rec.flags.push(`${row.name}: net ≤ 0 after background`);
    }
    const roleSum = (role) => rec.species
      .filter((s) => s.row.role === role)
      .reduce((a, s) => a + s.net, 0);
    rec.freeNet = roleSum("free");
    rec.boundNet = roleSum("bound");
    const tot = rec.freeNet + rec.boundNet;
    rec.fRatio = tot > 0 ? rec.boundNet / tot : NaN;
    lanes.push(rec);
  }

  // Depletion reference: the included lane with the lowest protein
  // concentration. Ideally that is a genuine 0 nM lane; if it is not,
  // some probe is already bound there and every f_depletion is biased
  // low by that amount — hence the warning below.
  let ref = null;
  for (const l of lanes) if (l.included && (!ref || l.conc < ref.conc)) ref = l;
  for (const l of lanes) {
    l.fDepl = (ref && ref.freeNet > 0) ? 1 - l.freeNet / ref.freeNet : NaN;
  }

  return { lanes, ref, warnings: buildWarnings(lanes, ref) };
}

function buildWarnings(lanes, ref) {
  const q = st();
  const w = [];
  const inc = lanes.filter((l) => l.included);
  const sig = signalRows();

  if (!sig.some((r) => r.role === "free"))
    w.push({ level: "err", text: "No row is marked free — the ratio method and the depletion method both need one." });
  if (!sig.some((r) => r.role === "bound"))
    w.push({ level: "err", text: "No row is marked bound — f_bound by the ratio method cannot be computed." });
  if (!bgRows().length)
    w.push({ level: "warn", text: "No background row. Integrated intensities include gel background, which inflates weak bands and flattens the curve." });

  // Distant background rows are the single biggest avoidable source of
  // Kd error in this workflow. Gel background is rarely flat — there is
  // almost always a vertical gradient from the run — so a background
  // stripe measured far from the band estimates the wrong offset, and
  // the error is multiplied by the band's pixel count. On a simulated
  // titration with a known 15 nM Kd, one shared background row ~135 px
  // from the free band returned 19.3 nM; moving a background row
  // alongside each band returned 14.0 nM. The threshold below is scaled
  // to the signal row's own height rather than absolute, so it adapts to
  // tight bands and to broad smeary ones.
  for (const row of sig) {
    const bg = bgRowFor(row.id);
    if (!bg) continue;
    const h = row.y1 - row.y0;
    const gap = Math.max(0, Math.max(row.y0 - bg.y1, bg.y0 - row.y1));
    if (gap > 2 * h) {
      w.push({ level: "warn", text: `Background row "${bg.name}" sits ${Math.round(gap)} px from "${row.name}" (more than 2× that row's height). Gel background usually has a vertical gradient, so a distant stripe estimates the wrong offset — and the error scales with the band's pixel count. Add a background row just above or below this band and point it at "${row.name}".` });
    }
  }
  if (!inc.length)
    w.push({ level: "err", text: "No lanes are included. Pick a [protein] column and fill in concentrations." });

  if (ref && ref.conc > 0)
    w.push({ level: "warn", text: `No 0 nM lane — depletion uses lane ${ref.label} at ${fmtConc(ref.conc)} nM as the reference, so f_depletion is biased low by however much probe is already bound there.` });

  const sat = lanes.filter((l) => l.included && l.flags.some((f) => /full scale|flat-topped/.test(f)));
  if (sat.length)
    w.push({ level: "err", text: `Saturated ROIs in lane${sat.length === 1 ? "" : "s"} ${sat.map((l) => l.label).join(", ")}. Saturation in the free band flattens the top of the curve and inflates Kd — re-image at a shorter exposure, or quantify each species from the exposure where it is in range.` });

  const glaneSpread = laneWidthSpread(computeLanes());
  if (!q.uniformWidth && glaneSpread > WIDTH_TOLERANCE)
    w.push({ level: "warn", text: `Lane widths vary by ${(glaneSpread * 100).toFixed(1)}% and uniform ROI width is off. The depletion method compares intensities across lanes and assumes equal box areas.` });

  const pairs = inc.filter((l) => Number.isFinite(l.fRatio) && Number.isFinite(l.fDepl));
  if (pairs.length >= 3) {
    const diffs = pairs.map((l) => l.fDepl - l.fRatio).sort((a, b) => a - b);
    const med = diffs[Math.floor(diffs.length / 2)];
    if (Math.abs(med) > DIVERGENCE_TOLERANCE) {
      w.push(med > 0
        ? { level: "warn", text: `Depletion exceeds ratio by a median of ${med.toFixed(2)}. Probe is disappearing without showing up in a bound row — check the wells on a long exposure, and look for a smear between the free and bound positions. The ratio method is understating binding.` }
        : { level: "warn", text: `Ratio exceeds depletion by a median of ${(-med).toFixed(2)}. Usually means the bound row is catching background or a second species, or the reference lane's free band is under-integrated.` });
    }
  }

  const fmax = Math.max(...inc.map((l) => l.fRatio).filter(Number.isFinite), 0);
  if (inc.length >= 3 && fmax < 0.2)
    w.push({ level: "warn", text: `Highest f_bound is only ${fmax.toFixed(2)}. The titration never approaches saturation, so Kd will be extrapolated well past the data and poorly constrained.` });

  const concs = inc.map((l) => l.conc).filter((c) => c > 0);
  if (concs.length && Number(q.probeNM) > 0) {
    const lo = Math.min(...concs);
    if (lo < 10 * Number(q.probeNM))
      w.push({ level: "info", text: `Lowest protein concentration (${fmtConc(lo)} nM) is within 10× of the probe concentration (${fmtConc(Number(q.probeNM))} nM). This is the ligand-depletion regime — fit the quadratic, not the hyperbolic.` });
  }

  return w;
}

// ── CSV export ───────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "image", "replicate", "lane", "lane_label", "protein_conc_nM", "probe_nM",
  "species", "row_name",
  "roi_x", "roi_y", "roi_w", "roi_h", "n_pixels",
  "integrated_intensity", "bg_intensity", "net_integrated_intensity",
  "mean_intensity", "bg_mean", "max_value",
  "sat_pixels", "plateau_pixels", "saturated",
  "excluded", "exclude_reason",
  "bg_row", "source_dtype", "saturation_reference",
];

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const a = analyze();
  if (!a) return null;
  const q = st();
  const meta = measurement.meta;
  const lines = [CSV_COLUMNS.join(",")];

  for (const rec of a.lanes) {
    for (const s of rec.species) {
      lines.push([
        state.filename,
        q.replicate,
        rec.label,                       // 1-based: matches what the gel shows
        rec.label,
        Number.isFinite(rec.conc) ? rec.conc : "",
        q.probeNM,
        s.row.role,                      // free | bound | other
        s.row.name,
        s.m.x, s.m.y, s.m.w, s.m.h, s.m.n_pixels,
        s.m.sum.toFixed(3),
        s.bgIntensity.toFixed(3),
        s.net.toFixed(3),
        s.m.mean.toFixed(4),
        s.bgMean.toFixed(4),
        s.m.max,
        s.m.sat_pixels,
        s.m.plateau_pixels,
        (s.m.saturated || s.m.plateau) ? 1 : 0,
        rec.included ? 0 : 1,
        rec.reason,
        s.bgRow ? s.bgRow.name : "",
        meta.dtype,
        meta.saturation_value,
      ].map(csvCell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

function exportCsv() {
  const csv = buildCsv();
  if (!csv) return setStatus("Nothing to export — click Measure first.", true);
  const stem = (state.filename.replace(/\.[^.]+$/, "") || "femsa");
  const name = `${stem}_rep${st().replicate || "1"}_quant.csv`;
  download(new Blob([csv], { type: "text/csv" }), name);
  setStatus(`Exported ${name}. Fit it with:  femsa-fit ${name}`);
}

// ── Panel ────────────────────────────────────────────────────────────

function fmtConc(v) {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (v >= 1000 || v < 0.01) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

function fmtBig(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
}

function refreshPanel() {
  const panel = $("quant-panel");
  if (!panel) return;
  const q = st();
  panel.style.display = q.active ? "" : "none";
  if (!q.active) return;

  $("q-probe").value = q.probeNM;
  $("q-replicate").value = q.replicate;
  $("q-uniform").checked = !!q.uniformWidth;
  $("q-inset").value = q.insetPct;
  $("q-export-rois").checked = !!q.showInExport;
  refreshConcColSelect();
  refreshRowList();
  refreshResults();
  $("q-export-csv").disabled = !measurement;
}

function refreshConcColSelect() {
  const sel = $("q-conc-col");
  const q = st();
  const prev = q.concColId;
  sel.innerHTML = '<option value="">— none —</option>' +
    state.columns.map((c) =>
      `<option value="${escapeHtml(c.id)}"${c.id === prev ? " selected" : ""}>${escapeHtml(c.name || "(untitled)")}</option>`
    ).join("");
  // The column may have been deleted from the table since it was chosen.
  if (prev && !state.columns.some((c) => c.id === prev)) {
    q.concColId = null;
    sel.value = "";
  }
}

function refreshRowList() {
  const host = $("q-rows");
  const q = st();
  host.innerHTML = "";
  if (!q.rows.length) {
    host.innerHTML = '<div class="q-empty">No rows yet. Click a button above, then drag vertically across the gel to sweep out a stripe.</div>';
    return;
  }
  const sig = signalRows();
  for (const row of q.rows.slice().sort((a, b) => a.y0 - b.y0)) {
    const isBg = row.kind === "background";
    const color = ROLE_COLORS[isBg ? "background" : (row.role || "other")];
    const div = document.createElement("div");
    div.className = "q-row" + (row.id === selectedRowId ? " sel" : "");
    const mid = isBg
      ? `<select data-q="bgfor" data-rowid="${row.id}" title="Which signal rows this background applies to">` +
        `<option value="*"${(!row.bgFor || row.bgFor === "*") ? " selected" : ""}>all rows</option>` +
        sig.map((s) => `<option value="${s.id}"${row.bgFor === s.id ? " selected" : ""}>${escapeHtml(s.name)}</option>`).join("") +
        `</select>`
      : `<select data-q="role" data-rowid="${row.id}" title="Species this row measures">` +
        ROLES.map((r) => `<option value="${r}"${row.role === r ? " selected" : ""}>${r}</option>`).join("") +
        `</select>`;
    div.innerHTML =
      `<span class="q-swatch" style="background:${color}"></span>` +
      `<input class="q-name" data-q="name" data-rowid="${row.id}" value="${escapeHtml(row.name)}" title="Row name (appears in the CSV)">` +
      mid +
      `<span class="q-geo" title="Row extent in image pixels">y ${Math.round(row.y0)}–${Math.round(row.y1)}</span>` +
      `<button class="q-del" data-q="del" data-rowid="${row.id}" title="Delete this row">×</button>`;
    host.appendChild(div);
  }
}

function refreshResults() {
  const warnHost = $("q-warnings");
  const host = $("q-results");
  const a = analyze();
  if (!a) {
    warnHost.innerHTML = "";
    host.innerHTML = '<div class="q-empty">Click <b>Measure</b> to integrate raw pixel values inside every box.</div>';
    return;
  }

  warnHost.innerHTML = a.warnings.map((w) =>
    `<div class="q-warn ${w.level}">${escapeHtml(w.text)}</div>`
  ).join("");

  const rows = a.lanes.map((l) => {
    const cls = l.included ? "" : ' class="q-out"';
    const flag = l.flags.length
      ? `<span class="q-flag" title="${escapeHtml(l.flags.join(" · "))}">!</span>`
      : "";
    return `<tr${cls}>` +
      `<td>${l.label}</td>` +
      `<td>${l.included ? fmtConc(l.conc) : `<span title="${escapeHtml(l.reason)}">—</span>`}</td>` +
      `<td>${fmtBig(l.freeNet)}</td>` +
      `<td>${fmtBig(l.boundNet)}</td>` +
      `<td>${Number.isFinite(l.fRatio) ? l.fRatio.toFixed(3) : "—"}</td>` +
      `<td>${Number.isFinite(l.fDepl) ? l.fDepl.toFixed(3) : "—"}</td>` +
      `<td>${flag}</td>` +
    `</tr>`;
  }).join("");

  host.innerHTML =
    `<table class="q-results-table">` +
    `<thead><tr><th>Ln</th><th>[P] nM</th><th>free</th><th>bound</th>` +
    `<th title="I_bound / (I_bound + I_free)">f rat</th>` +
    `<th title="1 − I_free / I_free(reference lane)">f dep</th><th></th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<div class="q-meta">Net intensities are background-subtracted raw sums ` +
    `(${escapeHtml(measurement.meta.dtype)} source).</div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────

function setActive(on) {
  const q = st();
  q.active = on;
  $("quant-btn").classList.toggle("toggle-on", on);
  if (!on && state.tool === "qrow") setTool(null);
  renderAll(); refreshPanel();
  if (on) {
    setStatus(state.region
      ? "Quantify mode. Add a free row and a bound row, then Measure."
      : "Quantify mode. Draw an analysis region first (D), then add rows.");
  }
}

function armRow(kind, role) {
  if (!state.imageId) return;
  if (!st().active) setActive(true);
  pendingKind = { kind, role };
  setTool("qrow");
  setStatus(kind === "background"
    ? "Drag vertically across an EMPTY stretch of gel — same lanes, no band — to place the background row."
    : `Drag vertically across the ${role} band to place the row. It spans every lane at that height.`);
}

function initPanel() {
  $("quant-btn").addEventListener("click", () => {
    if (!state.imageId) return;
    setActive(!st().active);
  });

  $("q-add-free").addEventListener("click",  () => armRow("signal", "free"));
  $("q-add-bound").addEventListener("click", () => armRow("signal", "bound"));
  $("q-add-bg").addEventListener("click",    () => armRow("background", null));

  // Row list — delegated so it survives every rebuild.
  const rowsHost = $("q-rows");
  rowsHost.addEventListener("change", (e) => {
    const t = e.target, id = t.dataset && t.dataset.rowid;
    if (!id) return;
    const row = rowById(id); if (!row) return;
    if (t.dataset.q === "role") {
      row.role = t.value;
      invalidate(); renderAll(); refreshPanel();
      commitHistory(`Set ${row.name} role to ${t.value}`);
    } else if (t.dataset.q === "bgfor") {
      row.bgFor = t.value;
      invalidate(); refreshPanel();
      commitHistory(`Re-point ${row.name} background`);
    } else if (t.dataset.q === "name") {
      row.name = t.value.trim() || row.name;
      renderAll(); refreshPanel();
      commitHistory("Rename quant row");
    }
  });
  rowsHost.addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.q === "del") { deleteRow(t.dataset.rowid); return; }
    const nameInput = t.closest && t.closest(".q-row")?.querySelector(".q-name");
    if (nameInput && t !== nameInput) {
      selectedRowId = nameInput.dataset.rowid;
      renderAll(); refreshRowList();
    }
  });

  $("q-conc-col").addEventListener("change", (e) => {
    st().concColId = e.target.value || null;
    refreshPanel();
    commitHistory("Set protein-concentration column");
  });
  $("q-new-conc-col").addEventListener("click", () => {
    addColumn();
    // addColumn() appends and focuses the new header for inline naming;
    // adopt it as the concentration column and pre-fill the name so the
    // user only has to type numbers.
    const col = state.columns[state.columns.length - 1];
    if (!col) return;
    col.name = "[Protein] nM";
    st().concColId = col.id;
    rebuildTable(); renderAll(); refreshPanel();
    commitHistory("Add [Protein] nM column");
    setStatus("Added a [Protein] nM column. Type one concentration per lane; leave blank to exclude a lane.");
  });

  $("q-probe").addEventListener("change", (e) => {
    st().probeNM = Number(e.target.value) || 0;
    refreshPanel();
    commitHistory("Set probe concentration");
  });
  $("q-replicate").addEventListener("change", (e) => {
    st().replicate = e.target.value.trim() || "1";
    commitHistory("Set replicate id");
  });
  $("q-uniform").addEventListener("change", (e) => {
    st().uniformWidth = e.target.checked;
    invalidate(); renderAll(); refreshPanel();
    commitHistory("Toggle uniform ROI width");
  });
  $("q-inset").addEventListener("change", (e) => {
    st().insetPct = clamp(Number(e.target.value) || 0, 0, 45);
    e.target.value = st().insetPct;
    invalidate(); renderAll(); refreshPanel();
    commitHistory("Set ROI inset");
  });
  $("q-export-rois").addEventListener("change", (e) => {
    st().showInExport = e.target.checked;
    renderAll();
    commitHistory("Toggle ROI boxes in export");
  });

  $("q-measure").addEventListener("click", measure);
  $("q-export-csv").addEventListener("click", exportCsv);

  // Q toggles quantify mode, matching the single-key shortcuts app.js
  // registers for the other toolbar buttons.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.imageId) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (state.pendingTextAnn) return;
    if (e.key === "q" || e.key === "Q") { e.preventDefault(); $("quant-btn").click(); }
  });
}

// ── app.js hooks ─────────────────────────────────────────────────────

function resetForNewImage() {
  state.quant = blankState();
  measurement = null; selectedRowId = null; qdrag = null; pendingKind = null;
  refreshPanel();
}

function adoptSavedState(saved) {
  state.quant = (saved && typeof saved === "object")
    ? { ...blankState(), ...saved }
    : blankState();
  measurement = null; selectedRowId = null;
  refreshPanel();
}

/** Called by app.js's setTool so the +Row arming clears when the user
 *  picks a different tool, and the toolbar toggle stays honest. */
function syncTool(tool) {
  if (tool !== "qrow") pendingKind = null;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPanel);
} else {
  initPanel();
}

return {
  render, onPointerDown, resetForNewImage, adoptSavedState, syncTool,
  refreshPanel, blankState,
};

})();
