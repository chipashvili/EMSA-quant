"""Comparing apparent Kd across DNA fragments."""

from __future__ import annotations

import csv
import math
from pathlib import Path

import numpy as np
import pytest

from gel_annotator.fit import cli, compare, dataset, models
from tests.conftest import true_f_bound

CONCS = [0, 1, 2, 4, 8, 16, 31, 63, 125, 250]      # a typical 2-fold titration series


def _fit(kd: float, fmax: float = 1.0, noise: float = 0.0, seed: int = 0):
    rng = np.random.default_rng(seed)
    fs = [true_f_bound(c, kd=kd, fmax=fmax) + rng.normal(0, noise) for c in CONCS]
    return models.fit_model(CONCS, fs, "quadratic", dt=8.0), fs


# ── Classification ────────────────────────────────────────────────────


def test_well_sampled_titration_is_a_value():
    fit, fs = _fit(45.0)
    e = compare.classify_kd(fit, CONCS, fs, "r1")
    assert e.kind == "value" and e.value == pytest.approx(45.0, rel=1e-3)


def test_never_half_saturated_is_a_lower_bound_at_top_concentration():
    """A shuffled motif that only reaches f = 0.2 by 250 nM does not
    determine a Kd. Whatever the fit returns, the honest statement is
    'Kd > 250 nM'."""
    fit, fs = _fit(900.0)
    assert max(fs) < 0.5
    e = compare.classify_kd(fit, CONCS, fs, "r1")
    assert e.kind == "lower" and e.value == 250
    assert "half-saturation" in e.reason


def test_low_plateau_trap_does_not_yield_a_tight_kd():
    """The failure this module exists to prevent. With fmax floating, a
    weak binder that creeps up to f ~ 0.3 can be fit as 'saturates early
    at a low plateau' — a SMALL Kd that makes the mutant look like WT.
    The raw fit must be allowed to say that; the classification must
    refuse to report it."""
    fs = [0.0, 0.01, 0.03, 0.06, 0.11, 0.18, 0.24, 0.28, 0.30, 0.31]
    fit = models.fit_model(CONCS, fs, "quadratic", dt=8.0)
    assert fit.converged and fit.kd < 100 and fit.params["fmax"] < 0.5   # the trap
    e = compare.classify_kd(fit, CONCS, fs)
    assert e.kind == "lower" and e.value == 250


def _fake_fit(kd: float) -> models.FitResult:
    return models.FitResult(
        model="quadratic", params={"kd": kd, "fmax": 1.5}, stderr={},
        ci95={"kd": (kd / 3, kd * 3)}, n_points=len(CONCS), dof=len(CONCS) - 2,
        rss=0.0, r_squared=0.99, residuals=np.zeros(len(CONCS)), predict=lambda x: x,
    )


def test_kd_beyond_range_is_a_lower_bound_even_past_half():
    """Crossing f = 0.5 at the top point is not enough: if the fit still
    puts Kd above the highest concentration, the plateau was never
    sampled and the value is extrapolated."""
    fs = [true_f_bound(c, kd=230.0, fmax=1.0) for c in CONCS]
    assert max(fs) >= 0.5
    e = compare.classify_kd(_fake_fit(400.0), CONCS, fs)
    assert e.kind == "lower" and e.value == 250 and "extrapolated" in e.reason


def test_realistic_plateau_just_under_half_is_still_a_measurement():
    """Not every probe molecule shifts; a plateau of ~0.9 is normal. A
    fragment with Kd = 200 nM titrated to 250 nM then tops out just under
    f = 0.5. Calling that 'Kd > 250 nM' would be a false statement in the
    figure — the fit sees a normal plateau and a Kd inside the range, and
    that is what must be reported."""
    fs = [true_f_bound(c, kd=200.0, fmax=0.90) for c in CONCS]
    assert 0.35 < max(fs) < 0.5
    fit = models.fit_model(CONCS, fs, "quadratic", dt=8.0)
    e = compare.classify_kd(fit, CONCS, fs)
    assert e.kind == "value" and e.value == pytest.approx(200.0, rel=0.02)


def test_kd_below_range_is_an_upper_bound():
    fs = [0.0] + [0.99] * (len(CONCS) - 1)
    fit = models.fit_model(CONCS, fs, "hyperbolic", dt=8.0)
    e = compare.classify_kd(fit, CONCS, fs)
    assert e.kind == "upper" and e.value == 1


def test_failed_fit_is_none():
    bad = models.fit_model([1, 2], [0.1, 0.2], "quadratic", dt=8.0)
    assert compare.classify_kd(bad, [1, 2], [0.1, 0.2]).kind == "none"
    assert compare.classify_kd(None, CONCS, [0.0] * 10).kind == "none"


# ── Summaries ─────────────────────────────────────────────────────────


def _est(kind, v, rep="r"):
    return compare.KdEstimate(rep, kind, v, (v * 0.8, v * 1.25) if kind == "value" else (math.nan, math.nan))


def test_all_determined_matches_the_per_fragment_statistic():
    ests = [_est("value", v) for v in (40.0, 45.0, 52.0)]
    s = compare.summarize_fragment("WT", ests)
    ref = models.summarize_kd([40.0, 45.0, 52.0])
    assert s.kind == "value"
    assert s.value == pytest.approx(ref.geometric_mean)
    assert s.ci95 == pytest.approx(ref.ci95)


def test_censored_summary_is_a_valid_bound_on_the_geometric_mean():
    """Substituting each censored replicate's bound for its unknown value
    must give a number the true geometric mean can only exceed."""
    true_values = [180.0, 900.0, 4000.0]
    ests = [_est("value", 180.0), _est("lower", 250.0), _est("lower", 250.0)]
    s = compare.summarize_fragment("m", ests)
    true_gm = float(np.exp(np.mean(np.log(true_values))))
    assert s.kind == "lower" and s.n_censored == 2
    assert s.value <= true_gm
    assert s.value == pytest.approx((180 * 250 * 250) ** (1 / 3))
    assert all(math.isnan(v) for v in s.ci95), "a bound has no confidence interval"


def test_disagreeing_bounds_give_no_summary():
    s = compare.summarize_fragment("x", [_est("lower", 250.0), _est("upper", 1.0)])
    assert s.kind == "mixed" and math.isnan(s.value)


def test_no_usable_replicates():
    s = compare.summarize_fragment("x", [compare.KdEstimate("r", "none", math.nan)])
    assert s.kind == "none" and s.n == 0


# ── Reference, fold change, wording ───────────────────────────────────


def test_reference_selection():
    assert compare.pick_reference(["-10 shuffle", "WT", "-35 shuffle"], None) == "WT"
    assert compare.pick_reference(["mut", "Wild-type"], None) == "Wild-type"
    assert compare.pick_reference(["a", "b"], None) == "a"
    assert compare.pick_reference(["WT", "-35 shuffle"], "-35 SHUFFLE") == "-35 shuffle"
    with pytest.raises(ValueError, match="not one of the fragments"):
        compare.pick_reference(["WT"], "nope")
    assert compare.order_fragments(["-10", "WT", "-35"], "WT") == ["WT", "-10", "-35"]


def test_fold_change_direction_is_stated_not_implied():
    """Kd runs opposite to affinity; the label must say which way."""
    wt = compare.summarize_fragment("WT", [_est("value", 40.0)])
    weak = compare.summarize_fragment("m", [_est("value", 160.0)])
    tight = compare.summarize_fragment("t", [_est("value", 10.0)])
    cens = compare.summarize_fragment("c", [_est("lower", 250.0)])
    assert compare.fold_phrase(*compare.fold_change(weak, wt)) == "4× weaker"
    assert compare.fold_phrase(*compare.fold_change(tight, wt)) == "4× tighter"
    assert compare.fold_phrase(*compare.fold_change(cens, wt)) == "> 6.2× weaker"
    assert compare.fold_phrase(*compare.fold_change(wt, wt)) == "reference"
    # A censored reference makes every ratio meaningless.
    assert compare.fold_change(weak, cens) == (pytest.approx(math.nan, nan_ok=True), "n/a")


def test_safe_name():
    assert compare.safe_name("-10/-35 shuffle") == "-10_-35_shuffle"
    assert compare.safe_name("  WT  ") == "WT"
    assert compare.safe_name("///") == "unlabeled"


# ── Loading fragments ─────────────────────────────────────────────────


def _roi_csv(path: Path, fragment: str | None, replicate: str, kd: float) -> Path:
    header = ["replicate", "lane", "protein_conc_nM", "probe_nM", "species",
              "integrated_intensity"] + (["fragment"] if fragment is not None else [])
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for i, c in enumerate(CONCS):
            f = true_f_bound(c, kd=kd)
            for sp, v in (("free", 1e6 * (1 - f)), ("bound", 1e6 * f)):
                w.writerow([replicate, i + 1, c, 8.0, sp, v]
                           + ([fragment] if fragment is not None else []))
    return path


def test_fragment_column_groups_replicates(tmp_path):
    a = _roi_csv(tmp_path / "a.csv", "WT", "1", 45)
    b = _roi_csv(tmp_path / "b.csv", "-10 shuffle", "1", 900)
    reps = dataset.load_all([a, b], 8.0)
    assert [(r.fragment, r.name) for r in reps] == [("WT", "1"), ("-10 shuffle", "1")]


def test_same_replicate_id_across_fragments_is_not_a_collision(tmp_path):
    """'WT rep 1' and '-10 shuffle rep 1' are routinely the same protein
    prep against two probes; they must keep their names."""
    a = _roi_csv(tmp_path / "a.csv", "WT", "1", 45)
    b = _roi_csv(tmp_path / "b.csv", "m", "1", 90)
    c = _roi_csv(tmp_path / "c.csv", "WT", "1", 50)       # a genuine duplicate
    names = [(r.fragment, r.name) for r in dataset.load_all([a, b, c], 8.0)]
    assert ("m", "1") in names
    assert ("WT", "a:1") in names and ("WT", "c:1") in names


def test_command_line_label_names_an_unlabeled_file(tmp_path):
    a = _roi_csv(tmp_path / "old_export.csv", None, "1", 45)
    reps = dataset.load_all([a], 8.0, fragments=["WT"])
    assert reps[0].fragment == "WT"


def test_one_csv_holding_two_fragments_gets_two_depletion_references(tmp_path):
    """Each fragment's f_depletion must be referenced to its OWN 0 nM lane."""
    p = tmp_path / "mixed.csv"
    with open(p, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["fragment", "lane", "protein_conc_nM", "species", "integrated_intensity"])
        for frag, total in (("WT", 1e6), ("m", 5e5)):      # different probe loading
            for i, c in enumerate(CONCS):
                f = true_f_bound(c, kd=45)
                w.writerow([frag, i + 1, c, "free", total * (1 - f)])
                w.writerow([frag, i + 1, c, "bound", total * f])
    reps = {r.fragment: r for r in dataset.load_all([p], 8.0)}
    for r in reps.values():
        assert r.reference_conc == 0.0
        for pt in r.points:
            assert pt.f_depletion == pytest.approx(pt.f_ratio, abs=1e-9)


# ── End to end ────────────────────────────────────────────────────────


@pytest.fixture()
def fragment_set(tmp_path):
    """Three replicates each of WT, a weaker mutant, and a non-binder —
    named the way the user names them, leading dashes and all."""
    rng = np.random.default_rng(5)
    files = []
    for frag, kd in (("WT", 45.0), ("-35 shuffle", 180.0), ("-10 shuffle", 900.0)):
        for rep in (1, 2, 3):
            k = kd * 10 ** rng.normal(0, 0.05)
            files.append(_roi_csv(tmp_path / f"{compare.safe_name(frag)}_rep{rep}_quant.csv",
                                  frag, str(rep), k))
    return tmp_path, files


def test_comparison_end_to_end(fragment_set):
    d, files = fragment_set
    # Files whose names start with '-' must be accepted as inputs.
    assert any(f.name.startswith("-") for f in files)
    assert cli.main([str(f) for f in files] + ["-o", str(d), "--quiet"]) == 0

    for name in ("femsa_compare.csv", "femsa_compare.png", "femsa_compare.svg",
                 "femsa_WT_fit.png", "femsa_-10_shuffle_fit.png", "femsa_fit_report.txt"):
        assert (d / name).exists(), name

    rows = {r["fragment"]: r for r in csv.DictReader(open(d / "femsa_compare.csv"))}
    assert list(rows) == ["WT", "-35 shuffle", "-10 shuffle"]         # reference first
    assert rows["WT"]["kind"] == "value"
    assert float(rows["WT"]["kd_nM"]) == pytest.approx(45.0, rel=0.1)
    assert rows["-35 shuffle"]["kind"] == "value"
    assert float(rows["-35 shuffle"]["kd_nM"]) == pytest.approx(180.0, rel=0.15)
    assert "weaker" in rows["-35 shuffle"]["fold_phrase"]
    assert rows["-10 shuffle"]["kind"] == "lower"
    assert float(rows["-10 shuffle"]["kd_nM"]) == 250
    assert rows["-10 shuffle"]["fold_phrase"].startswith("> ")

    text = (d / "femsa_fit_report.txt").read_text()
    assert "FRAGMENT COMPARISON" in text
    assert text.count("CARRY INTO THE MANUSCRIPT") == 1
    assert "[-10 shuffle]" in text                     # warnings are attributed

    params = list(csv.DictReader(open(d / "femsa_fit_params.csv")))
    assert {r["fragment"] for r in params} == {"WT", "-35 shuffle", "-10 shuffle"}


def test_labels_on_the_command_line(fragment_set, tmp_path):
    d, files = fragment_set
    wt = [f for f in files if f.name.startswith("WT")]
    m = [f for f in files if f.name.startswith("-35")]
    args = [f"WT={f}" for f in wt] + [f"-35 shuffle={f}" for f in m]
    assert cli.main(args + ["-o", str(tmp_path / "out"), "--quiet", "--no-plot",
                            "--reference", "WT"]) == 0
    rows = list(csv.DictReader(open(tmp_path / "out" / "femsa_compare.csv")))
    assert [r["fragment"] for r in rows] == ["WT", "-35 shuffle"]


def test_bad_reference_is_a_clean_error(fragment_set, tmp_path):
    _, files = fragment_set
    assert cli.main([str(f) for f in files] + ["-o", str(tmp_path), "--quiet",
                                               "--no-plot", "--reference", "KO"]) == 2


def test_split_argv_keeps_options_and_dash_named_inputs_apart():
    p = cli.build_parser()
    out = cli.split_argv(p, ["-10_a.csv", "--fmax", "1", "-o", "dir", "-35=b.csv",
                             "--quiet", "--title=x", "WT_c.csv"])
    assert out == ["--fmax", "1", "-o", "dir", "--quiet", "--title=x",
                   "--", "-10_a.csv", "-35=b.csv", "WT_c.csv"]
    args = p.parse_args(out)
    assert args.inputs == ["-10_a.csv", "-35=b.csv", "WT_c.csv"] and args.fmax == 1.0


def test_dot_style_renders(fragment_set, tmp_path):
    _, files = fragment_set
    assert cli.main([str(f) for f in files] + ["-o", str(tmp_path), "--quiet",
                                               "--style", "dot"]) == 0
    assert (tmp_path / "femsa_compare.png").stat().st_size > 10_000
