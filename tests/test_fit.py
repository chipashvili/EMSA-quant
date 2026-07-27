"""Binding models, CSV ingestion, and the across-replicate summary."""

from __future__ import annotations

import csv
import math
from decimal import Decimal, getcontext
from pathlib import Path

import numpy as np
import pytest

from gel_annotator.fit import dataset, models
from tests.conftest import CONCS, DT, TRUE_KD, true_f_bound


# ── Models ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kd", [1e-3, 1.0, 1e3, 1e6, 1e9, 1e12])
def test_quadratic_well_behaved_everywhere(kd):
    """curve_fit is allowed to explore Kd up to 1e12 while searching, so
    the model has to stay finite, bounded and monotone out there — not
    just at plausible affinities."""
    pt = np.array([0.0, 1e-3, 1.0, 1e3, 1e6, 1e9])
    v = models.quadratic(pt, kd, 1.0, DT)
    assert np.all(np.isfinite(v))
    assert np.all(v >= -1e-12) and np.all(v <= 1.0 + 1e-9)
    assert np.all(np.diff(v) >= -1e-12)


@pytest.mark.parametrize("kd", [1.0, 1e3, 1e6, 1e9])
def test_quadratic_matches_exact_arithmetic(kd):
    """The stable rearrangement must agree with the textbook formula
    evaluated in 60-digit decimal, including out where float64
    subtraction of two nearly equal large numbers falls apart.

    Textbook form:  f = [S - sqrt(S^2 - 4*Pt*Dt)] / (2*Dt),  S = Kd+Pt+Dt
    """
    getcontext().prec = 60
    dt, pt = Decimal(DT), Decimal(100)
    s = Decimal(kd) + pt + dt
    exact = (s - (s * s - 4 * pt * dt).sqrt()) / (2 * dt)
    got = float(models.quadratic(np.array([float(pt)]), kd, 1.0, DT)[0])
    assert got == pytest.approx(float(exact), rel=1e-12)


def test_quadratic_reduces_to_hyperbolic_in_protein_excess():
    pt = np.array([1e4, 1e5, 1e6])
    assert models.quadratic(pt, 50.0, 1.0, DT) == pytest.approx(
        models.hyperbolic(pt, 50.0, 1.0), rel=1e-4)


def test_quadratic_and_hyperbolic_diverge_under_depletion():
    """At Kd near Dt the two models must NOT agree — that gap is the
    diagnostic the report leans on."""
    pt = np.array([1.0, 4.0, 8.0, 16.0])
    q = models.quadratic(pt, 8.0, 1.0, DT)
    h = models.hyperbolic(pt, 8.0, 1.0)
    assert np.all(q < h), "depletion must lower fraction bound relative to Langmuir"
    assert np.max(h - q) > 0.05


def test_fit_recovers_known_parameters():
    ys = np.array([true_f_bound(c) for c in CONCS])
    f = models.fit_model(np.array(CONCS, float), ys, "quadratic", dt=DT)
    assert f.converged
    assert f.kd == pytest.approx(TRUE_KD, rel=1e-3)
    assert f.params["fmax"] == pytest.approx(0.92, rel=1e-3)
    assert f.r_squared > 0.9999


def test_floating_fmax_beats_pinning_it():
    """fmax floats by default because pinning it to 1 on a titration that
    plateaus lower forces the error into Kd."""
    ys = np.array([true_f_bound(c, fmax=0.75) for c in CONCS])
    xs = np.array(CONCS, float)
    free = models.fit_model(xs, ys, "quadratic", dt=DT)
    pinned = models.fit_model(xs, ys, "quadratic", dt=DT, fmax_fixed=1.0)
    assert free.params["fmax"] == pytest.approx(0.75, abs=0.01)
    assert free.kd == pytest.approx(TRUE_KD, rel=0.02)
    assert pinned.kd > free.kd * 2


def test_kd_confidence_interval_is_positive_and_multiplicative():
    rng = np.random.default_rng(1)
    ys = np.array([true_f_bound(c) for c in CONCS]) + rng.normal(0, 0.05, len(CONCS))
    f = models.fit_model(np.array(CONCS, float), ys, "quadratic", dt=DT)
    lo, hi = f.ci95["kd"]
    assert 0 < lo < f.kd < hi, "a log-scale interval can never run negative"
    assert (f.kd / lo) == pytest.approx(hi / f.kd, rel=1e-6)


def test_too_few_points_reports_rather_than_raises():
    f = models.fit_model([1.0, 2.0], [0.1, 0.2], "quadratic", dt=DT)
    assert not f.converged and "too few" in f.message


# ── Summary ───────────────────────────────────────────────────────────


def test_summary_is_geometric_not_arithmetic():
    s = models.summarize_kd([10.0, 100.0])
    assert s.geometric_mean == pytest.approx(math.sqrt(1000.0))
    assert s.geometric_mean < (10.0 + 100.0) / 2


def test_single_replicate_is_labelled_as_such():
    s = models.summarize_kd([15.0], single_fit_ci=(12.0, 19.0))
    assert s.n == 1 and s.basis == "single-fit" and s.ci95 == (12.0, 19.0)
    assert "n ≥ 3" in s.note


def test_three_replicates_use_the_t_interval():
    s = models.summarize_kd([12.0, 15.0, 18.0])
    assert s.n == 3 and s.basis == "across-replicates"
    assert s.ci95[0] < s.geometric_mean < s.ci95[1]
    assert s.note == ""


def test_no_usable_kd():
    s = models.summarize_kd([float("nan"), -1.0])
    assert s.n == 0 and s.basis == "none"


# ── CSV ingestion ─────────────────────────────────────────────────────


def _write(path: Path, header, rows):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)
    return path


def test_roi_form_with_multiple_replicates(tmp_path):
    rows = []
    for rep, kd in [("A", 12.0), ("B", 18.0), ("C", 15.0)]:
        for i, c in enumerate(CONCS):
            f = true_f_bound(c, kd=kd)
            rows.append([rep, i + 1, c, 8.0, "free", 1e7 * (1 - f), 0, 0])
            rows.append([rep, i + 1, c, 8.0, "bound", 1e7 * f, 0, 0])
    p = _write(tmp_path / "m.csv",
               ["replicate", "lane", "protein_conc_nM", "probe_nM", "species",
                "integrated_intensity", "bg_intensity", "saturated"], rows)
    reps = dataset.load_all([p], 8.0)
    assert sorted(r.name for r in reps) == ["A", "B", "C"]
    for rep, want in zip(sorted(reps, key=lambda r: r.name), [12.0, 18.0, 15.0]):
        pts = rep.usable("ratio")
        fit = models.fit_model([q.conc for q in pts], [q.f_ratio for q in pts],
                               "quadratic", dt=8.0)
        assert fit.kd == pytest.approx(want, rel=1e-3)


def test_multiple_bound_rows_are_summed(tmp_path):
    """Supershifts: two bound species must roll into one bound population."""
    rows = []
    for i, c in enumerate(CONCS):
        f = true_f_bound(c)
        rows.append([i + 1, c, "free", 1e7 * (1 - f)])
        rows.append([i + 1, c, "bound", 1e7 * f * 0.6])
        rows.append([i + 1, c, "bound", 1e7 * f * 0.4])
    p = _write(tmp_path / "ss.csv",
               ["lane", "protein_conc_nM", "species", "integrated_intensity"], rows)
    rep = dataset.load_all([p], 8.0)[0]
    for pt, c in zip(rep.points, CONCS):
        assert pt.f_ratio == pytest.approx(true_f_bound(c), abs=1e-9)


def test_wide_and_fraction_forms(tmp_path):
    """The fitter has to work on intensities from Fiji or the iBright
    software, not only on this app's export."""
    wide = _write(tmp_path / "w.csv", ["Lane", "Protein (nM)", "Free", "Bound"],
                  [[i + 1, c, 1e7 * (1 - true_f_bound(c)), 1e7 * true_f_bound(c)]
                   for i, c in enumerate(CONCS)])
    frac = _write(tmp_path / "f.csv", ["lane", "protein_conc_nM", "f_bound"],
                  [[i + 1, c, true_f_bound(c)] for i, c in enumerate(CONCS)])
    for p, expect_depl in [(wide, True), (frac, False)]:
        rep = dataset.load_all([p], 8.0)[0]
        pts = rep.usable("ratio")
        fit = models.fit_model([q.conc for q in pts], [q.f_ratio for q in pts],
                               "quadratic", dt=8.0)
        assert fit.kd == pytest.approx(TRUE_KD, rel=1e-3)
        assert rep.has_depletion is expect_depl


def test_messy_headers_and_values(tmp_path):
    p = _write(tmp_path / "messy.csv",
               ["Lane #", "[Protein] nM", "Species", "Raw IntDen"],
               [[1, "0", "Free probe", "1,000,000"],
                [1, "0", "Shifted", "0"],
                [2, "1,000 nM", "free", "100000"],
                [2, "1,000 nM", "bound", "900000"]])
    rep = dataset.load_all([p], 8.0)[0]
    assert [pt.conc for pt in rep.points] == [0.0, 1000.0]
    assert rep.points[0].f_ratio == pytest.approx(0.0)
    assert rep.points[1].f_ratio == pytest.approx(0.9)


def test_blank_concentration_excludes_rather_than_zeroes(tmp_path):
    """A blank cell and a real 0 nM control are different things; treating
    a blank as zero would anchor the curve at a fictitious origin."""
    p = _write(tmp_path / "b.csv",
               ["lane", "protein_conc_nM", "species", "integrated_intensity"],
               [[1, "", "free", 100], [1, "", "bound", 0],
                [2, "10", "free", 50], [2, "10", "bound", 50]])
    rep = dataset.load_all([p], 8.0)[0]
    assert math.isnan(rep.points[0].conc)
    assert [pt.lane for pt in rep.usable("ratio")] == ["2"]


def test_missing_concentration_column_is_a_clear_error(tmp_path):
    p = _write(tmp_path / "bad.csv", ["lane", "species", "intensity"], [[1, "free", 10]])
    with pytest.raises(ValueError, match="protein-concentration column"):
        dataset.load_all([p], 8.0)


def test_depletion_uses_lowest_concentration_lane(tmp_path):
    rows = []
    for i, c in enumerate(CONCS):
        f = true_f_bound(c)
        rows.append([i + 1, c, "free", 1e7 * (1 - f)])
        rows.append([i + 1, c, "bound", 1e7 * f])
    p = _write(tmp_path / "d.csv",
               ["lane", "protein_conc_nM", "species", "integrated_intensity"], rows)
    rep = dataset.load_all([p], 8.0)[0]
    assert rep.has_depletion and rep.reference_conc == 0.0
    # With signal perfectly conserved the two estimators must agree.
    for pt in rep.points:
        assert pt.f_depletion == pytest.approx(pt.f_ratio, abs=1e-9)
