"""Compare apparent Kd across DNA fragments (WT vs mutant probes).

The specificity arm of an EMSA study asks one question: does destroying
the motif destroy the binding? Answering it means putting the WT Kd next
to the Kd of each mutant or shuffled fragment, measured the same way.

The hard part is not the plot, it is weak binders. A fragment whose
motif has been shuffled may barely shift within the titration, and a
curve that never reaches its midpoint does not determine a Kd:

* extrapolated fits return huge numbers with confidence intervals
  spanning orders of magnitude, which then dominate any bar chart; and
* with fmax floating, a curve that only creeps up to f = 0.3 can be fit
  as "saturates early at a low plateau" — a SMALL Kd with a small fmax.
  That makes the shuffled fragment look as tight as WT, which is exactly
  backwards and exactly the wrong conclusion to hand a reviewer.

So every replicate's Kd is first classified. If the titration never got
to half-saturation AND the fit could only explain it by extrapolating Kd
past the data or by inventing a low plateau, the result is reported as a
LOWER BOUND ("Kd > 250 nM") rather than as a number. (A curve that stops
just short of f = 0.5 but fits a normal plateau with Kd inside the range
is still a measurement — censoring it would print a false bound.) Censored results are carried through the statistics
honestly (see :func:`summarize_fragment`) and drawn as bounds, not bars
of made-up height.
"""

from __future__ import annotations

import csv
import math
import re
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from gel_annotator.fit.models import FitResult, summarize_kd

# Fraction of TOTAL probe that must be shifted somewhere in the titration
# for the midpoint to count as sampled. Measured against total probe, not
# against the fitted fmax, because the fitted fmax is exactly the number
# the low-plateau trap corrupts. Falling short of it only triggers
# censoring together with an unphysical fit (see classify_kd); if the
# protein itself can only shift a minority of the probe, fragments get
# reported as bounds — "weaker binder", the conservative direction for a
# specificity claim — and the report's low-fmax warning says why.
HALF_SATURATION = 0.5

# A fitted plateau below this, on a curve that never reached half-
# saturation, is treated as the fitter inventing an early plateau rather
# than as a real one. Same threshold as the report's "fmax well below 1"
# warning, so the two never disagree about what counts as a low plateau.
LOW_PLATEAU = 0.7

UNLABELED = "(unlabeled)"


# ── Per-replicate classification ──────────────────────────────────────


@dataclass
class KdEstimate:
    """One replicate's Kd, or the bound it is known to lie beyond."""
    replicate: str
    kind: str                           # "value" | "lower" | "upper" | "none"
    value: float                        # the Kd, or the bound for lower/upper
    ci95: tuple[float, float] = (math.nan, math.nan)
    reason: str = ""


def classify_kd(
    fit: FitResult | None,
    concs: list[float],
    fracs: list[float],
    replicate: str = "",
) -> KdEstimate:
    """Decide whether a fitted Kd is a measurement or only a bound."""
    nan = (math.nan, math.nan)
    if fit is None or not fit.converged or not math.isfinite(fit.kd):
        return KdEstimate(replicate, "none", math.nan, nan,
                          fit.message if fit is not None else "not fitted")

    pairs = [(c, f) for c, f in zip(concs, fracs)
             if math.isfinite(c) and c > 0 and math.isfinite(f)]
    if not pairs:
        return KdEstimate(replicate, "none", math.nan, nan, "no points above 0 nM")
    cmin = min(c for c, _ in pairs)
    cmax = max(c for c, _ in pairs)
    f_top = max(f for _, f in pairs)

    if f_top < HALF_SATURATION:
        # Not reaching f = 0.5 is not by itself proof that Kd lies beyond
        # the range. Not every probe molecule is shiftable, so a real
        # plateau of ~0.9 puts a Kd just inside the range at f ~ 0.47 by
        # the top point — calling that "Kd > 250 nM" would be FALSE.
        # Censor only when the fit then had to do something unphysical to
        # explain the curve: extrapolate Kd past the data, or invent a low
        # plateau (the trap in the module docstring).
        fmax_fit = fit.params.get("fmax", 1.0)
        head = (f"never reached half-saturation (max f_bound {f_top:.2f} by "
                f"{cmax:g} nM, the highest concentration tested)")
        if fit.kd > cmax:
            return KdEstimate(
                replicate, "lower", cmax, nan,
                f"{head}; fitted Kd ({fit.kd:.3g} nM) is extrapolated beyond the data",
            )
        if fmax_fit < LOW_PLATEAU:
            return KdEstimate(
                replicate, "lower", cmax, nan,
                f"{head}; the fit could only explain it with a plateau of "
                f"fmax = {fmax_fit:.2f}, i.e. by treating a weak binder as a tight one "
                f"that saturates early. Reported as a bound, which assumes the probe "
                f"can be at least {max(LOW_PLATEAU, 2 * f_top):.2f} shifted — check "
                f"that the reference titration reaches that",
            )
        # Near-full plateau, Kd inside the range: a measurement, just a
        # loosely determined one. Its CI says how loose.
    if fit.kd > cmax:
        return KdEstimate(
            replicate, "lower", cmax, nan,
            f"fitted Kd ({fit.kd:.3g} nM) is extrapolated beyond the highest "
            f"concentration tested; the plateau was not sampled",
        )
    if fit.kd < cmin:
        return KdEstimate(
            replicate, "upper", cmin, nan,
            f"fitted Kd ({fit.kd:.3g} nM) is below the lowest nonzero "
            f"concentration tested; the rising phase was not sampled",
        )
    return KdEstimate(replicate, "value", fit.kd, fit.ci95.get("kd", nan))


# ── Per-fragment summary ──────────────────────────────────────────────


@dataclass
class FragmentSummary:
    fragment: str
    kind: str                           # "value" | "lower" | "upper" | "mixed" | "none"
    value: float                        # geometric mean, or a bound on it
    ci95: tuple[float, float]
    n: int                              # replicates contributing a value or a bound
    n_censored: int
    estimates: list[KdEstimate] = field(default_factory=list)
    log10_sd: float = math.nan
    basis: str = ""
    note: str = ""


def summarize_fragment(fragment: str, estimates: list[KdEstimate]) -> FragmentSummary:
    """Combine one fragment's replicates, carrying censoring through.

    All replicates determined: geometric mean with a t-based 95% CI on
    log(Kd) — the same statistic the per-fragment report uses.

    Some replicates censored: the geometric mean cannot be computed, but
    a bound on it can. Substitute each censored replicate's bound for its
    unknown value and take the geometric mean. Because every true value
    lies at or beyond its bound and log is monotone, the true geometric
    mean lies at or beyond that number too. It is a valid bound, not an
    approximation, and it is reported as one.
    """
    usable = [e for e in estimates if e.kind != "none"]
    n_cens = sum(1 for e in usable if e.kind in ("lower", "upper"))
    nan2 = (math.nan, math.nan)

    if not usable:
        return FragmentSummary(fragment, "none", math.nan, nan2, 0, 0, estimates,
                               note="no replicate produced a usable fit")

    kinds = {e.kind for e in usable}
    if kinds == {"value"}:
        single_ci = usable[0].ci95 if len(usable) == 1 else None
        s = summarize_kd([e.value for e in usable], single_ci)
        return FragmentSummary(fragment, "value", s.geometric_mean, s.ci95, s.n, 0,
                               estimates, log10_sd=s.log10_sd, basis=s.basis, note=s.note)

    if "lower" in kinds and "upper" in kinds:
        return FragmentSummary(
            fragment, "mixed", math.nan, nan2, len(usable), n_cens, estimates,
            note="replicates disagree about which side of the titrated range Kd lies "
                 "on; no summary is possible — inspect the individual gels",
        )

    kind = "lower" if "lower" in kinds else "upper"
    gm = float(f"{np.exp(np.mean(np.log([e.value for e in usable]))):.12g}")
    side = "beyond the highest" if kind == "lower" else "below the lowest"
    return FragmentSummary(
        fragment, kind, gm, nan2, len(usable), n_cens, estimates,
        basis="censored",
        note=f"{n_cens} of {len(usable)} replicate(s) put Kd {side} concentration "
             f"tested, so only a bound on the geometric mean is known",
    )


# ── Reference and fold change ─────────────────────────────────────────


def pick_reference(fragments: list[str], requested: str | None) -> str:
    """The fragment everything else is compared against.

    An explicit --reference wins. Otherwise a fragment called WT (or
    wild type) is the obvious anchor; failing that, the first one given.
    """
    if requested is not None:
        for f in fragments:
            if f == requested:
                return f
        for f in fragments:
            if f.lower() == requested.lower():
                return f
        raise ValueError(
            f"--reference {requested!r} is not one of the fragments: "
            + ", ".join(repr(f) for f in fragments)
        )
    for f in fragments:
        if re.sub(r"[^a-z]", "", f.lower()) in ("wt", "wildtype"):
            return f
    return fragments[0]


def order_fragments(fragments: list[str], reference: str) -> list[str]:
    """Reference first, the rest in the order they were given."""
    return [reference] + [f for f in fragments if f != reference]


def fold_change(frag: FragmentSummary, ref: FragmentSummary) -> tuple[float, str]:
    """Kd(fragment) / Kd(reference), with its kind.

    >1 means the fragment binds WEAKER than the reference (larger Kd).
    A censored fragment against a determined reference gives a bound on
    the fold change in the same direction as the censoring.
    """
    if frag.fragment == ref.fragment:
        return 1.0, "reference"
    if ref.kind != "value" or not math.isfinite(ref.value) or ref.value <= 0:
        return math.nan, "n/a"
    if frag.kind in ("value", "lower", "upper") and math.isfinite(frag.value):
        return frag.value / ref.value, frag.kind
    return math.nan, "n/a"


def fold_phrase(value: float, kind: str) -> str:
    """Human wording that states the direction explicitly.

    Saying "6× weaker" rather than "6×" matters here: Kd runs opposite to
    affinity, and a bare ratio invites reading a larger number as better
    binding.
    """
    if kind == "reference":
        return "reference"
    if kind == "n/a" or not math.isfinite(value):
        return "n/a"

    def num(v: float) -> str:
        return f"{v:.2g}" if v < 10 else f"{v:.0f}"

    if kind == "lower":
        return f"> {num(value)}× weaker" if value >= 1 else "not resolved"
    if kind == "upper":
        return f"> {num(1 / value)}× tighter" if value <= 1 else "not resolved"
    if 0.9 <= value <= 1.1:
        return "≈ same"
    return f"{num(value)}× weaker" if value > 1 else f"{num(1 / value)}× tighter"


def kd_text(s: FragmentSummary) -> str:
    def num(v: float) -> str:
        return f"{v:.3g}"
    if s.kind == "value":
        return f"{num(s.value)} nM"
    if s.kind == "lower":
        return f"> {num(s.value)} nM"
    if s.kind == "upper":
        return f"< {num(s.value)} nM"
    return "n.d."


def safe_name(fragment: str) -> str:
    """Filename-safe form of a fragment label ("-10 shuffle" -> "-10_shuffle")."""
    s = re.sub(r"[^A-Za-z0-9._+-]+", "_", fragment.strip()).strip("_")
    return s or "unlabeled"


# ── Text and table outputs ────────────────────────────────────────────


def comparison_section(
    summaries: list[FragmentSummary],
    reference: str,
    model: str,
    method: str,
    fmax_note: str,
) -> str:
    by = {s.fragment: s for s in summaries}
    ref = by[reference]
    L = [
        "=" * 74,
        "FRAGMENT COMPARISON",
        "=" * 74,
        "",
        f"  Model: {model} / {method} estimator.  {fmax_note}",
        f"  Fold change is Kd(fragment) / Kd({reference}); larger Kd = WEAKER binding.",
        "",
        f"  {'fragment':<20}{'n':>3}  {'apparent Kd':>13}  {'95% CI':<18}  vs {reference}",
        f"  {'-' * 20}{'-' * 3}  {'-' * 13}  {'-' * 18}  {'-' * 18}",
    ]
    for s in summaries:
        ci = (f"[{s.ci95[0]:.3g}, {s.ci95[1]:.3g}]"
              if s.kind == "value" and all(math.isfinite(v) for v in s.ci95) else "")
        fv, fk = fold_change(s, ref)
        L.append(f"  {s.fragment:<20}{s.n:>3}  {kd_text(s):>13}  {ci:<18}  {fold_phrase(fv, fk)}")
    L.append("")
    for s in summaries:
        notes = []
        if s.note:
            notes.append(s.note)
        for e in s.estimates:
            if e.kind != "value" and e.reason:
                notes.append(f"replicate {e.replicate}: {e.reason}")
        if notes:
            L.append(f"  {s.fragment}:")
            for n in notes:
                wrapped = textwrap.wrap(n, 68) or [""]
                L.append(f"    - {wrapped[0]}")
                L.extend(f"      {w}" for w in wrapped[1:])
    L.append("")
    for line in textwrap.wrap(
        "Only compare fragments measured under the same conditions: same probe "
        "concentration, same protein prep series, same gel system. A Kd ratio "
        "across different protein preps mixes affinity with prep-to-prep "
        "variation in active protein fraction.", 72):
        L.append(f"  {line}")
    L.append("")
    return "\n".join(L) + "\n"


def _replicate_token(e: KdEstimate) -> str:
    """'rep1=41.2', 'rep2=>250', 'rep3=n.d.' — one replicate for the CSV."""
    if not math.isfinite(e.value):
        return f"{e.replicate}=n.d."
    prefix = {"lower": ">", "upper": "<"}.get(e.kind, "")
    return f"{e.replicate}={prefix}{e.value:.4g}"


def write_comparison_csv(
    path: Path,
    summaries: list[FragmentSummary],
    reference: str,
    model: str,
    method: str,
) -> None:
    by = {s.fragment: s for s in summaries}
    ref = by[reference]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow([
            "fragment", "n_replicates", "n_censored", "kind", "kd_nM",
            "kd_ci_lo", "kd_ci_hi", "log10_kd_sd", "reference", "fold_vs_reference",
            "fold_kind", "fold_phrase", "model", "method", "replicate_kds", "note",
        ])
        for s in summaries:
            fv, fk = fold_change(s, ref)
            reps = "; ".join(_replicate_token(e) for e in s.estimates)
            w.writerow([
                s.fragment, s.n, s.n_censored, s.kind,
                s.value, s.ci95[0], s.ci95[1], s.log10_sd,
                reference, fv, fk, fold_phrase(fv, fk), model, method, reps, s.note,
            ])


# ── Figure ────────────────────────────────────────────────────────────

# One hue for every fragment: the fragments are already named on the x
# axis, so coloring them would be a second, redundant encoding of the
# same identity. Validated with the dataviz palette checker (lightness
# band, chroma floor, contrast vs a light surface). Text stays in ink.
HUE = "#1f77b4"
INK = "#222222"
MUTED = "#8a8a8a"


def make_comparison_figure(
    summaries: list[FragmentSummary],
    reference: str,
    style: str = "bar",
    title: str | None = None,
    subtitle: str = "",
):
    """Kd per fragment: summary mark, 95% CI, and every replicate.

    ``bar`` (default): linear y axis starting at zero. A bar's length only
    means something against a zero baseline, so bars never go on a log
    axis. Censored fragments get a hollow bar up to the bound plus an
    arrow, so "we only know it's bigger than this" can't be mistaken for
    a measurement.

    ``dot``: log y axis, geometric mean as a short line. Kd is log-normal,
    so when fragments differ by more than ~10× this is the more honest
    view — on a linear axis a 40 nM WT becomes a sliver next to a 2 µM
    mutant and its CI becomes invisible.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch

    by = {s.fragment: s for s in summaries}
    ref = by[reference]
    n = len(summaries)
    log = style == "dot"

    fig, ax = plt.subplots(figsize=(max(3.8, 1.05 * n + 2.2), 5.0))
    fig.subplots_adjust(left=0.2, right=0.96, top=0.86, bottom=0.25)

    # ── y range from everything that will be drawn ──
    ys = []
    for s in summaries:
        if math.isfinite(s.value):
            ys.append(s.value)
        if s.kind == "value":
            ys.extend(v for v in s.ci95 if math.isfinite(v))
        ys.extend(e.value for e in s.estimates if math.isfinite(e.value))
    ys = [y for y in ys if y > 0] or [1.0]
    y_hi_data, y_lo_data = max(ys), min(ys)
    if log:
        ax.set_yscale("log")
        y_top = y_hi_data * 6.0
        ax.set_ylim(y_lo_data / 2.5, y_top)
    else:
        y_top = y_hi_data * 1.42
        ax.set_ylim(0, y_top)

    def above(y: float, frac: float) -> float:
        """A point `frac` of the axis height above y, in either scale."""
        if log:
            lo, hi = ax.get_ylim()
            return y * (hi / lo) ** frac
        return y + frac * y_top

    rng = np.random.default_rng(0)       # deterministic jitter
    any_bound_marker = any(e.kind in ("lower", "upper") for s in summaries for e in s.estimates)
    any_bound_summary = any(s.kind in ("lower", "upper") for s in summaries)

    for i, s in enumerate(summaries):
        # Summary mark.
        if s.kind in ("value", "lower", "upper") and math.isfinite(s.value):
            if log:
                # Measured mean: heavy line. Bound: thin, shorter line — the
                # same distinction the bar style makes with a hollow bar.
                if s.kind == "value":
                    ax.hlines(s.value, i - 0.26, i + 0.26, color=INK, lw=2.2, zorder=4)
                else:
                    ax.hlines(s.value, i - 0.18, i + 0.18, color=INK, lw=1.0, zorder=4)
            elif s.kind == "value":
                ax.bar(i, s.value, width=0.62, color=HUE, alpha=0.28, linewidth=0, zorder=1)
            else:
                ax.bar(i, s.value, width=0.62, fill=False, edgecolor=HUE, linewidth=1.3, zorder=1)

        top = s.value if math.isfinite(s.value) else 0.0
        if s.kind == "value" and all(math.isfinite(v) for v in s.ci95):
            lo, hi = s.ci95
            ax.errorbar(i, s.value, yerr=[[s.value - lo], [hi - s.value]], fmt="none",
                        ecolor=INK, elinewidth=1.2, capsize=5, capthick=1.2, zorder=4)
            top = hi
        elif s.kind == "lower":
            # Start the arrow clear of the replicate triangles sitting at
            # the bound, so it reads as "continues upward", not as a mark.
            tip = above(s.value, 0.11)
            ax.annotate("", xy=(i, tip), xytext=(i, above(s.value, 0.035)),
                        arrowprops=dict(arrowstyle="-|>", color=INK, lw=1.3,
                                        mutation_scale=12), zorder=4)
            top = tip
        elif s.kind == "upper":
            tip = s.value / 2.2 if log else max(s.value - 0.11 * y_top, 0.0)
            start = s.value / 1.15 if log else max(s.value - 0.035 * y_top, 0.0)
            ax.annotate("", xy=(i, tip), xytext=(i, start),
                        arrowprops=dict(arrowstyle="-|>", color=INK, lw=1.3,
                                        mutation_scale=12), zorder=4)

        # Replicates: filled = measured, open triangle = bound only.
        for e in s.estimates:
            if not math.isfinite(e.value):
                continue
            xj = i + float(rng.uniform(-0.14, 0.14))
            if e.kind == "value":
                ax.scatter(xj, e.value, s=42, color=HUE, edgecolor="white",
                           linewidth=1.0, zorder=5)
            else:
                ax.scatter(xj, e.value, s=52, marker="^" if e.kind == "lower" else "v",
                           facecolor="white", edgecolor=HUE, linewidth=1.3, zorder=5)
            top = max(top, e.value)

        # One label per fragment: the value and its direction vs reference.
        fv, fk = fold_change(s, ref)
        ax.text(i, above(top, 0.025), f"{kd_text(s)}\n{fold_phrase(fv, fk)}",
                ha="center", va="bottom", fontsize=8.5, color=INK, linespacing=1.25)

    ax.set_xticks(range(n))
    ax.set_xticklabels([f"{s.fragment}\nn = {s.n}" for s in summaries], fontsize=9.5)
    ax.set_xlim(-0.6, n - 0.4)
    ax.set_ylabel("apparent Kd (nM)\nlower = tighter binding", fontsize=10, color=INK)
    ax.tick_params(axis="y", labelsize=9)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.yaxis.grid(True, color="#e6e6e6", lw=0.8, zorder=0)
    ax.set_axisbelow(True)

    fig.suptitle(title or "Apparent Kd by DNA fragment", fontsize=12, color=INK, y=0.975)
    if subtitle:
        fig.text(0.5, 0.905, subtitle, ha="center", fontsize=8.5, color=MUTED)

    handles = []
    if log:
        handles.append(Line2D([0], [0], color=INK, lw=2.2, label="geometric mean"))
    else:
        handles.append(Patch(facecolor=HUE, alpha=0.28, label="geometric mean"))
    handles.append(Line2D([0], [0], color=INK, lw=1.2, label="95% CI of the mean"))
    handles.append(Line2D([0], [0], marker="o", color="none", markerfacecolor=HUE,
                          markeredgecolor="white", markersize=7.5, label="replicate"))
    if any_bound_marker:
        handles.append(Line2D([0], [0], marker="^", color="none", markerfacecolor="white",
                              markeredgecolor=HUE, markersize=7.5,
                              label="replicate: Kd beyond tested range"))
    if any_bound_summary:
        handles.append(
            Line2D([0], [0], color=INK, lw=1.0, label="bound on the mean, not a measurement")
            if log else
            Patch(fill=False, edgecolor=HUE, linewidth=1.3,
                  label="bound on the mean, not a measurement"))
    fig.legend(handles=handles, loc="lower center", ncol=2, frameon=False,
               fontsize=8, bbox_to_anchor=(0.55, 0.0))
    return fig
