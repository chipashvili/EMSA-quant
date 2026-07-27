> ### This is a fork: **fEMSA Quant**
>
> [Slots Gel Annotator](https://github.com/billy-ngo/slots-gel-annotator) by
> Billy Ngo (MIT), with raw-intensity band extraction and apparent-Kd fitting
> added on top. Everything documented below still works.
>
> * **Quantification guide → [`docs/femsa-quant.md`](docs/femsa-quant.md)**
> * Commands are `femsa` and `femsa-fit` (not `slots`); the server runs on
>   port **8063** so a stock Slots install on 8062 is unaffected.
> * Auto-update is disabled — pull from `upstream` with git instead.

---

# Slots Gel Annotator

A vector-native, browser-based tool for annotating gel-electrophoresis images and exporting publication-ready figures. Designed for working biologists: drag-and-drop a gel image, draw an analysis region, label your lanes with brackets and ladder bands, and export the result as an SVG (vector — editable in Illustrator, Inkscape, or Figma) or a PNG (raster).

---

## Installation

### Recommended (PyPI)

```bash
pip install slotsgeltool
```

Requires Python 3.10 or newer and a modern browser (Chrome, Firefox, Safari, or Edge).

### Bundled installers (from the source distribution)

If you cloned the repository or downloaded a release archive:

* **Windows** — Double-click `Install_Windows.bat`
* **macOS** — Double-click `Install_macOS.command` (or run `bash Install_macOS.command`)

Both scripts call `pip install -e .` against the bundled source and then launch the annotator.

### From source

```bash
git clone https://github.com/billy-ngo/slots-gel-annotator
cd slots-gel-annotator
pip install -e .
```

---

## Quick start

```bash
slots                       # launch the annotator on port 8062; opens your browser
slots image.tif             # launch and auto-load a gel image
slots --port 9000           # use a custom port
slots --no-browser          # don't open the browser (useful on a headless host)
slots --install             # create a desktop shortcut
slots --update              # check PyPI for an update and install if available
slots --version             # print version and exit
```

The annotator single-instances itself: re-running `slots` while it is already running brings the existing tab to the front instead of starting a duplicate server.

---

## Workflow

1. **Open** — Drag a gel image onto the canvas, or click *Open* to browse. PNG, JPEG, TIFF, and 16-bit raw / TIFF are supported. Bio-Rad / GelDoc / ChemiDoc TIFs (which often embed a red saturation contour) are auto-decoded with channel-max conversion so the imager's clipped-pixel marks survive.
2. **Draw region** — Click *Draw Region* (or press **D**) and trace the analysis area. Lane positions are auto-distributed across the region's width; you can adjust the per-lane separators by dragging.
3. **Label lanes** — Mark ladder lanes with the Ladder checkbox in the metadata table; click the lane on the gel to drop ladder-size bands. Type values in the metadata cells; consecutive cells with the same value automatically merge into a bracket above the gel.
4. **Add free-form annotation** — `+Text (T)` for text labels, `+Line (L)` for arrows or underlines, `Rotate (R)` to spin the image or a selected element Illustrator-style.
5. **Tune the LUT** — Click *LUT* to drag the histogram handles; saturated pixels are auto-flagged in red. The original pixel data is preserved on the server so re-tuning is non-destructive.
6. **Export** — Save as **SVG** (vector, editable, every text element preserved as text) or **PNG** (raster, 2× scale by default). Or save the whole project as a JSON file (image embedded) and reload it later from the same point.

A status bar at the bottom of the window narrates the last action and surfaces errors. All buttons have keyboard shortcuts (shown in their titles).

---

## Features

| Feature | Notes |
|---|---|
| **Vector-native rendering** | The on-screen SVG IS the export. No drift between preview and final figure. |
| **Multi-format input** | PNG / JPEG / TIFF (8-bit) / 16-bit raw / 16-bit TIFF. RGB → grayscale via channel-max so imager-baked red highlights survive. |
| **Auto-stretched LUT** | Default LUT clips at the central 98 % of the histogram (p1 .. p99.5) so dark gels become visible without manual tweaking. |
| **Saturation overlay** | Truly clipped pixels show in red. Threshold is relative to the source dynamic range so it tracks the imager's intent (not the auto-stretched preview). |
| **Multiple ladders** | Mark any number of lanes as ladders — left flank, right flank, internal. Hide-Ladders collapses flank ladders only; internal ladders stay visible with their labels routed to the left. |
| **Smart bracket rotation** | When metadata column labels would otherwise overlap, only the offending labels rotate to 90° — the minimum needed for legibility. |
| **Cell editing** | Spreadsheet-style multi-cell drag-fill, Tab navigation, Esc to cancel, Delete to clear. Click outside the range and the selection clears so the next keystroke can't accidentally overwrite cells you weren't pointing at. |
| **Column reorder** | Drag column headers to reorder; the brackets on the gel follow. |
| **Per-column / per-lane visibility** | A "Show" row lets you toggle lane numbers or any metadata column off without losing its data. |
| **Undo / Redo** | Every state-changing action is undoable (Ctrl+Z / Ctrl+Y). |
| **Smooth zoom + pan** | Mouse wheel zooms (proportional to delta — trackpad-friendly); right-click drag pans. |
| **Dark mode (Invert)** | One-click colour inversion of the gel image and ink colours, for posters with dark backgrounds. |
| **Single-instance** | Re-running `slots` reuses the existing window instead of starting a duplicate server. |
| **Self-contained sessions** | Save → JSON file with the image embedded. Reload anywhere, anytime, no original file needed. |

---

## File-format support

Slots Gel Annotator targets 16-bit raw images from gel-imaging systems (Bio-Rad, Azure, GE, etc.) but tolerates many real-world variations:

| Format | Notes |
|---|---|
| **PNG** | 8-bit and 16-bit grayscale or RGB. RGB is collapsed to grayscale via channel-max (preserves imager-baked red highlights). |
| **JPEG** | 8-bit RGB. Some features (LUT editing, saturation toggle) are disabled — JPEG can't reach the dynamic range needed for them — and an alert explains so on upload. |
| **TIFF** | 8-bit and 16-bit grayscale or RGB. Read via `tifffile` first, with PIL as a fallback for unusual TIFF flavours. |
| **`.raw16`** | 16-bit raw passed through `tifffile`. The format most modern imaging platforms produce. |
| **`.bmp`** | 8-bit. Same caveats as JPEG. |

8-bit uploads automatically enable the saturation overlay so clipped pixels are visible without further configuration. 16-bit uploads keep the LUT controls and saturation toggle enabled for fine-tuning.

---

## Branding & icons

The desktop shortcut (Windows `.lnk`, macOS `.app`, Linux `.desktop`) and the in-app favicon load their icons from `gel_annotator/assets/`. To customize:

| File           | Purpose                                          | Recommended size |
|----------------|--------------------------------------------------|------------------|
| `icon.ico`     | Windows shortcut + window icon                   | multi-resolution `.ico` containing 16 / 32 / 48 / 64 / 128 / 256 |
| `icon.icns`    | macOS `.app` bundle icon (skip if absent — macOS converts `icon-512.png` via `sips`) | 1024×1024 |
| `icon-512.png` | High-resolution PNG used for Linux `.desktop`, web favicon, and macOS fallback | 512×512 |
| `icon-192.png` | Smaller PNG (web manifest, web favicon)         | 192×192 |
| `logo-wide.png`| Banner for the README header (optional, in-app header) | 1200×200 |

PNGs MUST be transparent-background. ICOs/ICNS should bundle multiple resolutions. If a file is missing the loader silently substitutes a 1×1 transparent PNG and the OS falls back to its default app icon.

See [`gel_annotator/assets/README.md`](gel_annotator/assets/README.md) for the `iconutil` / `sips` recipe to generate `.icns` from a single 1024×1024 source.

---

## Sessions

Use the **Save** button to download a JSON file containing the full project state: the image (base64-embedded), the region, lane separators, ladder lanes / bands, metadata column data, every annotation (text, line, custom rotation, custom dx/dy), per-column visibility, the LUT settings, the bit-depth-derived feature gates, and any per-lane ladder shifts.

Saved sessions are **fully self-contained** — the image is embedded as a `data:` URL so the file reloads on a different machine without needing the original raw image.

---

## Robustness

A few things designed to keep you out of trouble:

* **Drag-cancel invariants.** Every in-flight drag (region-draw, region-resize, line-draw, annotation-move, label-move, tick-move, rotation, marquee, multi-move) cleans up through a single `cancelDrag()` path on Esc, blur, pointer-cancel, or any state mutation that would invalidate the drag's coordinates. There is no second mode for the user to be stuck in.
* **Per-feature isolation.** A bug in (say) bracket rotation can't break ladder-band rendering; each rendering pass is isolated. The whole canvas never goes blank because of one bad annotation.
* **Saturation auto-on.** Every new image starts with the saturation overlay enabled so clipped pixels are visible from the moment the image is loaded.
* **Cell range memory.** Drag-select a range, click a cell INSIDE the range to type-fill all of them — Excel-style. Click OUTSIDE the range and the selection clears so the next keystroke can't accidentally overwrite cells you weren't pointing at.
* **Undo across structural changes.** Per-render selection state (`_cellRange`, `_regionSelected`, `_selectedTick`) is never persisted in undo snapshots, so an undo can never restore a "ghost" selection that no longer matches the rendered DOM.

---

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  FastAPI server │  HTTP   │   Browser (SVG)  │
│                 │ ──────> │                  │
│  - upload       │         │  - draw region   │
│  - LUT preview  │         │  - lanes/bands   │
│  - rotate       │         │  - brackets      │
│  - saturation   │         │  - export        │
│                 │         │                  │
│  NO renderer    │         │  the renderer    │
└─────────────────┘         └──────────────────┘
```

* **Backend** (`gel_annotator/server/main.py`): handles image upload, RGB→grayscale collapse, LUT-stretched preview generation, saturation-overlay generation, destructive image rotation. Does not generate exports.
* **Frontend** (`gel_annotator/frontend/`): a single `<svg>` element, built and re-rendered from a state object. All annotations are real SVG primitives (`<rect>`, `<line>`, `<text>`, `<image>`, `<foreignObject>` for inline edit). PNG/SVG export operate on the same DOM nodes the user sees.

Why this design: an earlier iteration kept the on-screen renderer (canvas-based JavaScript) and the export renderer (Pillow + svgwrite, in Python) separate. Every UI tweak had to be ported twice, and the two paths drifted on every release. This rebuild has one renderer. Export is:

```javascript
// SVG: 2 lines
const xml = new XMLSerializer().serializeToString(svgEl);
download(xml, 'figure.svg', 'image/svg+xml');

// PNG: ~12 lines (rasterize the same SVG via a temporary canvas)
```

That's the entire export module.

---

## Troubleshooting

**The browser doesn't open** — Slots polls `/healthz` for up to 10 s before opening. If the browser still doesn't open, navigate to `http://localhost:8062` (or your `--port`) manually.

**"Address already in use"** — Slots single-instances itself, but if it crashed leaving a stale lock file, delete `~/.slots-gel-annotator/server.lock` and try again. Or just use a different `--port`.

**LUT and Saturation buttons are grayed out** — You uploaded an 8-bit image (PNG / JPEG / 8-bit TIFF). Those features need the wider dynamic range of a 16-bit raw to be useful. The hover tooltip says so. Upload a `.raw16` / 16-bit TIFF to unlock them.

**A figure exported as PNG looks pixelated** — PNG export defaults to 2× scale. Re-export as SVG and rasterize it at higher resolution in Inkscape / Illustrator if needed.

**A bracket label rotates 90° unexpectedly** — Smart-rotation kicks in when a label is wider than its bracket. To prevent it, shorten the label or widen the lane.

---

## Project file format (v2)

```json
{
  "version": 2,
  "image_filename": "western_blot_2026-05.tif",
  "image_data_url": "data:image/png;base64,iVBORw0...",
  "image_width": 2480,
  "image_height": 1653,
  "raw_min": 0.0, "raw_max": 255.0,
  "bit_depth": 8,
  "lut": { "min": 0.0, "max": 165.0, "gamma": 1.0 },
  "invert_image": false,
  "region": { "x": 200, "y": 100, "w": 2050, "h": 1400 },
  "region_outline": true,
  "cropped_to_region": false,
  "region_border_width": 2,
  "tick_width": 2,
  "lane_count": 8,
  "ladder": [true, false, false, false, false, false, false, true],
  "lane_separators": null,
  "tick_height": 10,
  "ladder_label_dx": {},
  "columns": [{"id": "col_xyz", "name": "Treatment"}, ...],
  "cells": {"col_xyz": ["Ctrl", "Ctrl", "T1", "T1", "T2", "T2"]},
  "column_visible": {"col_xyz": true},
  "show_lane_numbers": true,
  "bands": {"0": [{"id": "b0a", "y_center": 400, "label": "50"}]},
  "annotations": [],
  "label_overrides": {},
  "hide_ladders": false,
  "bracket_line_style": "solid",
  "line_cap": "butt"
}
```

Sessions saved in v1 are silently upgraded on load.

---

## Citation

If Slots Gel Annotator contributes to a publication, please cite it as:

```
Ngo, B.M. (2026). Slots Gel Annotator [Software].
Available at https://github.com/billy-ngo/slots-gel-annotator
```

---

## Version history

See [CHANGELOG.md](CHANGELOG.md) for the full per-version history. Current release is shown via `slots --version`.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Author

Billy M Ngo · billy.ngo0108@gmail.com · [github.com/billy-ngo](https://github.com/billy-ngo)
