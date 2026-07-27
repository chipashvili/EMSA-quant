"""Raw-pixel ROI quantification for fEMSA band intensities.

This module is the extraction half of the fEMSA workflow. It answers one
question and nothing else: *given a rectangle in image coordinates, what
is the integrated raw signal inside it, and can I trust that number?*

Design constraints that shaped it:

* **Raw pixels only.** Every statistic is computed from
  ``ImageRecord.src`` — the array as decoded from the source file, at
  native dtype. The LUT (min / max / gamma) that drives the on-screen
  preview is a display transform and is deliberately unreachable from
  here. An iBright's auto-contrast export is not linear in signal, so
  quantifying the preview would silently bias every Kd.

* **Sums, not means, are the primary output.** A band's total emitted
  photons scale with integrated intensity; mean intensity divides that
  by an arbitrary box size. Both are returned, but ``sum`` is what the
  fitting stage consumes.

* **Background subtraction is deferred to the caller.** The endpoint
  reports each ROI independently. Pairing a band ROI with its local
  background ROI happens in the frontend (which knows the row layout),
  so this module stays a pure measurement primitive.

* **Saturation is reported two ways** because gel imagers disagree about
  what "full scale" means. See :func:`saturation_reference`.
"""

from __future__ import annotations

import numpy as np
from pydantic import BaseModel, Field


# ── Saturation ────────────────────────────────────────────────────────
#
# A 16-bit TIFF from a Thermo iBright is not necessarily a 16-bit
# *measurement*. The sensor may be 12- or 14-bit with the values
# left-shifted or simply left small, so a genuinely clipped band can top
# out at 4095 or 16383 rather than 65535. Testing only against the dtype
# ceiling therefore misses real saturation on exactly the instruments
# this tool targets.
#
# So we report two independent signals and let the caller decide:
#
#   sat_pixels      pixels at or above the DTYPE ceiling (65535 for
#                   uint16). Unambiguous when it fires — the file format
#                   itself could not represent a larger number.
#
#   plateau_pixels  pixels at the IMAGE's own global maximum. On an
#                   unsaturated gel this is a handful of noise pixels
#                   scattered anywhere. On a clipped band it is a
#                   contiguous flat top of hundreds of pixels sitting
#                   inside one ROI. The count is what distinguishes the
#                   two cases, which is why we return the raw number
#                   rather than a bare boolean.
#
# PLATEAU_MIN_PIXELS / PLATEAU_MIN_FRACTION encode "a flat top, not
# noise". A band ROI in a typical gel scan is O(10^4) pixels, so the
# fractional test dominates for normal ROIs and the absolute floor
# catches unusually small ones.

PLATEAU_MIN_PIXELS = 8
PLATEAU_MIN_FRACTION = 0.001


def saturation_reference(arr: np.ndarray, raw_max: float) -> tuple[float, str]:
    """Return ``(value, method)`` for the "this pixel is clipped" test.

    Integer sources have a hard, format-defined ceiling — use it. Float
    sources (rare; some instruments export 32-bit float TIFFs) have no
    such ceiling, so the image's own maximum is the only reference
    available and ``sat_pixels`` degenerates to ``plateau_pixels``.
    """
    if np.issubdtype(arr.dtype, np.integer):
        return float(np.iinfo(arr.dtype).max), "dtype"
    return float(raw_max), "image-max"


# ── Request / response models ─────────────────────────────────────────


class QuantROI(BaseModel):
    """One rectangle to measure, in IMAGE coordinates (not SVG / canvas).

    ``id`` is opaque to the server — the frontend uses it to re-associate
    results with the (lane, row) pair that produced them.
    """
    id: str
    x: float
    y: float
    w: float
    h: float


class QuantRequest(BaseModel):
    rois: list[QuantROI] = Field(default_factory=list)
    # Optional hard override for the clipping threshold, in RAW units.
    # Set this when you know the instrument's true full scale (e.g. 4095
    # for a 12-bit sensor written into a uint16 container) and want
    # sat_pixels to reflect it instead of the dtype ceiling.
    saturation_value: float | None = None


class QuantROIResult(BaseModel):
    id: str
    # Geometry actually measured, after clamping to the image bounds.
    x: int
    y: int
    w: int
    h: int
    clipped_to_image: bool
    empty: bool                 # ROI fell entirely outside the image

    n_pixels: int
    sum: float                  # integrated raw intensity — the primary output
    mean: float
    median: float
    min: float
    max: float
    std: float

    sat_pixels: int             # pixels >= the dtype / override ceiling
    plateau_pixels: int         # pixels at the image's own global max
    saturated: bool             # sat_pixels > 0
    plateau: bool               # plateau_pixels large enough to read as a flat top


class QuantResponse(BaseModel):
    results: list[QuantROIResult]
    # Echoed context so an exported CSV can record exactly how the
    # numbers were derived without a second round-trip.
    image_min: float
    image_max: float
    dtype: str
    bit_depth: int
    saturation_value: float
    saturation_method: str      # "dtype" | "image-max" | "override"


# ── Measurement ───────────────────────────────────────────────────────


def measure_roi(
    src: np.ndarray,
    roi: QuantROI,
    sat_value: float,
    image_max: float,
) -> QuantROIResult:
    """Measure one ROI against the raw source array.

    Rectangle edges are rounded to whole pixels with ``floor`` on the
    top-left and ``ceil`` on the bottom-right, so a box the user drew to
    visually enclose a band does not silently drop its outermost row of
    pixels. Partial-pixel weighting is deliberately not implemented: it
    would add sub-percent precision to a measurement whose real error
    budget is dominated by background estimation and gel-run
    non-equilibrium effects.
    """
    h_img, w_img = src.shape
    x0 = int(np.floor(roi.x))
    y0 = int(np.floor(roi.y))
    x1 = int(np.ceil(roi.x + roi.w))
    y1 = int(np.ceil(roi.y + roi.h))

    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(w_img, x1), min(h_img, y1)
    clipped = (cx0, cy0, cx1, cy1) != (x0, y0, x1, y1)

    if cx1 <= cx0 or cy1 <= cy0:
        return QuantROIResult(
            id=roi.id, x=cx0, y=cy0, w=0, h=0,
            clipped_to_image=True, empty=True,
            n_pixels=0, sum=0.0, mean=0.0, median=0.0, min=0.0, max=0.0, std=0.0,
            sat_pixels=0, plateau_pixels=0, saturated=False, plateau=False,
        )

    # float64 accumulation: a 200×60 uint16 ROI of bright pixels sums to
    # ~8e8, which float32 represents with ~64-unit granularity. That is
    # visible rounding on a ratio of two such sums, so we pay for f64.
    patch = src[cy0:cy1, cx0:cx1].astype(np.float64, copy=False)
    n = int(patch.size)

    sat_pixels = int(np.count_nonzero(patch >= sat_value))
    plateau_pixels = int(np.count_nonzero(patch >= image_max))
    plateau = plateau_pixels >= max(PLATEAU_MIN_PIXELS, PLATEAU_MIN_FRACTION * n)

    return QuantROIResult(
        id=roi.id,
        x=cx0, y=cy0, w=cx1 - cx0, h=cy1 - cy0,
        clipped_to_image=clipped, empty=False,
        n_pixels=n,
        sum=float(patch.sum()),
        mean=float(patch.mean()),
        median=float(np.median(patch)),
        min=float(patch.min()),
        max=float(patch.max()),
        std=float(patch.std()),
        sat_pixels=sat_pixels,
        plateau_pixels=plateau_pixels,
        saturated=sat_pixels > 0,
        plateau=plateau,
    )


def quantify(
    src: np.ndarray,
    raw_min: float,
    raw_max: float,
    req: QuantRequest,
) -> QuantResponse:
    """Measure every ROI in ``req`` against ``src``."""
    if req.saturation_value is not None:
        sat_value, method = float(req.saturation_value), "override"
    else:
        sat_value, method = saturation_reference(src, raw_max)

    bit_depth = (
        16 if src.dtype in (np.uint16, np.int16)
        else 32 if src.dtype in (np.float32, np.float64, np.int32, np.uint32)
        else 8
    )

    return QuantResponse(
        results=[measure_roi(src, r, sat_value, raw_max) for r in req.rois],
        image_min=float(raw_min),
        image_max=float(raw_max),
        dtype=str(src.dtype),
        bit_depth=bit_depth,
        saturation_value=sat_value,
        saturation_method=method,
    )


# ── Lane profile ──────────────────────────────────────────────────────


class ProfileRequest(BaseModel):
    """Vertical intensity profile over an x-range, used to place rows."""
    x_left: float
    x_right: float
    y_top: float
    y_bot: float


class ProfileResponse(BaseModel):
    y0: int                     # image-y of profile[0]
    profile: list[float]        # mean raw intensity per image row
    vmin: float
    vmax: float


def lane_profile(src: np.ndarray, req: ProfileRequest) -> ProfileResponse:
    """Collapse a rectangle to a 1-D vertical profile of RAW means.

    Same collapse the ladder auto-detector uses, but returned as data
    rather than as detected peaks, and without inversion — the caller
    plots it so the user can see where the free and bound populations
    sit before committing a row position. Raw units (not LUT-mapped) so
    the plot's y-axis is the same quantity the ROI sums are built from.
    """
    h_img, w_img = src.shape
    x0 = max(0, int(req.x_left))
    x1 = min(w_img, int(req.x_right))
    y0 = max(0, int(req.y_top))
    y1 = min(h_img, int(req.y_bot))
    if x1 <= x0 or y1 <= y0:
        return ProfileResponse(y0=y0, profile=[], vmin=0.0, vmax=0.0)
    prof = src[y0:y1, x0:x1].astype(np.float64, copy=False).mean(axis=1)
    return ProfileResponse(
        y0=y0,
        profile=[float(v) for v in prof],
        vmin=float(prof.min()),
        vmax=float(prof.max()),
    )
