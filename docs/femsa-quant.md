# fEMSA quantification

A fork of [Slots Gel Annotator](https://github.com/billy-ngo/slots-gel-annotator)
that adds raw-intensity band extraction and apparent-Kd fitting, while keeping
everything the upstream tool already does (LUT editing, lane brackets, ladder
bands, SVG/PNG figure export).

Two halves, deliberately decoupled:

| | |
|---|---|
| **`femsa`** | The GUI. Place measurement rows on a gel, integrate raw pixel values, export a CSV. |
| **`femsa-fit`** | A CLI. Read that CSV (or one from Fiji / the iBright software), fit binding models, write a report and figure. |

The split is intentional. The fitting code never needs to know where the
intensities came from, and the extraction code never needs to know what will be
fitted. Either half is usable without the other.

---

## Install

```bash
git clone <this repo> && cd femsa-quant
python3 -m venv .venv && ./.venv/bin/pip install -e .
```

Runs in its own venv on **port 8063**, with its own config directory
(`~/.femsa-quant`), so a stock `slots` install on port 8062 keeps working
untouched. Auto-update is disabled — see [Tracking upstream](#tracking-upstream).

```bash
./.venv/bin/femsa                    # launch, opens a browser
./.venv/bin/femsa path/to/gel.tif    # launch and offer to load a file
./.venv/bin/femsa-fit --help
```

---

## Extraction

### Before anything else: use the raw TIFF

Quantify the **raw 16-bit TIFF**, never an auto-contrasted export. The iBright
applies a display LUT that is not linear in signal.

The app enforces this structurally rather than by convention: the server keeps
the decoded array at native dtype and applies the LUT only when rendering the
preview PNG. The `/quantify` endpoint reads the source array and does not accept
LUT parameters at all. **Nothing you do to the on-screen brightness can change a
measured number** — there is a test asserting exactly that
(`tests/test_quant.py::test_lut_cannot_change_a_measurement`).

### Workflow

1. **Open** the raw TIFF. The header shows `16-bit`; if it says 8-bit you have
   the wrong export.
2. **Draw Region** (`D`) around the lanes, and set the lane count. Drag the lane
   separator ticks if the lanes aren't evenly spaced.
3. **Quantify** (`Q`) to open the panel.
4. **+ Free row**, then drag vertically across the free-probe band. A *row* is a
   horizontal stripe spanning every lane; crossing it with the lane grid gives
   one identically-sized ROI per lane. Repeat with **+ Bound row**.
5. **+ Background** for each signal row — see [Background placement](#background-placement),
   which is the step that most affects your Kd.
6. **New** next to *[Protein] column* creates a `[Protein] nM` column in the lane
   table. Type one concentration per lane. Leave a cell blank to exclude that
   lane (a blank is *not* read as 0 — a real no-protein control and a missing
   value are different things).
7. Set **Probe [DNA] nM** (`Dt`, 8 for the current assay), the **Fragment** this gel
   titrates (`WT`, `-10 shuffle`, …) and a **Replicate** id. The fragment name is
   what lets `femsa-fit` compare fragments later — see [Comparing fragments](#comparing-fragments).
8. **Measure**, read the warnings, then **Export CSV**.

Rows are draggable: grab the middle to move, the top or bottom edge to resize.
Row geometry, concentrations and probe concentration are saved in the project
JSON and covered by undo/redo. Measured *results* are not saved — they are one
click to regenerate, and a cached number could otherwise outlive the row that
produced it.

### Background placement

**This is the single biggest avoidable source of Kd error in the workflow.**

Gel background is almost never flat; there is usually a vertical gradient from
the run. A background stripe measured far from its band estimates the wrong
offset, and the error is multiplied by the band's pixel count.

Measured on a simulated titration with a known **15.0 nM** Kd:

| Background placement | Recovered Kd | R² |
|---|---|---|
| One shared row, ~135 px below the free band | 19.3 nM | 0.9916 |
| One row just below each band | 16.1 nM | 0.9993 |
| One row flanking each band | 14.0 nM | 0.9993 |

So: **one background row per signal row, immediately above or below it**, pointed
at that row via the *serves* dropdown. The app warns when a background row sits
more than 2× its signal row's height away, and `femsa-fit` independently warns
when f_bound comes out negative at low protein (the signature of
over-subtraction).

Subtraction is per-pixel — `background mean × band pixel count` — so the
background row does **not** have to be the same height as the band row. A taller
background stripe just averages over more pixels and gives a better estimate.

### Uniform ROI width

On by default. Every lane's box takes the width of the narrowest lane, centred in
its own lane. This matters because the depletion estimator divides free-probe
intensity in one lane by free-probe intensity in another, and unequal box areas
put a bias straight into that ratio. The ratio estimator is immune (both species
share a lane) — which is precisely why the two disagreeing is diagnostic.

### Saturation

Two independent signals, because gel imagers disagree about what full scale means:

* **`sat_pixels`** — pixels at the dtype ceiling (65535 for uint16). Unambiguous
  when it fires.
* **`plateau_pixels`** — pixels at the image's own maximum. A 16-bit TIFF written
  by a 12- or 14-bit sensor can be genuinely clipped while topping out at 4095,
  where the first test never fires. A flat top of hundreds of pixels inside one
  ROI is clipping; a handful scattered around is noise, so the count is reported
  rather than a bare boolean.

Saturation in the free-probe band flattens the top of the curve and inflates Kd.
If free probe saturates at the exposure where the complex is visible, take two
exposures and quantify each species from the one in range. `femsa-fit
--drop-saturated` shows how much the flagged points are moving the answer.

### CSV schema

One row per (lane, signal row):

```
image, fragment, replicate, lane, lane_label, protein_conc_nM, probe_nM, species, row_name,
roi_x, roi_y, roi_w, roi_h, n_pixels,
integrated_intensity, bg_intensity, net_integrated_intensity,
mean_intensity, bg_mean, max_value, sat_pixels, plateau_pixels, saturated,
excluded, exclude_reason, bg_row, source_dtype, saturation_reference
```

`bg_intensity` is already scaled to the band ROI's pixel count, so
`net = integrated_intensity − bg_intensity` holds directly.

---

## Fitting

```bash
femsa-fit gel1_quant.csv gel2_quant.csv gel3_quant.csv --probe-nm 8
```

Writes `<stem>_fit_report.txt`, `_fit_params.csv`, `_fit_points.csv`, and
`_fit.png` / `_fit.svg`.

### Both f_bound estimators, always

```
ratio      f = I_bound / (I_bound + I_free)          internally normalized
depletion  f = 1 − I_free / I_free(no protein)       external reference
```

Both are computed and compared. Agreement means signal is conserved. If depletion
runs systematically higher, probe is disappearing without showing up in a bound
band — check the wells on a long exposure and look for a smear — and the ratio
method is **understating** binding. The report flags divergence above a median
of 0.08.

### The quadratic is the default, not the hyperbolic

The hyperbolic Langmuir form assumes free protein ≈ total protein. That fails
when Kd is within ~10× of the probe concentration, which at 8 nM probe is the
entire low-nM regime, and it returns an inflated, floor-limited Kd.

`femsa-fit` fits the exact 1:1 quadratic

```
f = fmax · [ (Kd+Pt+Dt) − √((Kd+Pt+Dt)² − 4·Pt·Dt) ] / (2·Dt)
```

and reports the hyperbolic alongside it. **The ratio between them is itself the
diagnostic** for whether depletion matters at your probe concentration: near 1.0
means it doesn't; well above 1.0 means the quadratic is doing real work.

A Hill fit is included by default (`--no-hill` to skip). Interpret `n` cautiously:
apparent cooperativity on a gel can come from multiple motif matches on the
fragment — relevant for a 150 bp probe — from oligomerisation, or from
non-equilibrium run effects. It describes curve shape, not mechanism.

### Statistics

* Concentrations are fitted **untransformed**; the log axis is for the plot only.
  Fitting against log(Pt) silently reweights the low-concentration points.
* **Each replicate is fitted independently** and the Kd values combined. Pooling
  normalized points into one fit treats replicates as extra data and understates
  uncertainty.
* Kd is log-normally distributed, so the combination is a **geometric mean** with
  a 95% CI built on log(Kd). Per-fit intervals are also computed on the log scale,
  so they can never run negative.
* **`fmax` floats** unless you pass `--fmax`. An fmax well below 1 is a useful
  flag for inactive protein or damaged probe; pinning it hides that and pushes
  the error into Kd instead.
* Results are always labelled **apparent Kd**. A gel perturbs the equilibrium it
  measures — fast-dissociating complexes partially fall apart during loading and
  the run — so EMSA affinities skew weak relative to solution methods.

### Warnings the report will raise

Saturated ROIs in the fit · ratio/depletion divergence · negative f_bound at low
protein (background over-subtraction) · no 0 nM lane · Kd within 10× of Dt ·
Kd extrapolated outside the titrated range · fmax well below 1 · Hill n
significantly above 1 · fewer than 3 independent replicates · non-convergence · fmax railing above 1.

### Other input formats

The fitter is not tied to this app's export. It also reads:

* **Wide** — one row per lane with separate free/bound intensity columns
  (Fiji Gel Analyzer, iBright software).
* **Fraction** — one row per lane with `f_bound` precomputed. The depletion
  cross-check needs raw intensities and is skipped, and the report says so.

Header matching is case- and punctuation-insensitive: `Protein (nM)`,
`protein_conc_nM` and `[Protein] nM` all resolve, as do `1,000` and `1000 nM`.

---

## Comparing fragments

The specificity arm — WT vs a scrambled or shuffled motif — ends in one figure:
apparent Kd per fragment.

### 1. Name the fragment on every gel

Type it in the **Fragment** field before exporting. It goes into the CSV's
`fragment` column and into the filename:

```
FLUORO_..._raw_WT_rep1_quant.csv
FLUORO_..._raw_-10_shuffle_rep1_quant.csv
```

Use the same spelling every time (`-10 shuffle`, not `-10 shuffle` on one gel and
`-10shuf` on the next) — replicates are grouped by exact name.

### 2. Fit them all at once

```bash
femsa-fit *_quant.csv --fmax 1.0
```

Every replicate is still fitted on its own; replicates are then grouped by
fragment, and because two or more fragments are present you also get:

| File | |
|---|---|
| `femsa_compare.png` / `.svg` | the comparison figure |
| `femsa_compare.csv` | Kd, 95% CI, fold change vs reference, per-replicate values |
| `femsa_<fragment>_fit.png` | each fragment's binding curve |
| `femsa_fit_report.txt` | a FRAGMENT COMPARISON table, then a full report per fragment |

For older CSVs that have no fragment column, name them on the command line:
`femsa-fit WT=old_rep1.csv "-10 shuffle=old_m10.csv"`. Filenames and labels that
start with `-` are fine — the tool does not mistake them for options.

| Option | |
|---|---|
| `--reference NAME` | what fold changes are relative to (default: `WT` if present, else the first fragment) |
| `--style bar` / `dot` | bars on a linear axis from zero (default), or points on a log axis |
| `--compare-model` | `quadratic` (default), `hill`, or `hyperbolic` |
| `--compare-method` | `ratio` (default) or `depletion` |
| `--title` | figure title |

### Reading the figure

**Lower Kd = tighter binding.** Kd is a dissociation constant, so it runs
opposite to affinity: if the motif matters, WT has the *smallest* Kd and the
shuffles come out larger. The y-axis says this, and every fold change is written
with its direction (`3.6× weaker`), never as a bare ratio.

Each fragment shows its replicates as points, the geometric mean as a bar (or a
heavy line in `dot` style), and the 95% CI of that mean as whiskers.

**Use `dot` when fragments differ by more than ~10×.** Kd is log-normal. On a
linear axis a 40 nM WT becomes a sliver next to a 2 µM mutant and its error bar
disappears. Bars are never drawn on a log axis, because a bar's length only means
something against a zero baseline.

### Fragments that barely bind

A shuffled motif may shift only a little probe within the titration. A curve
that never reaches its midpoint does not determine a Kd, and fitting one anyway
fails in two ways:

* an **extrapolated** Kd, with a CI spanning orders of magnitude, that wrecks the
  axis for everything else; or
* with `fmax` floating, the **low-plateau trap**: a curve that creeps up to
  f ≈ 0.3 gets fit as "saturates early at 30%" — a *small* Kd that makes the
  shuffle look as tight as WT. On simulated replicates scattered around a true
  Kd of 900 nM, one fit to 162 nM this way (fmax 0.32).

So each replicate is classified before it is plotted. If f_bound never reaches 0.5
**and** the fit had to extrapolate Kd past the data or invent a plateau below 0.7,
it is reported as a **lower bound** — `Kd > 250 nM`, the top concentration tested
— and drawn as a hollow bar with an arrow and open triangles, never as a
measurement. A curve that stops just short of 0.5 but fits a normal plateau with
Kd inside the range is still a measurement: censoring it would print a false
bound.

When some replicates of a fragment are bounds, the geometric mean is unknown but
a bound on it is not: substituting each bound for its unknown value gives a number
the true geometric mean can only exceed. That is what the figure shows, labelled
`>`, with no CI.

**If a fragment comes out as a bound, extend its titration** — higher protein
concentrations until it half-saturates — if you need the number rather than the
inequality. For a specificity claim, `> 5× weaker than WT` is often enough.

### Pin fmax when comparing

Floating fmax lets each fragment trade Kd against its plateau independently, so
differences in the fit, not the binding, can show up as differences in Kd. On
a real titration, floating fmax railed at its 1.5 bound and more than doubled
the fitted Kd relative to fmax pinned at 1.
Same protein prep and same probe means the same maximum shift, so compare with
`--fmax 1.0` unless the WT titration clearly plateaus below 1.

---

## Troubleshooting

**"Quantify does nothing when I click it or press Q."** Two causes, both fixed,
but worth knowing:

* *No image open.* Quantify measures pixels, so it is inert until you load one.
  The button is greyed out and `Q` now says so in the status bar instead of
  failing silently.
* *The panel opened below the fold.* The sidebar scrolls, and the metadata table
  above the panel grows with the lane count — past ~16 lanes the panel opened
  off-screen and the button appeared dead. Activating Quantify now scrolls the
  panel into view, the panel's own help is collapsed by default, and the long
  table hint is hidden while quantifying.

**A change to the UI doesn't show up.** Asset `?v=` tags are derived from file
content, so a browser cannot serve a stale `app.js` / `quant.js` / `style.css`.
If you edited a file and see no change, you are probably talking to a different
server — check the port. `femsa` falls back to 8064, 8065, … when 8063 is busy,
and prints the URL it actually bound.

**"Already running at http://localhost:80xx".** A previous instance holds
`~/.femsa-quant/server.lock`. Either use the URL it prints, or stop the old one:

```bash
lsof -ti tcp:8063 | xargs kill && rm -f ~/.femsa-quant/server.lock
```

Note `pkill -f gel_annotator` does *not* match it — the process command line is
`.venv/bin/femsa`.

---

## Tests

```bash
./.venv/bin/python -m pytest
```

68 tests. The fixtures are synthetic gels and titrations with **known** Kd values
(and a deliberate background gradient) — checks are against ground truth, not golden files, so a
regression fails for the right reason.

---

## What was added to upstream Slots

| File | |
|---|---|
| `gel_annotator/server/quant.py` | new — ROI integration, saturation, lane profile |
| `gel_annotator/frontend/quant.js` | new — the entire Quantify panel |
| `gel_annotator/fit/` | new — binding models, CSV ingestion, report, CLI, fragment comparison |
| `tests/` | new |
| `server/main.py` | +3 routes, 1 import |
| `frontend/app.js` | 8 hook points, ~20 lines total |
| `frontend/index.html` | panel markup + script tag |
| `frontend/style.css` | appended block |
| `cli.py`, `pyproject.toml`, `__init__.py` | fork identity, port, disabled auto-update |

The app.js surface is five `window.FEMSA` calls (`render`, `onPointerDown`,
`resetForNewImage`, `adoptSavedState`, `syncTool`), a `quant` slot in `state` and
`UNDOABLE_FIELDS`, and two `refreshPanel()` calls. Everything else is a new file,
which can never conflict on merge.

## Tracking upstream

```bash
git fetch upstream
git merge upstream/main
```

Auto-update is disabled in this fork. Upstream ships to PyPI as `slotsgeltool`;
`pip install --upgrade slotsgeltool` would overwrite `gel_annotator` with
upstream's copy and silently delete the quantification layer. `femsa --update`
refuses and points here instead.
