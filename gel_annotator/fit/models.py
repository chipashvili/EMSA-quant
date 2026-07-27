"""Equilibrium binding models and the machinery to fit them.

Deliberately independent of everything else in the package: nothing here
imports the server, the annotator, or any notion of a gel. The input is
(protein concentration, fraction bound) and the output is a Kd. That
separation is the point — the same fitter has to work on intensities
extracted in Fiji, in the iBright software, or in this app.

Concentration units are whatever the caller supplies, consistently. The
app exports nM, so Kd comes back in nM.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np


# ── Model functions ───────────────────────────────────────────────────


def quadratic(pt: np.ndarray, kd: float, fmax: float, dt: float) -> np.ndarray:
    """Exact 1:1 binding — the default, and the one to trust.

        P + D ⇌ PD,  Kd = [P][D]/[PD]

    Solving the mass-balance quadratic for [PD] and dividing by total
    probe gives

        f = fmax · [ (Kd+Pt+Dt) − √((Kd+Pt+Dt)² − 4·Pt·Dt) ] / (2·Dt)

    which is what the spec writes. This function evaluates the
    algebraically identical but numerically stable rearrangement

        f = fmax · 2·Pt / [ (Kd+Pt+Dt) + √((Kd+Pt+Dt)² − 4·Pt·Dt) ]

    obtained by multiplying through by the conjugate.

    Why bother: the textbook form subtracts two nearly equal large
    numbers once Kd ≫ Dt, and loses relative precision in proportion.
    Measured against an exact decimal reference at Dt = 8, Pt = 100 nM,
    the naive form holds ~15 significant digits at Kd = 100 nM, ~11 at
    10 µM, ~5 at 10 mM, and NONE at Kd = 1e12. The stable form holds ~16
    everywhere.

    At any Kd this assay could plausibly return, the naive form would be
    perfectly adequate. The reason it is not used is the FIT, not the
    final answer: curve_fit's Kd upper bound here is 1e12, and on a
    titration that never reaches its plateau the optimizer really does
    wander into that range while searching. There the naive form returns
    numerical noise, the objective stops being smooth, and the fit either
    stalls or converges somewhere arbitrary. The conjugate form adds
    instead of subtracting and costs nothing.

    Unlike the hyperbolic model this one accounts for ligand depletion:
    probe consumed by the complex is no longer free to buffer the
    protein. That matters exactly when Kd approaches Dt, which at an
    8 nM probe concentration is the whole low-nM regime.
    """
    pt = np.asarray(pt, dtype=np.float64)
    s = kd + pt + dt
    disc = np.maximum(s * s - 4.0 * pt * dt, 0.0)
    denom = s + np.sqrt(disc)
    # denom == 0 only when Kd = Pt = Dt = 0, which the bounds exclude;
    # guard anyway so a pathological start point can't emit a warning.
    return fmax * np.divide(2.0 * pt, denom, out=np.zeros_like(pt), where=denom > 0)


def hyperbolic(pt: np.ndarray, kd: float, fmax: float) -> np.ndarray:
    """Langmuir isotherm — assumes free protein ≈ total protein.

    Valid only when the protein is in genuine excess over the probe. It
    is fitted here for comparison, never as the headline number: the gap
    between this Kd and the quadratic Kd is the diagnostic for whether
    depletion is distorting the experiment.
    """
    pt = np.asarray(pt, dtype=np.float64)
    return fmax * pt / (kd + pt)


def hill(pt: np.ndarray, kd: float, fmax: float, n: float) -> np.ndarray:
    """Hill equation — an empirical steepness parameter, not a mechanism.

    A gel can produce apparent cooperativity from several unrelated
    causes: more than one binding motif on the fragment, protein
    oligomerisation, or simply non-equilibrium effects during the run. An
    n > 1 from an EMSA is a description of curve shape and should be
    reported as such.
    """
    pt = np.asarray(pt, dtype=np.float64)
    num = np.power(pt, n)
    return fmax * num / (np.power(kd, n) + num)


# ── Fit result ────────────────────────────────────────────────────────


@dataclass
class FitResult:
    """One model fitted to one replicate's points."""
    model: str                       # "quadratic" | "hyperbolic" | "hill"
    params: dict[str, float]
    stderr: dict[str, float]
    ci95: dict[str, tuple[float, float]]
    n_points: int
    dof: int
    rss: float
    r_squared: float
    residuals: np.ndarray = field(repr=False)
    predict: Callable[[np.ndarray], np.ndarray] = field(repr=False)
    converged: bool = True
    message: str = ""

    @property
    def kd(self) -> float:
        return self.params.get("kd", float("nan"))


def _t_crit(dof: int) -> float:
    """Two-sided 95% critical value. Falls back to the normal value when
    scipy's stats module is unavailable or dof is degenerate."""
    if dof <= 0:
        return float("nan")
    try:
        from scipy import stats
        return float(stats.t.ppf(0.975, dof))
    except Exception:
        return 1.959963984540054


def fit_model(
    pt: np.ndarray,
    f: np.ndarray,
    model: str,
    dt: float,
    fmax_fixed: float | None = None,
) -> FitResult:
    """Fit one model by unweighted nonlinear least squares.

    Concentrations are used UNTRANSFORMED, per the spec — fitting against
    log(Pt) silently reweights the low-concentration points and shifts
    Kd. The log axis belongs on the plot, not in the objective.

    ``fmax_fixed`` pins the plateau instead of letting it float. Leave it
    None unless there is a specific reason: an fmax that floats well
    below 1 is a useful signal that some of the protein is inactive or
    some of the probe is damaged, and constraining it away hides that.
    """
    from scipy.optimize import curve_fit

    pt = np.asarray(pt, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    n = pt.size

    pos = pt[pt > 0]
    kd0 = float(np.median(pos)) if pos.size else 1.0
    fmax0 = float(np.clip(np.nanmax(f) if n else 1.0, 0.05, 1.2))

    float_fmax = fmax_fixed is None

    if model == "quadratic":
        names = ["kd", "fmax"] if float_fmax else ["kd"]
        if float_fmax:
            def fn(x, kd, fmax): return quadratic(x, kd, fmax, dt)
            p0, lo, hi = [kd0, fmax0], [1e-9, 0.01], [1e12, 1.5]
        else:
            def fn(x, kd): return quadratic(x, kd, fmax_fixed, dt)
            p0, lo, hi = [kd0], [1e-9], [1e12]
    elif model == "hyperbolic":
        names = ["kd", "fmax"] if float_fmax else ["kd"]
        if float_fmax:
            def fn(x, kd, fmax): return hyperbolic(x, kd, fmax)
            p0, lo, hi = [kd0, fmax0], [1e-9, 0.01], [1e12, 1.5]
        else:
            def fn(x, kd): return hyperbolic(x, kd, fmax_fixed)
            p0, lo, hi = [kd0], [1e-9], [1e12]
    elif model == "hill":
        names = ["kd", "fmax", "n"] if float_fmax else ["kd", "n"]
        if float_fmax:
            def fn(x, kd, fmax, nh): return hill(x, kd, fmax, nh)
            p0, lo, hi = [kd0, fmax0, 1.0], [1e-9, 0.01, 0.2], [1e12, 1.5, 6.0]
        else:
            def fn(x, kd, nh): return hill(x, kd, fmax_fixed, nh)
            p0, lo, hi = [kd0, 1.0], [1e-9, 0.2], [1e12, 6.0]
    else:
        raise ValueError(f"Unknown model: {model!r}")

    dof = n - len(names)
    if dof < 1:
        return FitResult(
            model=model, params={}, stderr={}, ci95={}, n_points=n, dof=dof,
            rss=float("nan"), r_squared=float("nan"), residuals=np.array([]),
            predict=lambda x: np.full(np.shape(x), np.nan),
            converged=False,
            message=f"{n} points is too few for {len(names)} free parameters.",
        )

    try:
        popt, pcov = curve_fit(
            fn, pt, f, p0=p0, bounds=(lo, hi), maxfev=100_000,
        )
    except Exception as exc:
        return FitResult(
            model=model, params={}, stderr={}, ci95={}, n_points=n, dof=dof,
            rss=float("nan"), r_squared=float("nan"), residuals=np.array([]),
            predict=lambda x: np.full(np.shape(x), np.nan),
            converged=False, message=f"Fit did not converge: {exc}",
        )

    pred = fn(pt, *popt)
    resid = f - pred
    rss = float(np.sum(resid ** 2))
    tss = float(np.sum((f - np.mean(f)) ** 2))
    r2 = 1.0 - rss / tss if tss > 0 else float("nan")

    with np.errstate(invalid="ignore"):
        se = np.sqrt(np.diag(pcov))
    tc = _t_crit(dof)

    params = dict(zip(names, (float(v) for v in popt)))
    stderr = dict(zip(names, (float(v) for v in se)))
    if not float_fmax:
        params["fmax"] = float(fmax_fixed)
        stderr["fmax"] = 0.0

    ci: dict[str, tuple[float, float]] = {}
    for name in names:
        v, s = params[name], stderr[name]
        if not np.isfinite(s):
            ci[name] = (float("nan"), float("nan"))
        elif name == "kd" and v > 0:
            # Kd is bounded below by zero and log-normally distributed, so
            # a symmetric Wald interval can run negative on a loose fit.
            # Build the interval on log(Kd) and exponentiate: the result
            # is always positive and multiplicatively symmetric, which is
            # also how the across-replicate summary is computed.
            rel = s / v
            ci[name] = (v * float(np.exp(-tc * rel)), v * float(np.exp(tc * rel)))
        else:
            ci[name] = (v - tc * s, v + tc * s)
    if not float_fmax:
        ci["fmax"] = (float(fmax_fixed), float(fmax_fixed))

    return FitResult(
        model=model, params=params, stderr=stderr, ci95=ci,
        n_points=n, dof=dof, rss=rss, r_squared=r2, residuals=resid,
        predict=lambda x, _f=fn, _p=popt: _f(np.asarray(x, dtype=np.float64), *_p),
        converged=True,
    )


# ── Across-replicate summary ──────────────────────────────────────────


@dataclass
class KdSummary:
    n: int
    geometric_mean: float
    ci95: tuple[float, float]
    log10_mean: float
    log10_sd: float
    values: list[float]
    basis: str          # "across-replicates" | "single-fit" | "none"
    note: str = ""


def summarize_kd(kds: list[float], single_fit_ci: tuple[float, float] | None = None) -> KdSummary:
    """Combine per-replicate Kd values.

    Kd is a ratio of rate constants and is log-normally distributed, so
    the average of several replicates is a GEOMETRIC mean and the spread
    is computed on log(Kd). Averaging Kd values arithmetically lets one
    weak replicate dominate.

    Per the spec, each replicate is fitted independently and the Kd
    values averaged — not all points pooled into a single fit, which
    would treat replicates as extra data and understate uncertainty.
    """
    vals = [float(k) for k in kds if np.isfinite(k) and k > 0]
    n = len(vals)
    if n == 0:
        return KdSummary(0, float("nan"), (float("nan"), float("nan")),
                         float("nan"), float("nan"), [], "none",
                         "No replicate produced a usable Kd.")
    logs = np.log(vals)
    gm = float(np.exp(logs.mean()))
    log10 = np.log10(vals)

    if n == 1:
        ci = single_fit_ci if single_fit_ci else (float("nan"), float("nan"))
        return KdSummary(
            1, gm, ci, float(log10.mean()), float("nan"), vals, "single-fit",
            "One replicate only. The interval shown is the curve-fit "
            "confidence interval for this one gel, which describes how well "
            "the curve is determined — not how reproducible the Kd is. "
            "The spec calls for n ≥ 3 independent protein preps.",
        )

    sd = float(logs.std(ddof=1))
    sem = sd / np.sqrt(n)
    tc = _t_crit(n - 1)
    return KdSummary(
        n, gm, (gm * float(np.exp(-tc * sem)), gm * float(np.exp(tc * sem))),
        float(log10.mean()), float(log10.std(ddof=1)), vals, "across-replicates",
        "" if n >= 3 else "Fewer than 3 independent replicates; the interval is wide and fragile.",
    )
