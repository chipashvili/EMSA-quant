"""Shared fixtures: a synthetic fEMSA gel with a known Kd.

Everything downstream is checked against ground truth rather than
against a golden file, so a change that shifts a number gets caught for
the right reason.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

TRUE_KD = 15.0          # nM
DT = 8.0                # nM probe
FMAX = 0.92
CONCS = [0.0, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512]

H, W = 700, 900
LANE0, LANEW = 40, 70
Y_FREE, Y_BOUND = 520, 300
SIG_Y, SIG_X = 11.0, 16.0
TOTAL_SIGNAL = 9.0e6


def true_f_bound(pt: float, kd: float = TRUE_KD, dt: float = DT, fmax: float = FMAX) -> float:
    s = kd + pt + dt
    return fmax * 2.0 * pt / (s + math.sqrt(max(s * s - 4 * pt * dt, 0.0)))


def _blob(img, cx, cy, amp, sy=SIG_Y, sx=SIG_X):
    y = np.arange(max(0, int(cy - 6 * sy)), min(H, int(cy + 6 * sy)))
    x = np.arange(max(0, int(cx - 4 * sx)), min(W, int(cx + 4 * sx)))
    g = np.outer(np.exp(-0.5 * ((y - cy) / sy) ** 2), np.exp(-0.5 * ((x - cx) / sx) ** 2))
    g *= amp / g.sum()
    img[y[0]:y[-1] + 1, x[0]:x[-1] + 1] += g


@pytest.fixture(scope="session")
def gel_array() -> np.ndarray:
    """A uint16 gel with a deliberate vertical background GRADIENT.

    The gradient is not incidental. A flat background would make naive
    background subtraction look perfect and would hide the single
    largest real-world error source in this workflow — a background ROI
    measured far from the band it corrects.
    """
    rng = np.random.default_rng(7)
    yy = np.linspace(0, 1, H)[:, None]
    xx = np.linspace(0, 1, W)[None, :]
    img = 620.0 + 130 * yy + 60 * xx + rng.normal(0, 45.0, (H, W))
    for i, c in enumerate(CONCS):
        cx = LANE0 + LANEW * i + LANEW / 2
        fb = true_f_bound(c)
        load = TOTAL_SIGNAL * rng.normal(1.0, 0.04)
        _blob(img, cx, Y_FREE, load * (1 - fb))
        if fb > 0:
            _blob(img, cx, Y_BOUND, load * fb, sy=SIG_Y * 1.5)
    return np.clip(img, 0, 65535).astype(np.uint16)


@pytest.fixture(scope="session")
def gel_tiff(gel_array, tmp_path_factory):
    import tifffile
    p = tmp_path_factory.mktemp("gel") / "femsa.tif"
    tifffile.imwrite(p, gel_array)
    return p


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from gel_annotator.server.main import app
    return TestClient(app)


@pytest.fixture()
def uploaded(client, gel_tiff):
    with open(gel_tiff, "rb") as fh:
        r = client.post("/api/upload", files={"file": (gel_tiff.name, fh, "image/tiff")})
    r.raise_for_status()
    return r.json()


def lane_roi(lane: int, y0: float, y1: float, rid: str) -> dict:
    """The same uniform-width geometry the frontend builds."""
    return {"id": rid, "x": LANE0 + LANEW * lane, "y": y0, "w": LANEW, "h": y1 - y0}
