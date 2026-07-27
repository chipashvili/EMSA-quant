"""Text report and publication figure for a fitted fEMSA titration."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from gel_annotator.fit.dataset import Point, Replicate
from gel_annotator.fit.models import FitResult, KdSummary


@dataclass
class MethodFits:
    """Every model fitted to one replicate under one f_bound estimator."""
    rep: Replicate
    method: str                    # "ratio" | "depletion"
    points: list[Point]
    fits: dict[str, FitResult]     # model name -> result


# ── Formatting helpers ────────────────────────────────────────────────


def fmt(v: float, sig: int = 3) -> str:
    if v is None or not math.isfinite(v):
        return "n/a"
    a = abs(v)
    if a != 0 and (a < 1e-3 or a >= 1e5):
        return f"{v:.{sig - 1}e}"
    return f"{v:.{sig}g}"


def fmt_ci(ci: tuple[float, float]) -> str:
    lo, hi = ci
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return "CI n/a"
    return f"[{fmt(lo)}, {fmt(hi)}]"


def _rule(ch: str = "-", n: int = 74) -> str:
    return ch * n


# ── Text report ───────────────────────────────────────────────────────


def build_report(
    method_fits: list[MethodFits],
    summaries: dict[tuple[str, str], KdSummary],
    probe_nm: float,
    warnings: list[str],
    sources: list[Path],
) -> str:
    L: list[str] = []
    add = L.append

    add(_rule("="))
    add("fEMSA apparent-Kd fit")
    add(_rule("="))
    add("")
    add(f"Input:            {', '.join(p.name for p in sources)}")
    add(f"Probe conc (Dt):  {fmt(probe_nm)} nM")
    reps = sorted({mf.rep.name for mf in method_fits})
    add(f"Replicates:       {len(reps)}  ({', '.join(reps)})")
    add("")

    # ── Headline ──
    add(_rule("="))
    add("APPARENT Kd")
    add(_rule("="))
    add("")
    add("Reported as apparent Kd throughout. A gel perturbs the equilibrium it")
    add("measures: complexes with fast off-rates partially dissociate during")
    add("loading and the run, so EMSA affinities skew weak relative to solution")
    add("methods. The number below is the affinity under these gel conditions.")
    add("")

    for (method, model) in sorted(summaries):
        s = summaries[(method, model)]
        if s.n == 0:
            continue
        tag = f"{model} / {method}"
        star = "  <- primary" if (model == "quadratic" and method == "ratio") else ""
        add(f"  {tag:<26} Kd = {fmt(s.geometric_mean):>10} nM   95% CI {fmt_ci(s.ci95)}{star}")
        if s.basis == "across-replicates":
            add(f"  {'':<26} geometric mean of n = {s.n}; "
                f"log10(Kd) = {fmt(s.log10_mean)} +/- {fmt(s.log10_sd)} (SD)")
        else:
            add(f"  {'':<26} {s.basis}")
        if s.note:
            for line in _wrap(s.note, 68):
                add(f"  {'':<26} {line}")
        add("")

    # ── Depletion diagnostic ──
    q = summaries.get(("ratio", "quadratic"))
    h = summaries.get(("ratio", "hyperbolic"))
    if q and h and q.n and h.n and math.isfinite(q.geometric_mean) and math.isfinite(h.geometric_mean) and q.geometric_mean > 0:
        ratio = h.geometric_mean / q.geometric_mean
        add(_rule())
        add("Quadratic vs hyperbolic")
        add(_rule())
        add("")
        add(f"  hyperbolic Kd / quadratic Kd = {fmt(ratio)}x")
        add("")
        for line in _wrap(
            "The hyperbolic model assumes free protein equals total protein. When "
            "Kd is within about 10x of the probe concentration that assumption "
            "fails, the probe measurably depletes the protein, and the hyperbolic "
            "fit returns an inflated, floor-limited Kd. The size of the ratio "
            "above is itself the diagnostic: near 1.0 means depletion is "
            "negligible at this probe concentration; substantially above 1.0 "
            "means the quadratic is doing real work and the hyperbolic number "
            "should not be quoted.", 72):
            add(f"  {line}")
        add("")

    # ── Per-replicate detail ──
    add(_rule("="))
    add("PER-REPLICATE FITS")
    add(_rule("="))
    add("")
    add("Each replicate is fitted independently and the Kd values averaged, per")
    add("spec. Pooling normalized points into one fit would treat replicates as")
    add("extra data and understate the uncertainty.")
    add("")

    for mf in method_fits:
        add(f"  {mf.rep.name}   [{mf.method}]   n = {len(mf.points)} points")
        if mf.rep.has_depletion and mf.method == "depletion":
            add(f"    depletion reference lane at {fmt(mf.rep.reference_conc)} nM protein")
        for model, fit in mf.fits.items():
            if not fit.converged:
                add(f"    {model:<12} {fit.message}")
                continue
            bits = [f"Kd = {fmt(fit.kd)} nM {fmt_ci(fit.ci95.get('kd', (math.nan, math.nan)))}"]
            if "fmax" in fit.params:
                bits.append(f"fmax = {fmt(fit.params['fmax'], 3)}")
            if "n" in fit.params:
                bits.append(f"n = {fmt(fit.params['n'], 3)}")
            bits.append(f"R2 = {fmt(fit.r_squared, 4)}")
            add(f"    {model:<12} " + "   ".join(bits))
        add("")

    # ── Data table ──
    add(_rule("="))
    add("POINTS")
    add(_rule("="))
    add("")
    add(f"  {'replicate':<14}{'lane':>6}{'[P] nM':>12}{'I_free':>14}{'I_bound':>14}"
        f"{'f_ratio':>10}{'f_depl':>10}  flags")
    seen_reps: set[str] = set()
    for mf in method_fits:
        if mf.rep.name in seen_reps:
            continue
        seen_reps.add(mf.rep.name)
        for p in mf.rep.points:
            flags = []
            if p.saturated:
                flags.append("SAT")
            if p.excluded:
                flags.append(f"excl({p.exclude_reason or 'flagged'})")
            add(f"  {mf.rep.name:<14}{p.lane:>6}{fmt(p.conc):>12}"
                f"{fmt(p.i_free, 4):>14}{fmt(p.i_bound, 4):>14}"
                f"{fmt(p.f_ratio, 3):>10}{fmt(p.f_depletion, 3):>10}  {' '.join(flags)}")
    add("")

    # ── Warnings ──
    add(_rule("="))
    add(f"WARNINGS ({len(warnings)})")
    add(_rule("="))
    add("")
    if not warnings:
        add("  None.")
    for w in warnings:
        lines = _wrap(w, 70)
        add(f"  * {lines[0]}")
        for line in lines[1:]:
            add(f"    {line}")
        add("")

    add(_rule("="))
    add("CARRY INTO THE MANUSCRIPT")
    add(_rule("="))
    add("")
    for line in _wrap(
        "Apparent Kd is only as good as the ACTIVE protein concentration. "
        "Misfolded or aggregated protein makes the true Kd tighter than "
        "measured, and no curve fitting corrects for it. Bound it with an A280 "
        "aggregation check and a stoichiometric titration at high DNA, where "
        "the equivalence point reports the active fraction.", 72):
        add(f"  {line}")
    add("")
    for line in _wrap(
        "Pair the affinity with specificity controls on the same footing: the "
        "same titration against a scrambled or point-mutated motif probe, plus "
        "cold competition (specific vs nonspecific competitor) for a Ki. The "
        "mutant-probe Kd alongside the WT Kd is what answers whether the "
        "binding is motif-specific rather than general affinity for "
        "promoter-proximal DNA.", 72):
        add(f"  {line}")
    add("")

    return "\n".join(L) + "\n"


def _wrap(text: str, width: int) -> list[str]:
    import textwrap
    return textwrap.wrap(text, width) or [""]


# ── Warnings ──────────────────────────────────────────────────────────


def collect_warnings(
    method_fits: list[MethodFits],
    summaries: dict[tuple[str, str], KdSummary],
    probe_nm: float,
) -> list[str]:
    w: list[str] = []
    reps = {mf.rep.name: mf.rep for mf in method_fits}

    n_reps = len(reps)
    if n_reps < 3:
        w.append(
            f"Only {n_reps} replicate{'s' if n_reps != 1 else ''}. The spec calls for "
            f"n >= 3 INDEPENDENT protein preps — repeat gels from one prep share the "
            f"prep's error and do not count as replicates. The reported interval "
            f"understates the real uncertainty until that is satisfied."
        )

    sat = [(r.name, p.lane) for r in reps.values() for p in r.points if p.saturated and not p.excluded]
    if sat:
        w.append(
            "Saturated ROIs are included in the fit: "
            + ", ".join(f"{n} lane {l}" for n, l in sat[:12])
            + (f" (+{len(sat) - 12} more)" if len(sat) > 12 else "")
            + ". Saturation in the free-probe band flattens the top of the curve and "
              "inflates Kd. Re-image at a shorter exposure, or use two exposures and "
              "quantify each species from the one in range. Re-run with --drop-saturated "
              "to see how much they are moving the answer."
        )

    # Ratio vs depletion, per replicate.
    for rep in reps.values():
        pairs = [(p.f_ratio, p.f_depletion) for p in rep.points
                 if not p.excluded and math.isfinite(p.f_ratio) and math.isfinite(p.f_depletion)]
        if len(pairs) < 3:
            continue
        diffs = sorted(d - r for r, d in pairs)
        med = diffs[len(diffs) // 2]
        if med > 0.08:
            w.append(
                f"{rep.name}: the depletion estimator exceeds the ratio estimator by a "
                f"median of {med:.2f}. Signal is not conserved — probe is leaving the "
                f"free band without appearing in a bound band. Check the wells on a long "
                f"exposure and look for a smear between the free and shifted positions. "
                f"Where they diverge, the ratio method UNDERESTIMATES binding."
            )
        elif med < -0.08:
            w.append(
                f"{rep.name}: the ratio estimator exceeds the depletion estimator by a "
                f"median of {-med:.2f}. Usually the bound ROI is picking up background or "
                f"a second species, or the reference lane's free band is under-integrated."
            )

    # Systematically negative f_bound at the bottom of the curve is the
    # signature of background OVER-subtraction, which is what you get
    # when the background ROI sits somewhere with more signal than the
    # band's own local background — typically far away, across a gel
    # gradient. It biases Kd weak. This check is geometry-free, so it
    # works on intensities from Fiji or the iBright software too.
    for rep in reps.values():
        low = sorted((p for p in rep.points
                      if not p.excluded and math.isfinite(p.conc) and math.isfinite(p.f_ratio)),
                     key=lambda p: p.conc)[:4]
        neg = [p for p in low if p.f_ratio < -0.01]
        if len(neg) >= 2:
            worst = min(p.f_ratio for p in neg)
            w.append(
                f"{rep.name}: f_bound is negative in {len(neg)} of the "
                f"{len(low)} lowest-protein lanes (down to {worst:.3f}). Fraction bound "
                f"cannot be below zero, so background is being over-subtracted — the "
                f"background ROI is picking up more signal than the band's own local "
                f"background. Almost always means the background box is too far from "
                f"the band, across a gel gradient. Move it alongside the band and "
                f"re-measure; this biases Kd WEAK."
            )

    for rep in reps.values():
        if rep.has_depletion and math.isfinite(rep.reference_conc) and rep.reference_conc > 0:
            w.append(
                f"{rep.name}: no 0 nM protein lane. The depletion estimator is referenced "
                f"to {fmt(rep.reference_conc)} nM, where some probe is already bound, so "
                f"every f_depletion is biased low by that amount."
            )

    prim = summaries.get(("ratio", "quadratic"))
    if prim and prim.n and math.isfinite(prim.geometric_mean):
        kd = prim.geometric_mean
        if probe_nm > 0 and kd < 10 * probe_nm:
            w.append(
                f"Kd ({fmt(kd)} nM) is within 10x of the probe concentration "
                f"({fmt(probe_nm)} nM). This is the ligand-depletion regime: quote the "
                f"quadratic fit, not the hyperbolic one. Lowering the probe concentration "
                f"would tighten the determination, at the cost of signal."
            )
        # Extrapolation check.
        all_conc = [p.conc for r in reps.values() for p in r.points
                    if not p.excluded and math.isfinite(p.conc) and p.conc > 0]
        if all_conc:
            lo, hi = min(all_conc), max(all_conc)
            if kd < lo:
                w.append(
                    f"Kd ({fmt(kd)} nM) is BELOW the lowest protein concentration titrated "
                    f"({fmt(lo)} nM). The curve's rising phase was never sampled, so Kd is "
                    f"extrapolated and effectively an upper bound. Add lower-concentration "
                    f"points."
                )
            elif kd > hi:
                w.append(
                    f"Kd ({fmt(kd)} nM) is ABOVE the highest protein concentration titrated "
                    f"({fmt(hi)} nM). The plateau was never reached, so Kd and fmax trade "
                    f"off against each other and neither is well determined. Add "
                    f"higher-concentration points."
                )

    # fmax well below 1.
    for mf in method_fits:
        f = mf.fits.get("quadratic")
        if f and f.converged and "fmax" in f.params and f.params["fmax"] < 0.7:
            w.append(
                f"{mf.rep.name} [{mf.method}]: fitted fmax = {fmt(f.params['fmax'], 3)}, well "
                f"below 1. Part of the probe never shifts. Usual causes are inactive or "
                f"aggregated protein, damaged or partially unlabelled probe, or a bound "
                f"ROI that is missing part of the complex."
            )

    # Hill coefficient.
    for mf in method_fits:
        f = mf.fits.get("hill")
        if f and f.converged and "n" in f.params:
            nh = f.params["n"]
            lo, hi = f.ci95.get("n", (math.nan, math.nan))
            if math.isfinite(lo) and lo > 1.15:
                w.append(
                    f"{mf.rep.name} [{mf.method}]: Hill n = {fmt(nh, 3)} {fmt_ci((lo, hi))}, "
                    f"significantly above 1. Interpret cautiously — apparent cooperativity "
                    f"on a gel can come from multiple motif matches on the fragment (the "
                    f"150 bp probe may carry more than one), from oligomerisation, or from "
                    f"non-equilibrium effects during the run. It is a description of curve "
                    f"shape, not evidence of a mechanism."
                )

    for mf in method_fits:
        for model, f in mf.fits.items():
            if not f.converged:
                w.append(f"{mf.rep.name} [{mf.method}] {model}: {f.message}")

    return w


# ── Figure ────────────────────────────────────────────────────────────


def make_figure(
    method_fits: list[MethodFits],
    summaries: dict[tuple[str, str], KdSummary],
    probe_nm: float,
    primary_model: str = "quadratic",
    show_depletion: bool = True,
):
    """Binding curve + residuals. Protein on a log axis, per the spec."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ratio_fits = [mf for mf in method_fits if mf.method == "ratio"]
    depl_fits = [mf for mf in method_fits if mf.method == "depletion"]
    if not ratio_fits:
        ratio_fits = method_fits

    fig, (ax, axr) = plt.subplots(
        2, 1, figsize=(6.2, 6.0), sharex=True,
        gridspec_kw={"height_ratios": [3, 1], "hspace": 0.08},
    )
    # Margins are set explicitly rather than via tight_layout, which
    # cannot handle the shared-x + custom-hspace pair and emits a warning
    # while producing a slightly wrong result.
    fig.subplots_adjust(left=0.13, right=0.97, top=0.93, bottom=0.10)

    palette = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    markers = ["o", "s", "^", "D", "v", "P", "X", "*"]

    # A log x-axis cannot show a 0 nM control. Rather than drop the most
    # informative point in the series, place it at a tenth of the lowest
    # real concentration, mark the gap with a break, and label the tick
    # "0" so the figure is honest about what was done.
    pos = [p.conc for mf in ratio_fits for p in mf.points if p.conc > 0]
    if not pos:
        pos = [1.0]
    xmin_real = min(pos)
    xmax_real = max(p.conc for mf in ratio_fits for p in mf.points) or xmin_real * 10
    x_zero = xmin_real / 10.0
    has_zero = any(p.conc == 0 for mf in ratio_fits for p in mf.points)

    def xpos(c: float) -> float:
        return x_zero if c == 0 else c

    for i, mf in enumerate(ratio_fits):
        color = palette[i % len(palette)]
        marker = markers[i % len(markers)]
        xs = [xpos(p.conc) for p in mf.points]
        ys = [p.f_ratio for p in mf.points]
        ax.plot(xs, ys, marker, color=color, ms=5.5, mew=0, alpha=0.9,
                label=f"{mf.rep.name}", zorder=3, linestyle="none")
        sat_x = [xpos(p.conc) for p in mf.points if p.saturated]
        sat_y = [p.f_ratio for p in mf.points if p.saturated]
        if sat_x:
            ax.plot(sat_x, sat_y, marker, mfc="none", mec="#c0392b", mew=1.6,
                    ms=10, linestyle="none", zorder=4)

        fit = mf.fits.get(primary_model)
        if fit and fit.converged:
            grid = np.logspace(np.log10(x_zero), np.log10(xmax_real * 1.6), 400)
            ax.plot(grid, fit.predict(grid), "-", color=color, lw=1.0, alpha=0.55, zorder=2)
            resid_x = [xpos(p.conc) for p in mf.points]
            axr.plot(resid_x, fit.residuals, marker, color=color, ms=4.5, mew=0,
                     linestyle="none")

    if show_depletion:
        for i, mf in enumerate(depl_fits):
            color = palette[i % len(palette)]
            marker = markers[i % len(markers)]
            xs = [xpos(p.conc) for p in mf.points]
            ys = [p.f_depletion for p in mf.points]
            ax.plot(xs, ys, marker, mfc="none", mec=color, mew=1.1, ms=5.5,
                    alpha=0.75, linestyle="none", zorder=3)
        if depl_fits:
            ax.plot([], [], "o", mfc="none", mec="0.35", mew=1.1, ms=5.5,
                    linestyle="none", label="open = depletion")

    # Consensus curve from the across-replicate geometric-mean Kd.
    s = summaries.get(("ratio", primary_model))
    if s and s.n and math.isfinite(s.geometric_mean):
        fmaxes = [mf.fits[primary_model].params.get("fmax", 1.0)
                  for mf in ratio_fits
                  if primary_model in mf.fits and mf.fits[primary_model].converged]
        fmax = float(np.mean(fmaxes)) if fmaxes else 1.0
        grid = np.logspace(np.log10(x_zero), np.log10(xmax_real * 1.6), 400)
        from gel_annotator.fit.models import hyperbolic as _hyp, quadratic as _quad
        curve = (_quad(grid, s.geometric_mean, fmax, probe_nm) if primary_model == "quadratic"
                 else _hyp(grid, s.geometric_mean, fmax))
        ax.plot(grid, curve, "-", color="0.15", lw=2.0, zorder=5,
                label=f"{primary_model}: Kd = {fmt(s.geometric_mean)} nM")
        ax.axvline(s.geometric_mean, color="0.15", lw=0.8, ls=":", alpha=0.6, zorder=1)

    if has_zero:
        # Break marker between the pseudo-zero position and the real axis.
        gap = math.sqrt(x_zero * xmin_real)
        for a in (ax, axr):
            a.axvline(gap, color="0.75", lw=0.9, ls=(0, (2, 3)), zorder=0)

    ax.set_xscale("log")
    ax.set_ylabel("fraction bound")
    ax.set_ylim(-0.06, 1.08)
    ax.axhline(0, color="0.8", lw=0.8, zorder=0)
    ax.axhline(1, color="0.8", lw=0.8, zorder=0)
    ax.legend(fontsize=8, frameon=False, loc="upper left")
    ax.set_title(f"fEMSA titration — apparent Kd  (Dt = {fmt(probe_nm)} nM probe)", fontsize=10)

    axr.axhline(0, color="0.4", lw=0.9)
    axr.set_ylabel("resid.", fontsize=9)
    axr.set_xlabel("[protein], nM  (log scale)")
    axr.tick_params(labelsize=8)

    if has_zero:
        ticks = [t for t in ax.get_xticks() if t > xmin_real / 2]
        ax.set_xticks([x_zero] + list(ticks))
        ax.set_xticklabels(["0"] + [f"{t:g}" for t in ticks])
    ax.set_xlim(x_zero / 1.8, xmax_real * 1.8)

    for a in (ax, axr):
        a.spines["top"].set_visible(False)
        a.spines["right"].set_visible(False)

    return fig
