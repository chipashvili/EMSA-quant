"""Read band-intensity CSVs and turn them into fraction-bound points.

Three input shapes are accepted, checked in this order:

1. **ROI form** — one row per (lane, species). What this app's Quantify
   panel exports. Has a ``species`` column plus an intensity column.
   Both f_bound estimators are computed.

2. **Wide-intensity form** — one row per lane, with separate free and
   bound intensity columns. What you get from Fiji's Gel Analyzer or the
   iBright software after pasting two columns side by side. Both
   estimators are computed.

3. **Fraction form** — one row per lane with ``f_bound`` already
   computed. Only the ratio estimator exists; the depletion cross-check
   is unavailable and the report says so.

Supporting all three is the reason this module exists rather than the
CLI just parsing its own export: the fitting half of the workflow has to
stay usable no matter where the intensities came from.

Only the standard library and numpy are used — pandas would be a heavy
dependency for reading a file with at most a few hundred rows.
"""

from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass, field
from pathlib import Path


# ── Column resolution ─────────────────────────────────────────────────
#
# Header matching is case- and punctuation-insensitive so a CSV that
# calls a column "Protein (nM)", "protein_conc_nM", or "[Protein] nM"
# all resolve to the same thing. Users assemble these by hand and by
# copy-paste; being strict here just produces unhelpful errors.

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


ALIASES: dict[str, tuple[str, ...]] = {
    "lane":       ("lane", "lanenumber", "laneno", "laneindex", "lane_label", "lanelabel"),
    "conc":       ("proteinconcnm", "proteinnm", "protein", "conc", "concnm",
                   "concentration", "concentrationnm", "pt", "ptnm", "proteinconc",
                   "proteinconcentration", "proteinconcentrationnm"),
    "probe":      ("probenm", "probe", "dt", "dtnm", "probeconcnm", "dna", "dnanm",
                   "probeconc", "probeconcentration"),
    "species":    ("species", "band", "state", "form"),
    "net":        ("netintegratedintensity", "netintensity", "net", "netvolume"),
    "raw":        ("integratedintensity", "intensity", "rawintensity", "volume",
                   "sum", "integrateddensity", "rawintdensity", "intden", "rawintden"),
    "bg":         ("bgintensity", "background", "bg", "backgroundintensity", "bgvolume"),
    "saturated":  ("saturated", "issaturated", "saturation", "satflag"),
    "excluded":   ("excluded", "exclude", "skip", "omit"),
    "replicate":  ("replicate", "rep", "biologicalreplicate", "prep", "experiment"),
    "ifree":      ("ifree", "free", "freeintensity", "unbound", "iunbound",
                   "freeprobe", "netfree", "freenet"),
    "ibound":     ("ibound", "bound", "boundintensity", "shifted", "ishifted",
                   "complex", "netbound", "boundnet"),
    "ffree":      ("ifreenoprotein", "freenoprotein", "freeref", "ifree0"),
    "fbound":     ("fbound", "fractionbound", "fraction", "f", "boundfraction",
                   "fbratio", "fractionshifted"),
}

FREE_TOKENS = ("free", "unbound", "probe", "f")
BOUND_TOKENS = ("bound", "shift", "shifted", "complex", "b", "supershift")


def resolve(header: list[str]) -> dict[str, str]:
    """Map canonical keys to the actual header strings present."""
    norm_to_actual: dict[str, str] = {}
    for h in header:
        norm_to_actual.setdefault(_norm(h), h)
    found: dict[str, str] = {}
    for key, names in ALIASES.items():
        for n in names:
            if n in norm_to_actual:
                found[key] = norm_to_actual[n]
                break
    return found


def _num(row: dict, col: str | None, default: float = math.nan) -> float:
    if not col:
        return default
    raw = str(row.get(col, "")).strip()
    if not raw:
        return default
    raw = raw.replace(",", "")
    raw = re.sub(r"\s*[a-zA-Zµ%]+\s*$", "", raw)   # strip a trailing unit
    try:
        return float(raw)
    except ValueError:
        return default


def _truthy(row: dict, col: str | None) -> bool:
    if not col:
        return False
    v = str(row.get(col, "")).strip().lower()
    return v in ("1", "true", "yes", "y", "t")


def _species_of(value: str) -> str | None:
    v = _norm(value)
    if not v:
        return None
    if any(v.startswith(t) or t in v for t in BOUND_TOKENS if t != "b"):
        return "bound"
    if v in ("b",):
        return "bound"
    if any(v.startswith(t) for t in FREE_TOKENS if t != "f"):
        return "free"
    if v in ("f",):
        return "free"
    return "other"


# ── Data model ────────────────────────────────────────────────────────


@dataclass
class Point:
    lane: str
    conc: float                    # total protein, nM
    i_free: float = math.nan
    i_bound: float = math.nan
    f_ratio: float = math.nan      # I_bound / (I_bound + I_free)
    f_depletion: float = math.nan  # 1 − I_free / I_free(reference)
    saturated: bool = False
    excluded: bool = False
    exclude_reason: str = ""


@dataclass
class Replicate:
    name: str
    source: Path
    probe_nm: float
    points: list[Point] = field(default_factory=list)
    has_depletion: bool = False
    reference_conc: float = math.nan
    notes: list[str] = field(default_factory=list)

    def usable(self, method: str) -> list[Point]:
        """Points that can enter a fit with the given f_bound estimator."""
        attr = "f_ratio" if method == "ratio" else "f_depletion"
        return [
            p for p in self.points
            if not p.excluded
            and math.isfinite(p.conc) and p.conc >= 0
            and math.isfinite(getattr(p, attr))
        ]


# ── Loading ───────────────────────────────────────────────────────────


def _finish(points: list[Point], rep: Replicate) -> None:
    """Fill in f_ratio / f_depletion once every lane's intensities are in."""
    for p in points:
        tot = 0.0
        have = False
        if math.isfinite(p.i_free):
            tot += p.i_free; have = True
        if math.isfinite(p.i_bound):
            tot += p.i_bound; have = True
        if have and tot > 0 and math.isfinite(p.i_bound):
            p.f_ratio = p.i_bound / tot

    # Depletion reference: the lowest-concentration usable lane. A true
    # 0 nM control is what this should be; if there isn't one, every
    # f_depletion is biased low by whatever is already bound in the
    # reference lane, so we record the concentration used and let the
    # report warn about it.
    candidates = [p for p in points
                  if not p.excluded and math.isfinite(p.conc) and math.isfinite(p.i_free) and p.i_free > 0]
    if candidates:
        ref = min(candidates, key=lambda p: p.conc)
        rep.reference_conc = ref.conc
        rep.has_depletion = True
        for p in points:
            if math.isfinite(p.i_free) and ref.i_free > 0:
                p.f_depletion = 1.0 - p.i_free / ref.i_free


def _load_roi_form(rows: list[dict], cols: dict[str, str], rep: Replicate) -> list[Point]:
    """One row per (lane, species). Sum species by role, then combine."""
    intensity_col = cols.get("net") or cols.get("raw")
    bg_col = cols.get("bg")
    use_raw_minus_bg = (cols.get("net") is None and bg_col is not None)

    by_lane: dict[str, Point] = {}
    order: list[str] = []
    for r in rows:
        lane = str(r.get(cols.get("lane", ""), "")).strip() or "?"
        if lane not in by_lane:
            by_lane[lane] = Point(lane=lane, conc=_num(r, cols.get("conc")))
            order.append(lane)
        p = by_lane[lane]
        if not math.isfinite(p.conc):
            p.conc = _num(r, cols.get("conc"))

        val = _num(r, intensity_col)
        if use_raw_minus_bg and math.isfinite(val):
            val -= _num(r, bg_col, 0.0)

        sp = _species_of(str(r.get(cols.get("species", ""), "")))
        if sp == "free" and math.isfinite(val):
            p.i_free = val if not math.isfinite(p.i_free) else p.i_free + val
        elif sp == "bound" and math.isfinite(val):
            # Several bound rows (supershifts, multiple complexes) sum
            # into one bound population.
            p.i_bound = val if not math.isfinite(p.i_bound) else p.i_bound + val

        if _truthy(r, cols.get("saturated")):
            p.saturated = True
        if _truthy(r, cols.get("excluded")):
            p.excluded = True
            p.exclude_reason = str(r.get("exclude_reason", "") or "marked excluded in CSV")

    pts = [by_lane[k] for k in order]
    for p in pts:
        if not math.isfinite(p.i_bound):
            p.i_bound = 0.0
    return pts


def _load_wide_form(rows: list[dict], cols: dict[str, str]) -> list[Point]:
    """One row per lane with separate free / bound intensity columns."""
    pts = []
    for i, r in enumerate(rows):
        lane = str(r.get(cols.get("lane", ""), "")).strip() or str(i + 1)
        p = Point(
            lane=lane,
            conc=_num(r, cols.get("conc")),
            i_free=_num(r, cols.get("ifree")),
            i_bound=_num(r, cols.get("ibound")),
            saturated=_truthy(r, cols.get("saturated")),
            excluded=_truthy(r, cols.get("excluded")),
        )
        # Optional background column applies to both species.
        bg = _num(r, cols.get("bg"), 0.0)
        if bg:
            if math.isfinite(p.i_free):
                p.i_free -= bg
            if math.isfinite(p.i_bound):
                p.i_bound -= bg
        if p.excluded:
            p.exclude_reason = "marked excluded in CSV"
        pts.append(p)
    return pts


def _load_fraction_form(rows: list[dict], cols: dict[str, str]) -> list[Point]:
    """One row per lane with f_bound already computed."""
    pts = []
    for i, r in enumerate(rows):
        lane = str(r.get(cols.get("lane", ""), "")).strip() or str(i + 1)
        pts.append(Point(
            lane=lane,
            conc=_num(r, cols.get("conc")),
            f_ratio=_num(r, cols.get("fbound")),
            saturated=_truthy(r, cols.get("saturated")),
            excluded=_truthy(r, cols.get("excluded")),
        ))
    return pts


def load_csv(path: Path, default_probe_nm: float) -> list[Replicate]:
    """Read one CSV into one Replicate per distinct ``replicate`` value."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames or []
        rows = [r for r in reader if any((v or "").strip() for v in r.values())]

    if not rows:
        raise ValueError(f"{path.name}: no data rows.")

    cols = resolve(header)
    if "conc" not in cols:
        raise ValueError(
            f"{path.name}: no protein-concentration column found. Expected one of "
            f"protein_conc_nM / protein / conc / Pt. Header was: {', '.join(header)}"
        )

    # Split by replicate first so a single pooled CSV still gets
    # per-replicate fits, which is the whole point of the spec's
    # "fit each replicate independently" rule.
    rep_col = cols.get("replicate")
    groups: dict[str, list[dict]] = {}
    for r in rows:
        key = (str(r.get(rep_col, "")).strip() if rep_col else "") or path.stem
        groups.setdefault(key, []).append(r)

    out: list[Replicate] = []
    for name, grows in groups.items():
        probe = default_probe_nm
        if "probe" in cols:
            v = _num(grows[0], cols["probe"])
            if math.isfinite(v) and v > 0:
                probe = v

        rep = Replicate(name=name, source=path, probe_nm=probe)

        if "species" in cols and ("net" in cols or "raw" in cols):
            pts = _load_roi_form(grows, cols, rep)
            rep.notes.append("ROI form: intensities summed per species from a long-format CSV.")
        elif "ifree" in cols or "ibound" in cols:
            pts = _load_wide_form(grows, cols)
            rep.notes.append("Wide form: separate free / bound intensity columns.")
        elif "fbound" in cols:
            pts = _load_fraction_form(grows, cols)
            rep.notes.append(
                "Fraction form: f_bound taken as given. The depletion cross-check "
                "needs raw intensities and cannot be run."
            )
            rep.points = pts
            out.append(rep)
            continue
        else:
            raise ValueError(
                f"{path.name}: could not identify the intensity columns. Provide either "
                f"a 'species' column plus an intensity column, separate free/bound "
                f"intensity columns, or a precomputed 'f_bound' column. "
                f"Header was: {', '.join(header)}"
            )

        _finish(pts, rep)
        rep.points = pts
        out.append(rep)

    return out


def load_all(paths: list[Path], default_probe_nm: float) -> list[Replicate]:
    reps: list[Replicate] = []
    for p in paths:
        reps.extend(load_csv(p, default_probe_nm))
    # Disambiguate identically-named replicates coming from different
    # files (e.g. three gels each with replicate "1" in the CSV).
    seen: dict[str, int] = {}
    for r in reps:
        if sum(1 for x in reps if x.name == r.name) > 1:
            seen[r.name] = seen.get(r.name, 0) + 1
            r.name = f"{r.source.stem}:{r.name}"
    return reps
