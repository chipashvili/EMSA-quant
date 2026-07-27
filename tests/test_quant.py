"""Raw-intensity extraction: the /quantify endpoint and quant.py."""

from __future__ import annotations

import numpy as np
import pytest
import tifffile

from tests.conftest import CONCS, LANE0, LANEW, lane_roi

FREE_Y = (470, 570)
BOUND_Y = (250, 360)


def test_reports_16_bit(uploaded):
    assert uploaded["bit_depth"] == 16
    assert uploaded["raw_max"] > 255, "a 16-bit TIFF must not be collapsed to 8-bit on load"


def test_lut_cannot_change_a_measurement(client, uploaded):
    """The whole premise of the fork: display transforms never touch the
    numbers. An iBright's auto-contrast is not linear in signal, so a
    quantification that tracked the LUT would bias every Kd."""
    iid = uploaded["image_id"]
    rois = [lane_roi(i, *FREE_Y, f"f{i}") for i in range(3)]
    before = client.post(f"/api/image/{iid}/quantify", json={"rois": rois}).json()

    # Drive the LUT to an extreme in both directions.
    for qs in ("min=5000&max=6000&gamma=3", "min=0&max=100&gamma=0.2"):
        client.get(f"/api/image/{iid}/preview.png?{qs}")
    after = client.post(f"/api/image/{iid}/quantify", json={"rois": rois}).json()

    assert [r["sum"] for r in before["results"]] == [r["sum"] for r in after["results"]]
    assert [r["max"] for r in before["results"]] == [r["max"] for r in after["results"]]


def test_sum_matches_numpy_exactly(client, uploaded, gel_array):
    iid = uploaded["image_id"]
    roi = lane_roi(4, *FREE_Y, "x")
    got = client.post(f"/api/image/{iid}/quantify", json={"rois": [roi]}).json()["results"][0]
    expect = gel_array[FREE_Y[0]:FREE_Y[1], LANE0 + LANEW * 4:LANE0 + LANEW * 5].astype(np.float64)
    assert got["n_pixels"] == expect.size
    assert got["sum"] == pytest.approx(float(expect.sum()), rel=1e-12)
    assert got["mean"] == pytest.approx(float(expect.mean()), rel=1e-12)
    assert got["max"] == pytest.approx(float(expect.max()))


def test_roi_clamped_to_image(client, uploaded):
    iid = uploaded["image_id"]
    r = client.post(f"/api/image/{iid}/quantify", json={"rois": [
        {"id": "edge", "x": 860, "y": 650, "w": 200, "h": 200},
        {"id": "gone", "x": 5000, "y": 5000, "w": 50, "h": 50},
    ]}).json()["results"]
    assert r[0]["clipped_to_image"] and (r[0]["w"], r[0]["h"]) == (40, 50)
    assert r[1]["empty"] and r[1]["n_pixels"] == 0 and r[1]["sum"] == 0.0


def test_roi_rounds_outward(client, uploaded):
    """A fractional box must not silently drop its outer pixel row."""
    iid = uploaded["image_id"]
    r = client.post(f"/api/image/{iid}/quantify", json={"rois": [
        {"id": "frac", "x": 100.4, "y": 200.6, "w": 50.3, "h": 30.1},
    ]}).json()["results"][0]
    assert (r["x"], r["y"]) == (100, 200)
    assert r["w"] == 151 - 100 and r["h"] == 231 - 200


@pytest.mark.parametrize("scale,ceiling,want_sat,want_plateau", [
    (1.0,  65535, False, False),   # ordinary exposure: neither fires
    (15.0, 65535, True,  True),    # clipped at the uint16 ceiling
    (1.0,   4000, False, True),    # 12-bit-style ceiling: never hits 65535
])
def test_saturation_two_signals(client, gel_array, tmp_path, scale, ceiling, want_sat, want_plateau):
    """sat_pixels catches the dtype ceiling; plateau_pixels catches an
    instrument whose full scale is below it. A 16-bit TIFF from a 12- or
    14-bit sensor is exactly the case where only the second one fires,
    and that is the common case on the target instrument."""
    arr = np.clip(gel_array.astype(np.float64) * scale, 0, ceiling).astype(np.uint16)
    p = tmp_path / "s.tif"
    tifffile.imwrite(p, arr)
    with open(p, "rb") as fh:
        iid = client.post("/api/upload", files={"file": (p.name, fh, "image/tiff")}).json()["image_id"]
    # Lane 1 free band — the brightest feature in the image.
    r = client.post(f"/api/image/{iid}/quantify",
                    json={"rois": [lane_roi(0, *FREE_Y, "b")]}).json()["results"][0]
    assert r["saturated"] is want_sat
    assert r["plateau"] is want_plateau


def test_saturation_override(client, uploaded):
    iid = uploaded["image_id"]
    roi = [lane_roi(0, *FREE_Y, "b")]
    plain = client.post(f"/api/image/{iid}/quantify", json={"rois": roi}).json()
    assert plain["saturation_method"] == "dtype" and plain["results"][0]["sat_pixels"] == 0
    forced = client.post(f"/api/image/{iid}/quantify",
                         json={"rois": roi, "saturation_value": 2000}).json()
    assert forced["saturation_method"] == "override"
    assert forced["results"][0]["sat_pixels"] > 0


def test_fraction_bound_tracks_truth(client, uploaded):
    """Extraction with a background row alongside each band should
    reproduce the simulated fraction bound to within a few percent."""
    from tests.conftest import true_f_bound
    iid = uploaded["image_id"]
    rois = []
    for i in range(12):
        rois.append(lane_roi(i, *FREE_Y, f"free|{i}"))
        rois.append(lane_roi(i, *BOUND_Y, f"bound|{i}"))
        rois.append(lane_roi(i, 400, 465, f"bgfree|{i}"))
        rois.append(lane_roi(i, 170, 240, f"bgbound|{i}"))
    by = {r["id"]: r for r in
          client.post(f"/api/image/{iid}/quantify", json={"rois": rois}).json()["results"]}

    for i, c in enumerate(CONCS):
        f = by[f"free|{i}"]; b = by[f"bound|{i}"]
        nf = f["sum"] - by[f"bgfree|{i}"]["mean"] * f["n_pixels"]
        nb = b["sum"] - by[f"bgbound|{i}"]["mean"] * b["n_pixels"]
        got = nb / (nb + nf)
        assert got == pytest.approx(true_f_bound(c), abs=0.035), f"lane {i + 1} at {c} nM"


def test_profile_finds_the_bands(client, uploaded):
    iid = uploaded["image_id"]
    r = client.post(f"/api/image/{iid}/profile", json={
        "x_left": LANE0, "x_right": LANE0 + LANEW * 12, "y_top": 0, "y_bot": 700,
    }).json()
    prof = np.asarray(r["profile"])
    assert len(prof) == 700
    assert abs(int(prof.argmax()) + r["y0"] - 520) < 8, "brightest row should be the free band"


def test_roi_limit_rejected(client, uploaded):
    iid = uploaded["image_id"]
    rois = [{"id": str(i), "x": 0, "y": 0, "w": 2, "h": 2} for i in range(4097)]
    assert client.post(f"/api/image/{iid}/quantify", json={"rois": rois}).status_code == 400


# ── Frontend asset delivery ───────────────────────────────────────────


def test_index_serves_all_three_assets(client):
    html = client.get("/").text
    for asset in ("/style.css", "/app.js", "/quant.js"):
        assert asset in html, f"{asset} missing from index.html"
    for path in ("/style.css", "/app.js", "/quant.js"):
        r = client.get(path)
        assert r.status_code == 200 and len(r.content) > 0, path


def test_asset_cache_tags_follow_file_content(client, monkeypatch):
    """Upstream hand-maintains the ?v= strings on the script/link tags.
    Editing quant.js without also editing its version string left every
    browser with the page cached running the OLD file — a silent failure
    that looks exactly like a broken feature. Tags are now derived from
    the file, so this cannot recur."""
    import re as _re
    from gel_annotator.server import main as _main

    def tags(html):
        return dict(_re.findall(r'/(app\.js|quant\.js|style\.css)\?v=([^"]+)', html))

    before = tags(client.get("/").text)
    assert set(before) == {"app.js", "quant.js", "style.css"}
    # A hand-written literal would still be sitting there unchanged.
    assert all(v not in ("", "20260629-bg-color") for v in before.values())

    # Same bytes -> same tags (no spurious cache misses on every request).
    assert tags(client.get("/").text) == before

    # Changed file -> changed tag.
    real_stat = (_main._FRONTEND / "quant.js").stat()

    class Bumped:
        st_size = real_stat.st_size + 1
        st_mtime_ns = real_stat.st_mtime_ns + 1_000_000

    orig = _main._asset_tag

    def patched(name):
        if name == "quant.js":
            import hashlib
            seed = f"{name}:{Bumped.st_size}:{Bumped.st_mtime_ns}"
            return hashlib.sha1(seed.encode()).hexdigest()[:10]
        return orig(name)

    monkeypatch.setattr(_main, "_asset_tag", patched)
    after = tags(client.get("/").text)
    assert after["quant.js"] != before["quant.js"], "edited asset must get a new tag"
    assert after["app.js"] == before["app.js"], "untouched asset must keep its tag"
