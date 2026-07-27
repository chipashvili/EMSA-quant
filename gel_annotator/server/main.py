"""FastAPI backend.

Responsibilities:
- Accept an uploaded image (PNG/JPEG/TIFF) and return a uint8 PNG preview.
- Apply LUT (min/max/gamma) on demand and return the re-quantised PNG.
- Serve the static frontend.

Explicitly NOT responsible for:
- Rendering annotations / lanes / brackets / labels.
- Generating PNG or SVG exports. Exports happen entirely in the browser
  by serializing or rasterizing the live SVG element. This is the entire
  point of the rebuild — one renderer, not two.
"""

from __future__ import annotations

import io
import re
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from gel_annotator import __app_name__, __version__
from gel_annotator.server import quant as _quant

app = FastAPI(title=__app_name__, version=__version__)

# In-memory image registry: { image_id: ImageRecord }. Adequate for a
# single-user local desktop app; if we ever go multi-user, swap for a
# proper store.
_IMAGES: dict[str, "ImageRecord"] = {}


class ImageRecord:
    """Holds the uint16/float source array plus its current uint8 preview.

    Keeping the source means LUT / invert / future rotation operations can
    re-derive the preview without round-tripping through 8-bit clipping.
    """
    __slots__ = ("src", "raw_min", "raw_max", "filename", "uploaded_at")

    def __init__(self, src: np.ndarray, filename: str):
        self.src = src                        # 2D, dtype any
        self.raw_min = float(src.min())
        self.raw_max = float(src.max())
        self.filename = filename
        self.uploaded_at = time.time()


# ── Upload / preview ──────────────────────────────────────────────────


def _load_image_to_array(data: bytes, filename: str) -> tuple[np.ndarray, int]:
    """Decode any common gel-image format into a 2-D numpy array.

    TIFFs are common and may be 16-bit; PIL handles those, but tifffile is
    a more robust path for unusual TIFF flavours so we try it first.

    Returns `(array, bit_depth)` where `bit_depth` reflects the SOURCE
    pixel format — 8 for typical PNG/JPEG photos, 16 for raw16/16-bit
    TIFF, 32 for floating-point sources. RGB→grayscale conversion is
    transparent to the bit-depth: an 8-bit RGB PNG comes back as a
    float-valued 2-D array (because of the luminance math) but is
    reported as 8-bit so the UI can correctly mark it as limited.
    """
    name = filename.lower()
    if name.endswith((".tif", ".tiff")):
        try:
            import tifffile
            arr = tifffile.imread(io.BytesIO(data))
        except Exception:
            arr = np.array(Image.open(io.BytesIO(data)))
    else:
        arr = np.array(Image.open(io.BytesIO(data)))
    # Capture the source dtype BEFORE the conversion below promotes
    # uint8 RGB to a wider type. The bit-depth we report reflects the
    # ORIGINAL precision, not the post-conversion array's.
    src_dtype = arr.dtype
    if arr.ndim == 3:
        if arr.shape[2] == 4:
            arr = arr[..., :3]
        # Channel-MAX rather than luminance for RGB → grayscale.
        # Why: gel imagers (Bio-Rad GelDoc, Bio-Rad ChemiDoc, etc.)
        # save 8-bit RGB TIFFs with the SATURATED-pixel indicator BAKED
        # IN as pure red (R≈255, G≈0, B≈0). Standard luminance
        # weighting (0.2126 R + 0.7152 G + 0.0722 B) collapses that pure
        # red to grayscale ~54, which then sits near the dark-background
        # quartile of the histogram — so the auto-LUT never marks those
        # pixels as bright and the saturation overlay misses them. Only
        # the near-white pixels at the band EDGES come through as
        # saturated, which produces a "ring around the band" look
        # instead of the user-expected "whole band highlighted".
        # Channel-max (∝ pure red AND pure white both → 255) preserves
        # the imager's saturation marker. For ordinary RGB photos this
        # is also a reasonable grayscale (slightly washed compared with
        # luminance); the gel annotator's use case justifies the
        # tradeoff. Cast to float32 first so np.max returns the right
        # dtype regardless of source.
        arr = arr.astype(np.float32, copy=False).max(axis=2)
    bit_depth = (
        16 if src_dtype in (np.uint16, np.int16)
        else 32 if src_dtype in (np.float32, np.float64, np.int32, np.uint32)
        else 8
    )
    return np.ascontiguousarray(arr), bit_depth


def _to_uint8(arr: np.ndarray, lut_min: float, lut_max: float, gamma: float = 1.0) -> np.ndarray:
    """Map [lut_min, lut_max] → [0, 255] with optional gamma.

    Out-of-range values clamp. Gamma is applied to the normalised [0,1]
    range before scaling to 255. Uses in-place numpy ops to avoid
    extra allocations on large images (4000×3000 16-bit gel scans
    common).
    """
    if lut_max <= lut_min:
        lut_max = lut_min + 1.0
    f = np.empty(arr.shape, dtype=np.float32)
    np.subtract(arr, lut_min, out=f, casting="unsafe")
    np.divide(f, lut_max - lut_min, out=f)
    np.clip(f, 0.0, 1.0, out=f)
    if gamma != 1.0 and gamma > 0:
        np.power(f, 1.0 / gamma, out=f)
    np.multiply(f, 255.0, out=f)
    np.add(f, 0.5, out=f)
    return f.astype(np.uint8)


# Preview images larger than this (along the longer axis) are downsampled
# server-side before PNG encoding. The frontend renders the <image> at the
# ORIGINAL imgWidth × imgHeight in SVG-coords, so the displayed picture is
# bilinear-stretched — annotations stay aligned because they're in image-
# coords, not pixel-coords. Trade a bit of preview sharpness on enormous
# scans for ~10× faster uploads.
_PREVIEW_MAX_DIM = 2400


def _png_bytes(uint8: np.ndarray) -> bytes:
    """Encode a uint8 grayscale array as PNG bytes.

    We use compress_level=1 (very fast, slightly larger files). Localhost
    bandwidth is irrelevant; encode time dominates upload latency on big
    images. Default compress_level=6 takes ~5–10× longer for tiny size
    savings.
    """
    h, w = uint8.shape
    if max(h, w) > _PREVIEW_MAX_DIM:
        scale = _PREVIEW_MAX_DIM / max(h, w)
        new_size = (int(w * scale), int(h * scale))
        im = Image.fromarray(uint8, mode="L").resize(new_size, Image.Resampling.BILINEAR)
    else:
        im = Image.fromarray(uint8, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


class UploadResponse(BaseModel):
    image_id: str
    width: int
    height: int
    filename: str
    raw_min: float
    raw_max: float
    bit_depth: int
    initial_lut: dict


@app.post("/api/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    if not file.filename:
        raise HTTPException(400, "No file provided.")
    data = await file.read()
    try:
        arr, bit_depth = _load_image_to_array(data, file.filename)
    except Exception as exc:
        raise HTTPException(400, f"Could not decode image: {exc}")
    if arr.ndim != 2:
        raise HTTPException(400, f"Expected a 2-D image, got shape {arr.shape}.")

    image_id = uuid.uuid4().hex[:12]
    rec = ImageRecord(arr, file.filename)
    _IMAGES[image_id] = rec
    h, w = arr.shape
    # Auto-stretch the LUT to the central 98% of pixel values (p1..p99.5).
    # This gives the gel content a natural high-contrast appearance on
    # first load: dark background gets pushed to black via lut_min = p1
    # (was lut_min = raw_min, which left low-end pixels grayish-dark and
    # made gels look murky), and the brightest 0.5% clip to white via
    # lut_max = p99.5 (saturated bands). The user can still re-edit
    # min/max in the LUT popover; this is just a sane starting point.
    p1 = float(np.percentile(arr, 1.0))
    p995 = float(np.percentile(arr, 99.5))
    initial_min = max(rec.raw_min, p1)
    initial_max = max(p995, initial_min + 1.0)
    return UploadResponse(
        image_id=image_id,
        width=w,
        height=h,
        filename=file.filename,
        raw_min=rec.raw_min,
        raw_max=rec.raw_max,
        bit_depth=bit_depth,
        initial_lut={"min": initial_min, "max": initial_max, "gamma": 1.0},
    )


@app.get("/api/image/{image_id}/preview.png")
def preview(
    image_id: str,
    min: float = -1.0,
    max: float = -1.0,
    gamma: float = 1.0,
) -> Response:
    """Return the LUT-adjusted PNG preview. `min` / `max` defaults of -1
    mean "use the source min/max"."""
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    lut_min = rec.raw_min if min < 0 else min
    lut_max = rec.raw_max if max < 0 else max
    uint8 = _to_uint8(rec.src, lut_min, lut_max, gamma)
    return Response(content=_png_bytes(uint8), media_type="image/png")


class RotateRequest(BaseModel):
    angle: float = Field(..., description="Rotation angle in degrees, clockwise.")


@app.post("/api/image/{image_id}/rotate", response_model=UploadResponse)
def rotate_image(image_id: str, req: RotateRequest) -> UploadResponse:
    """Rotate the source array in place. Returns a fresh UploadResponse so
    the frontend can re-fetch the preview at the new dimensions.

    Multiples of 90° use np.rot90 (lossless, exact); other angles fall back
    to PIL's bicubic. Rotation is destructive on the SOURCE array — the
    rebuild keeps a single source-of-truth, no separate "rotated copy".
    """
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    angle = float(req.angle) % 360
    if angle == 0:
        return _upload_response(image_id, rec)
    if angle in (90.0, 180.0, 270.0):
        k = int(angle // 90)
        # np.rot90 is counter-clockwise; we want clockwise so negate.
        rotated = np.ascontiguousarray(np.rot90(rec.src, k=-k))
    else:
        # Free-angle rotation via PIL. Round-trip through PIL preserves
        # dtype for 8-bit; for higher bit depths we fall back to float32.
        is_high_bit = rec.src.dtype not in (np.uint8,)
        as_float = rec.src.astype(np.float32)
        # Normalise to 0..1 for PIL's transform (PIL doesn't handle 16-bit
        # natively). Re-scale on the way back so raw_min/max stays correct.
        norm = (as_float - rec.raw_min) / max(1e-9, rec.raw_max - rec.raw_min)
        norm = np.clip(norm, 0.0, 1.0)
        as_uint8 = (norm * 255 + 0.5).astype(np.uint8)
        im = Image.fromarray(as_uint8, mode="L").rotate(
            -angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=0
        )
        back = np.array(im).astype(np.float32) / 255.0
        rotated = (back * (rec.raw_max - rec.raw_min) + rec.raw_min)
        rotated = rotated.astype(rec.src.dtype if not is_high_bit else np.float32)
    rec.src = rotated
    return _upload_response(image_id, rec)


def _upload_response(image_id: str, rec: ImageRecord) -> UploadResponse:
    """Re-derive an UploadResponse from a (possibly mutated) record."""
    h, w = rec.src.shape
    bit_depth = (
        16 if rec.src.dtype in (np.uint16, np.int16)
        else 32 if rec.src.dtype in (np.float32, np.float64, np.int32, np.uint32)
        else 8
    )
    p995 = float(np.percentile(rec.src, 99.5))
    initial_max = max(p995, rec.raw_min + 1.0)
    return UploadResponse(
        image_id=image_id, width=w, height=h, filename=rec.filename,
        raw_min=rec.raw_min, raw_max=rec.raw_max, bit_depth=bit_depth,
        initial_lut={"min": rec.raw_min, "max": initial_max, "gamma": 1.0},
    )


@app.get("/api/image/{image_id}/saturation.png")
def saturation_overlay(
    image_id: str,
    threshold: float = 0.995,
    lut_max: float = -1.0,
) -> Response:
    """Return a transparent PNG marking pixels at or above the saturation
    threshold in red, used as an SVG overlay on the gel.

    The threshold is interpreted RELATIVE TO THE SOURCE RAW RANGE
    (raw_min..raw_max), not the LUT preview range. We want to mark
    pixels that are TRULY clipped by the imager — i.e. the band cores
    at the top of the dynamic range — not pixels that just look bright
    after a tightly auto-stretched LUT. With default threshold = 0.995
    on an 8-bit source this means raw value ≥ ~253.7, which on a
    typical Bio-Rad gel TIF catches only the band-core white pixels
    and the imager-baked red highlight contour. No morphological
    dilation / fill is applied: those expanded the mask far beyond the
    actual clipped pixels (a 4-pixel dilate-fill-erode cycle on a
    sparse contour grew it ~6× and made the overlay read as
    "overactive"). The `lut_max` parameter is ignored — it was an
    earlier experiment that turned out to over-mark on auto-stretched
    LUTs and is preserved only for URL-stability.
    """
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    cutoff = rec.raw_min + threshold * (rec.raw_max - rec.raw_min)
    sat = (rec.src.astype(np.float32) >= cutoff).astype(np.uint8)
    h, w = sat.shape
    # Build an RGBA image: transparent everywhere except red where sat=1.
    # Alpha 230/255 reads as a clear red over both dark gel content
    # and bright clipped pixels.
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = 220                  # R
    rgba[..., 3] = sat * 230            # A: solidly red where saturated
    im = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO(); im.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.get("/api/image/{image_id}/histogram")
def histogram(image_id: str, bins: int = 128) -> JSONResponse:
    """Return a histogram of the source array's intensity distribution.

    Used by the LUT popover to draw the typical "histogram + curve" UI the
    user sees in ImageJ/Fiji or microscope-software LUT panels. We bin
    over the FULL [raw_min, raw_max] range so the histogram axis matches
    the LUT min/max sliders 1:1.

    `bins` defaults to 128 — fine resolution for an interactive graph
    without paying the cost of binning into thousands of buckets.
    """
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    bins = int(max(8, min(512, bins)))
    counts, edges = np.histogram(rec.src, bins=bins, range=(rec.raw_min, rec.raw_max))
    return JSONResponse({
        "bins": counts.tolist(),
        "edges": edges.tolist(),
        "raw_min": float(rec.raw_min),
        "raw_max": float(rec.raw_max),
    })


@app.get("/api/image/{image_id}/info")
def image_info(image_id: str) -> JSONResponse:
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    h, w = rec.src.shape
    return JSONResponse({
        "image_id": image_id,
        "filename": rec.filename,
        "width": w,
        "height": h,
        "raw_min": rec.raw_min,
        "raw_max": rec.raw_max,
    })


# ── Auto-detect ladder bands ──────────────────────────────────────────


def _find_peaks(x: np.ndarray, prominence_frac: float = 0.03, min_dist: int = 5) -> list[int]:
    """Pure-numpy peak finder. Returns indices of local maxima in `x` whose
    prominence (height above the lowest valley to the nearest higher peak
    or signal edge) exceeds `prominence_frac × dynamic_range`. Enforces
    `min_dist` separation by greedily keeping the most-prominent peak in
    any cluster.

    Avoids the scipy dependency — numpy is already required for image
    handling, and this app only needs ~10 peaks per call.
    """
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if n < 3:
        return []
    # Local maxima: strict > on the left, ≥ on the right (handles flat tops)
    is_peak = np.zeros(n, dtype=bool)
    is_peak[1:-1] = (x[1:-1] > x[:-2]) & (x[1:-1] >= x[2:])
    indices = np.flatnonzero(is_peak)
    if indices.size == 0:
        return []
    threshold = (x.max() - x.min()) * prominence_frac
    proms: list[float] = []
    for idx in indices:
        h = x[idx]
        # Walk left until we hit a higher value (or edge) — track the lowest
        # value seen. That low is the "left base". Same on the right. The
        # peak's prominence is its height above the higher of the two bases.
        left_min = h
        i = idx - 1
        while i >= 0 and x[i] <= h:
            left_min = min(left_min, x[i])
            i -= 1
        right_min = h
        i = idx + 1
        while i < n and x[i] <= h:
            right_min = min(right_min, x[i])
            i += 1
        proms.append(h - max(left_min, right_min))
    proms_arr = np.asarray(proms)
    keep = proms_arr >= threshold
    indices = indices[keep]
    proms_arr = proms_arr[keep]
    if indices.size == 0:
        return []
    # Greedy min-distance enforcement: highest-prominence peak first
    order = np.argsort(-proms_arr)
    selected: list[int] = []
    for k in order:
        i = int(indices[k])
        if all(abs(i - s) >= min_dist for s in selected):
            selected.append(i)
    selected.sort()
    return selected


class DetectBandsRequest(BaseModel):
    lane_x_left: float
    lane_x_right: float
    lane_y_top: float
    lane_y_bot: float
    top_n: Optional[int] = None
    invert: bool = True            # gel features are typically dark → invert so peaks = bands
    min_distance: int = 5          # min pixel separation between detected peaks
    prominence_frac: float = 0.03  # peak must rise ≥ this × dynamic range above local valley


class DetectedBand(BaseModel):
    y: float


class DetectBandsResponse(BaseModel):
    bands: list[DetectedBand]      # sorted bottom-up (largest y first)


@app.post("/api/image/{image_id}/detect-bands", response_model=DetectBandsResponse)
def detect_bands(image_id: str, req: DetectBandsRequest) -> DetectBandsResponse:
    """Detect band y-positions inside a lane region by collapsing the lane
    to a 1-D vertical intensity profile and finding peaks.

    The lane region is the user's analysis region cropped to one ladder
    lane. With `invert=True` (default), dark bands become high values in
    the profile so peak finding maps directly to band centers.
    """
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    h, w = rec.src.shape
    x0 = max(0, int(req.lane_x_left))
    x1 = min(w, int(req.lane_x_right))
    y0 = max(0, int(req.lane_y_top))
    y1 = min(h, int(req.lane_y_bot))
    if x1 <= x0 + 1 or y1 <= y0 + 2:
        return DetectBandsResponse(bands=[])
    crop = rec.src[y0:y1, x0:x1].astype(np.float32)
    profile = crop.mean(axis=1)
    if req.invert:
        profile = -profile
    # 5-tap moving average to suppress single-pixel noise without smearing
    # band centers more than ~2 px.
    if profile.size >= 5:
        kernel = np.ones(5, dtype=np.float32) / 5.0
        profile = np.convolve(profile, kernel, mode="same")
    peaks = _find_peaks(
        profile,
        prominence_frac=float(req.prominence_frac),
        min_dist=int(req.min_distance),
    )
    band_ys = [float(y0 + p) for p in peaks]
    band_ys.sort(reverse=True)  # bottom-up: largest image-y first
    if req.top_n is not None:
        band_ys = band_ys[: int(req.top_n)]
    return DetectBandsResponse(bands=[DetectedBand(y=y) for y in band_ys])


# ── fEMSA quantification ──────────────────────────────────────────────
#
# These two endpoints are the only path in the app that reads raw pixel
# VALUES rather than deriving a picture from them. They deliberately do
# not accept LUT parameters: see gel_annotator/server/quant.py for why.


@app.post("/api/image/{image_id}/quantify", response_model=_quant.QuantResponse)
def quantify_rois(image_id: str, req: _quant.QuantRequest) -> _quant.QuantResponse:
    """Integrate raw intensity over a batch of ROIs.

    Batched rather than one-ROI-per-request because a 12-lane titration
    with a free row, a bound row, and two background rows is 48 ROIs —
    48 round-trips would make the Measure button feel broken even on
    loopback.
    """
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    if len(req.rois) > 4096:
        raise HTTPException(400, f"Too many ROIs ({len(req.rois)}); limit is 4096.")
    return _quant.quantify(rec.src, rec.raw_min, rec.raw_max, req)


@app.post("/api/image/{image_id}/profile", response_model=_quant.ProfileResponse)
def raw_profile(image_id: str, req: _quant.ProfileRequest) -> _quant.ProfileResponse:
    """Vertical raw-intensity profile of a rectangle, for row placement."""
    rec = _IMAGES.get(image_id)
    if rec is None:
        raise HTTPException(404, "Unknown image_id.")
    return _quant.lane_profile(rec.src, req)


# ── Health ────────────────────────────────────────────────────────────


@app.get("/healthz")
def healthz() -> JSONResponse:
    """Liveness probe used by the CLI's single-instance check + browser-
    open ready-poll. Returns ``{"status": "ok", "version": <pkg-ver>}``."""
    return JSONResponse({"status": "ok", "version": __version__})


@app.get("/health")
def health() -> JSONResponse:
    """Alias for /healthz so legacy probes keep working."""
    return JSONResponse({"status": "ok", "version": __version__})


@app.get("/api/autoload")
def autoload() -> JSONResponse:
    """If the CLI was invoked with ``slots <path>``, the file path was
    written to ``$SLOTS_AUTOLOAD``. The frontend polls this endpoint
    once at startup and offers to load the file automatically."""
    import os
    p = os.environ.get("SLOTS_AUTOLOAD") or ""
    if p and Path(p).exists():
        return JSONResponse({"path": p, "filename": Path(p).name})
    return JSONResponse({"path": None, "filename": None})


# ── Static frontend ───────────────────────────────────────────────────

_FRONTEND = Path(__file__).resolve().parents[1] / "frontend"

if _FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=_FRONTEND), name="static")


def _asset_tag(name: str) -> str:
    """Short content-derived cache-buster for a frontend asset.

    Upstream hand-maintains the ``?v=`` strings on the <script> and
    <link> tags in index.html. That is a footgun: edit app.js or
    quant.js without also editing the version string, and every browser
    that has the page cached keeps running the OLD file. The failure is
    silent and looks exactly like a broken feature — the button is
    there, the click does nothing, and the source on disk is correct.

    Hashing size + mtime means the tag changes whenever the file does,
    with no bookkeeping. Falls back to the package version if the file
    is missing so a stale tag can never 500 the page.
    """
    try:
        stat = (_FRONTEND / name).stat()
        seed = f"{name}:{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return __version__
    import hashlib
    return hashlib.sha1(seed.encode()).hexdigest()[:10]


_ASSET_RE = re.compile(r'(?P<attr>href|src)="/(?P<file>app\.js|quant\.js|style\.css)\?v=[^"]*"')


@app.get("/")
def index() -> Response:
    """Serve the single-page frontend with the running version injected.

    The Info panel and the package-info dialog read ``window.SLOTS_VERSION``;
    we splice a one-line ``<script>`` tag into the head so the value
    matches whatever's installed RIGHT NOW (not whatever was current at
    the time the HTML was written). Cheap regex-style insertion — the
    HTML never contains the literal token outside this site.

    Asset ``?v=`` tags are rewritten from file content on the way out —
    see :func:`_asset_tag`.
    """
    html = (_FRONTEND / "index.html").read_text(encoding="utf-8")
    html = _ASSET_RE.sub(
        lambda m: f'{m.group("attr")}="/{m.group("file")}?v={_asset_tag(m.group("file"))}"',
        html,
    )
    inject = (
        f'<script>window.SLOTS_VERSION = "{__version__}";</script>'
    )
    # Place the script immediately before the closing </head>. If for
    # any reason the marker isn't there (broken edit), fall back to the
    # un-templated file so the user still gets SOMETHING.
    if "</head>" in html:
        html = html.replace("</head>", inject + "</head>", 1)
    return Response(content=html, media_type="text/html")


@app.get("/app.js")
def app_js() -> FileResponse:
    return FileResponse(_FRONTEND / "app.js", media_type="application/javascript")


@app.get("/quant.js")
def quant_js() -> FileResponse:
    return FileResponse(_FRONTEND / "quant.js", media_type="application/javascript")


@app.get("/style.css")
def style_css() -> FileResponse:
    return FileResponse(_FRONTEND / "style.css", media_type="text/css")


# ── Favicon ──────────────────────────────────────────────────────────
#
# Serves the user-supplied PNG favicon from gel_annotator/assets/. If
# the asset is missing we return a transparent 1×1 PNG so the browser
# tab still gets *something* — better than a 404 in DevTools.

_ASSETS_DIR = Path(__file__).resolve().parents[1] / "assets"


@app.get("/favicon.ico")
def favicon_ico() -> Response:
    """Serve the .ico favicon, or the 192-pixel PNG as a fallback."""
    ico = _ASSETS_DIR / "icon.ico"
    if ico.exists():
        return FileResponse(ico, media_type="image/vnd.microsoft.icon")
    png = _ASSETS_DIR / "icon-192.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    # Fall back to a tiny transparent PNG so we don't 404. The bytes
    # below are a base64-decoded 1×1 transparent PNG.
    import base64
    blob = base64.b64decode(
        b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAA"
        b"SUVORK5CYII="
    )
    return Response(content=blob, media_type="image/png")


@app.get("/favicon.png")
def favicon_png() -> Response:
    """High-res PNG favicon — used by browsers' bookmark UIs and by
    the in-app toolbar logo `<img src="/favicon.png">`. Prefers the
    transparent-background variants so the toolbar logo sits cleanly
    on the dark header without a white square around it. Falls back
    to the opaque versions if the transparent ones aren't present
    (e.g. during a fresh install before assets are regenerated)."""
    for name in (
        "icon-192-transparent.png",
        "icon-512-transparent.png",
        "android-chrome-192x192-transparent.png",
        "icon-192.png",
        "icon-512.png",
        "android-chrome-192x192.png",
        "favicon-32x32.png",
        "favicon-16x16.png",
    ):
        candidate = _ASSETS_DIR / name
        if candidate.exists():
            return FileResponse(candidate, media_type="image/png")
    # No PNG variant found — fall back to the .ico handler which has
    # its own transparent-pixel fallback.
    return favicon_ico()
