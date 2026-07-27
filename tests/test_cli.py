"""End-to-end: gel image -> ROI extraction -> CSV -> femsa-fit outputs.

Reproduces the frontend's exact ROI geometry and CSV schema in Python,
so a change to either side that breaks the handoff shows up here rather
than in someone's analysis.
"""

from __future__ import annotations

import csv

import pytest

from gel_annotator.fit import cli
from tests.conftest import CONCS, TRUE_KD, lane_roi

FREE_Y, BOUND_Y = (470, 570), (250, 360)
BG_FREE_Y, BG_BOUND_Y = (400, 465), (170, 240)

CSV_COLUMNS = [
    "image", "replicate", "lane", "lane_label", "protein_conc_nM", "probe_nM",
    "species", "row_name", "roi_x", "roi_y", "roi_w", "roi_h", "n_pixels",
    "integrated_intensity", "bg_intensity", "net_integrated_intensity",
    "mean_intensity", "bg_mean", "max_value", "sat_pixels", "plateau_pixels",
    "saturated", "excluded", "exclude_reason", "bg_row", "source_dtype",
    "saturation_reference",
]


@pytest.fixture()
def quant_csv(client, uploaded, tmp_path):
    """Mirror of quant.js buildCsv(), driven off the real endpoint."""
    iid = uploaded["image_id"]
    rois = []
    for i in range(12):
        rois.append(lane_roi(i, *FREE_Y, f"free|{i}"))
        rois.append(lane_roi(i, *BOUND_Y, f"bound|{i}"))
        rois.append(lane_roi(i, *BG_FREE_Y, f"bgfree|{i}"))
        rois.append(lane_roi(i, *BG_BOUND_Y, f"bgbound|{i}"))
    resp = client.post(f"/api/image/{iid}/quantify", json={"rois": rois}).json()
    by = {r["id"]: r for r in resp["results"]}

    path = tmp_path / "gel_quant.csv"
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_COLUMNS)
        for species, bgkey in (("free", "bgfree"), ("bound", "bgbound")):
            for i, conc in enumerate(CONCS):
                m = by[f"{species}|{i}"]
                bg = by[f"{bgkey}|{i}"]
                bgi = bg["mean"] * m["n_pixels"]
                w.writerow([
                    "femsa.tif", "rep1", i + 1, i + 1, conc, 8.0, species, species,
                    m["x"], m["y"], m["w"], m["h"], m["n_pixels"],
                    f"{m['sum']:.3f}", f"{bgi:.3f}", f"{m['sum'] - bgi:.3f}",
                    f"{m['mean']:.4f}", f"{bg['mean']:.4f}", m["max"],
                    m["sat_pixels"], m["plateau_pixels"],
                    1 if (m["saturated"] or m["plateau"]) else 0, 0, "",
                    bgkey, resp["dtype"], resp["saturation_value"],
                ])
    return path


def test_full_pipeline_recovers_kd(quant_csv, tmp_path, capsys):
    rc = cli.main([str(quant_csv), "--probe-nm", "8", "--outdir", str(tmp_path), "--quiet"])
    assert rc == 0

    params = list(csv.DictReader(open(tmp_path / "gel_fit_params.csv")))
    primary = [r for r in params
               if r["scope"] == "replicate" and r["method"] == "ratio"
               and r["model"] == "quadratic"]
    assert len(primary) == 1
    kd = float(primary[0]["kd_nM"])
    # Extraction noise, the background gradient, and 4% loading scatter
    # all contribute; 20% is a real tolerance, not a rubber stamp.
    assert kd == pytest.approx(TRUE_KD, rel=0.20), f"recovered Kd {kd} nM vs true {TRUE_KD}"
    assert float(primary[0]["r_squared"]) > 0.99
    assert int(primary[0]["converged"]) == 1

    for name in ("gel_fit_report.txt", "gel_fit_points.csv", "gel_fit.png", "gel_fit.svg"):
        assert (tmp_path / name).exists(), name


def test_report_flags_the_depletion_regime(quant_csv, tmp_path):
    cli.main([str(quant_csv), "--probe-nm", "8", "--outdir", str(tmp_path), "--quiet"])
    text = (tmp_path / "gel_fit_report.txt").read_text()
    assert "apparent Kd" in text
    assert "within 10x of the probe concentration" in text
    assert "n >= 3 INDEPENDENT protein preps" in text
    assert "hyperbolic Kd / quadratic Kd" in text


def test_drop_saturated_flag(quant_csv, tmp_path):
    rows = list(csv.DictReader(open(quant_csv)))
    header = list(rows[0])
    for r in rows:
        if r["species"] == "free" and float(r["protein_conc_nM"]) == 0:
            r["saturated"] = "1"
    doctored = tmp_path / "sat_quant.csv"
    with open(doctored, "w", newline="") as fh:
        w = csv.DictWriter(fh, header)
        w.writeheader()
        w.writerows(rows)

    cli.main([str(doctored), "--outdir", str(tmp_path), "--quiet"])
    assert "Saturated ROIs are included in the fit" in (tmp_path / "sat_fit_report.txt").read_text()

    cli.main([str(doctored), "--outdir", str(tmp_path), "--prefix", "dropped",
              "--drop-saturated", "--quiet"])
    pts = list(csv.DictReader(open(tmp_path / "dropped_fit_points.csv")))
    assert any(p["exclude_reason"] == "saturated (--drop-saturated)" for p in pts)


def test_missing_file_exits_nonzero(tmp_path):
    assert cli.main([str(tmp_path / "nope.csv")]) == 2
