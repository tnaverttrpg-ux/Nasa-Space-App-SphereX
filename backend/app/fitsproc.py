"""FITS parsing, WCS reprojection onto a common grid, rendering and difference imaging."""
import io
import warnings

import matplotlib
matplotlib.use("Agg")
from matplotlib import colormaps
import numpy as np
from astropy import log
from astropy.io import fits
from astropy.time import Time
from astropy.visualization import AsinhStretch, LinearStretch
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_scales
from PIL import Image
from reproject import reproject_interp

log.setLevel("WARNING")
warnings.simplefilter("ignore", FITSFixedWarning)

MASK_RGB = (118, 120, 124)     # flagged/invalid observed pixels: light neutral grey
OFFDET_RGB = (46, 47, 50)      # never observed (outside the detector): dark neutral grey ...
OFFDET_HATCH = (66, 68, 72)    # ... with a fine diagonal hatch so it never reads as dark sky
# v3: adds the off-detector mask and detector position (display metadata only; science arrays unchanged).
# v4: adds pipeline QA metadata (header values + STREAK pixels in the displayed field); science arrays unchanged.
PROC_VERSION = 4  # bump when processing changes; invalidates cached grids
DETECTOR_ACTIVE_PX = 2040      # SPHEREx L2 active area (NAXIS1/2 of the full-frame IMAGE HDU)
GRID_SCALE_DEG = 6.15 / 3600  # nominal SPHEREx pixel scale
# Pixels with these flag planes are unusable for comparison. SOURCE/GHOST/HALO etc. are reported, not masked.
BAD_PLANES = {"TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD", "PERSIST", "OUTLIER"}


def grid_wcs(ra, dec, fov):
    """North-up, east-left TAN grid shared by every frame of a series."""
    n = max(8, int(np.ceil(fov / GRID_SCALE_DEG)))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-GRID_SCALE_DEG, GRID_SCALE_DEG]
    return w, (n, n)


def science_hdu(hdul):
    """Find the science image: prefer a named science extension, else first 2-D HDU with celestial WCS."""
    for name in ("IMAGE", "SCI", "SCIENCE"):
        if name in hdul and getattr(hdul[name], "data", None) is not None and hdul[name].data.ndim == 2:
            return hdul[name]
    for h in hdul:
        if isinstance(h, (fits.PrimaryHDU, fits.ImageHDU)) and h.data is not None and h.data.ndim == 2:
            if WCS(h.header).has_celestial:
                return h
    raise ValueError("no 2-D science image with a celestial WCS found")


def detector_position(hdr, wcs, ra, dec, shape):
    """Target position on the detector from the pipeline's alternate WCS 'A' ("0-based active pixel coordinates").
    Returns None unless that WCS is present and the whole cutout maps inside the active area (so the value is exact,
    not an estimate)."""
    try:
        if not str(hdr.get("WCSNAMEA", "")).strip().lower().startswith("0-based active pixel"):
            return None
        # Apply 'A' exactly as declared: a pure LINEAR offset. Not via astropy WCS(key="A"), which would also attach the
        # header's (key-less) SIP distortion terms and shift the result by ~10-20 px.
        if any(str(hdr.get(f"CTYPE{i}A", "")).strip().upper() != "LINEAR" for i in (1, 2)) or \
           any(f"PC{i}_{j}A" in hdr or f"CD{i}_{j}A" in hdr for i in (1, 2) for j in (1, 2)):
            return None
        lin = lambda p, i: (p + 1 - float(hdr[f"CRPIX{i}A"])) * float(hdr.get(f"CDELT{i}A", 1.0)) + float(hdr.get(f"CRVAL{i}A", 0.0))
        ny, nx = shape
        n = DETECTOR_ACTIVE_PX
        cx0, cx1, cy0, cy1 = lin(0, 1), lin(nx - 1, 1), lin(0, 2), lin(ny - 1, 2)
        x, y = wcs.world_to_pixel_values(ra, dec)
        dx, dy = lin(float(x), 1), lin(float(y), 2)
        vals = [cx0, cx1, cy0, cy1, dx, dy]
        if not all(np.isfinite(vals)) or min(vals) < 0 or max(vals) > n - 1:
            return None
        return {"x": round(dx, 1), "y": round(dy, 1), "edge_px": round(min(dx, dy, n - 1 - dx, n - 1 - dy), 1), "active_size": n}
    except Exception:
        return None


def _qa_str(hdr, key):
    v = hdr.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def _qa_count(hdr, key):
    v = hdr.get(key)
    return int(v) if isinstance(v, (int, np.integer)) and not isinstance(v, bool) and v >= 0 else None


def pipeline_qa(hdr, flags, flag_hdr, wcs, target, grid_shape):
    """Pipeline QA as recorded in the FITS headers (no interpretation), plus STREAK-flagged native pixels whose centres
    fall inside the displayed field. Header counts are detector-wide; the field count is computed from FLAGS.
    Any absent/invalid value is None ("Unavailable")."""
    qa = {
        "l1_dqa": _qa_str(hdr, "L1DQAFLG"),
        "l2_dqa": _qa_str(hdr, "L2DQAFLG"),
        "detector_streaks": _qa_count(hdr, "L2 SATSTRKS"),          # HIERARCH L2 SATSTRKS: whole detector
        "detector_streak_pixels": _qa_count(hdr, "L2 SATSTRKS_PXS"),  # HIERARCH L2 SATSTRKS_PXS: whole detector
        "field_streak_pixels": None,
    }
    if flags is None or flag_hdr is None:
        return qa
    planes = {str(flag_hdr[k]).strip(): k[4:] for k in flag_hdr if k.startswith("MSKN")}
    if "STREAK" not in planes or not planes["STREAK"].isdigit():
        return qa
    ys, xs = np.nonzero(flags & (1 << int(planes["STREAK"])))
    if len(xs) == 0:
        qa["field_streak_pixels"] = 0
        return qa
    with np.errstate(all="ignore"):
        gx, gy = target.world_to_pixel_values(*wcs.pixel_to_world_values(xs, ys))
    n_y, n_x = grid_shape
    qa["field_streak_pixels"] = int(np.count_nonzero(np.isfinite(gx) & np.isfinite(gy) & (gx >= -0.5) & (gx <= n_x - 0.5) & (gy >= -0.5) & (gy <= n_y - 0.5)))
    return qa


def off_detector_mask(wcs, shape, target, grid_shape, arr):
    """Grid pixels whose centre falls outside the retrieved cutout. The cutout box is 1.5x the field, which covers the
    grid at any rotation, so within the grid this only happens where IRSA clipped the cutout at the detector edge.
    Only pixels that are already NaN can be flagged: data are never recoloured."""
    ny, nx = shape
    yy, xx = np.mgrid[0:grid_shape[0], 0:grid_shape[1]]
    with np.errstate(all="ignore"):
        sky = target.pixel_to_world_values(xx.ravel(), yy.ravel())
        px, py = wcs.world_to_pixel_values(*sky)
    px, py = np.asarray(px).reshape(grid_shape), np.asarray(py).reshape(grid_shape)
    inside = np.isfinite(px) & np.isfinite(py) & (px >= 0) & (px <= nx - 1) & (py >= 0) & (py <= ny - 1)
    return ~inside & ~np.isfinite(arr)


def process_cutout(fits_bytes, ra, dec, fov):
    """Return (grid image, footprint, measured metadata, off-detector mask) for one SPHEREx cutout."""
    with fits.open(io.BytesIO(fits_bytes)) as hdul:
        hdu = science_hdu(hdul)
        hdr = hdu.header
        wcs = WCS(hdr).celestial
        data = hdu.data.astype("float64")
        flag_counts, masked = None, 0
        fh = fl = None
        if "FLAGS" in hdul:
            fh, fl = hdul["FLAGS"].header, hdul["FLAGS"].data.astype("int64")
            # Plane names come from the header (MSKNnnnn), so bit numbering is never assumed.
            planes = {str(fh[k]).strip(): int(k[4:]) for k in fh if k.startswith("MSKN")}
            flag_counts = {n: int(np.count_nonzero(fl & (1 << b))) for n, b in planes.items()}
            flag_counts = {n: c for n, c in flag_counts.items() if c}
            bad = np.zeros(fl.shape, bool)
            for n in BAD_PLANES & planes.keys():
                bad |= (fl & (1 << planes[n])) != 0
            masked = int(bad.sum())
            data[bad] = np.nan
        wave = None
        try:  # SPHEREx is a linear-variable-filter imager: wavelength varies across the detector
            ww = WCS(hdr, fobj=hdul, key="W")
            x, y = wcs.world_to_pixel_values(ra, dec)
            lam, dlam = ww.pixel_to_world_values(x, y)
            if np.isfinite(lam):
                wave = {"center_um": round(float(lam), 4), "width_um": round(float(dlam), 4)}
        except Exception:
            pass

        target, shape = grid_wcs(ra, dec, fov)
        arr, foot = reproject_interp((data, wcs), target, shape_out=shape)
        offdet = off_detector_mask(wcs, data.shape, target, shape, arr)
        qa = pipeline_qa(hdr, fl, fh, wcs, target, shape)

        date = hdr.get("DATE-AVG") or hdr.get("DATE-OBS")
        mjd = hdr.get("MJD-AVG") or hdr.get("MJD-OBS")
        if mjd is None and date:
            mjd = Time(date, scale="utc").mjd
        scale = proj_plane_pixel_scales(wcs) * 3600
        cd = wcs.pixel_scale_matrix
        meta = {
            "hdu": hdu.name or "PRIMARY",
            "date_obs": date,
            "date_beg": hdr.get("DATE-BEG"),
            "date_end": hdr.get("DATE-END"),
            "mjd": float(mjd) if mjd is not None else None,
            "decimal_year": float(Time(mjd, format="mjd").decimalyear) if mjd is not None else None,
            "detector": hdr.get("DETECTOR"),
            "obsid": hdr.get("OBSID"),
            "bunit": hdr.get("BUNIT"),
            "native_pixscale_arcsec": round(float(scale.mean()), 3),
            "native_rotation_deg": round(float(np.degrees(np.arctan2(cd[1, 0], cd[1, 1]))), 2),
            "native_shape": list(data.shape),
            "wavelength_at_target": wave,
            "flag_counts": flag_counts,
            "masked_pixels": masked,
            "coverage_fraction": round(float(np.mean(foot > 0.5)), 3),
            "off_detector_fraction": round(float(offdet.mean()), 3),
            "detector_position": detector_position(hdr, wcs, ra, dec, data.shape),
            "pipeline_qa": qa,
            "pipeline_version": hdul[0].header.get("VERSION"),
        }
    return arr.astype("float32"), (foot > 0.5), meta, offdet


def _robust(a):
    v = a[np.isfinite(a)]
    if v.size == 0:
        return 0.0, 1.0
    med = np.median(v)
    sig = 1.4826 * np.median(np.abs(v - med))
    return float(med), float(sig if sig > 0 else (np.std(v) or 1.0))


def _png(rgb):
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()


def _paint_no_data(rgb, good, offdet):
    """Flagged/invalid pixels light grey; never-observed (off-detector) pixels dark grey with a diagonal hatch.
    Operates in FITS row order (before the north-up flip)."""
    rgb[~good] = MASK_RGB
    if offdet is not None and offdet.shape == good.shape:
        yy, xx = np.indices(good.shape)
        hatch = ((xx + yy) % 6) == 0
        rgb[offdet] = OFFDET_RGB
        rgb[offdet & hatch] = OFFDET_HATCH


def render(arr, stretch="asinh", cmap="inferno", offdet=None):
    """ZScale + stretch -> PNG bytes. Row 0 is south in FITS, so flip for display (north up)."""
    a = np.array(arr, dtype="float64")
    good = np.isfinite(a)
    if good.sum() < 4:
        norm = np.zeros_like(a)
    else:
        med, sig = _robust(a)
        lo, hi = med - 2 * sig, float(np.percentile(a[good], 99.7))
        if hi <= lo:
            hi = lo + 1
        norm = np.clip((np.where(good, a, lo) - lo) / (hi - lo), 0, 1)
        norm = (AsinhStretch(0.1) if stretch == "asinh" else LinearStretch())(norm)
    rgb = (colormaps[cmap](norm)[..., :3] * 255).astype("uint8")
    _paint_no_data(rgb, good, offdet)
    return _png(np.flipud(rgb))


def _shift(a, b, window=4):
    """Residual global offset (b relative to a, display px) from cross-correlating point sources.
    Only shifts within +-window px are searched: WCS alignment should already be near-exact."""
    def pts(x):
        m, s = _robust(x)
        return np.nan_to_num(np.clip((x - m) / s, 0, 50) * ((x - m) > 5 * s))
    pa, pb = pts(a), pts(b)
    if not pa.any() or not pb.any():
        return None
    c = np.fft.ifft2(np.fft.fft2(pa) * np.conj(np.fft.fft2(pb))).real
    best, out = -np.inf, None
    for dy in range(-window, window + 1):
        for dx in range(-window, window + 1):
            if c[dy, dx] > best:
                best, out = c[dy, dx], (-dx, dy)  # display: x as-is, y flipped
    return out


def difference(a, fa, b, fb, wcs, nsig=5.0, max_cand=25, offdet=None):
    """A - B after per-frame background removal. Returns png, noise, registration offset, candidates.
    `offdet` (pixels off the detector in A or B) only changes how no-data pixels are drawn."""
    both = fa & fb
    a = np.where(both, a, np.nan)
    b = np.where(both, b, np.nan)
    a0, b0 = a - _robust(a)[0], b - _robust(b)[0]
    # Frames sample different wavelengths/calibrations: match flux scale on pixels bright in both.
    sa, sb = _robust(a0)[1], _robust(b0)[1]
    bright = (a0 > 10 * sa) & (b0 > 10 * sb)
    k = float(np.median(a0[bright] / b0[bright])) if bright.sum() >= 5 else 1.0
    d = a0 - k * b0
    _, sig = _robust(d)
    norm = np.clip(np.nan_to_num(d / (5 * sig)) * 0.5 + 0.5, 0, 1)
    rgb = (colormaps["coolwarm"](norm)[..., :3] * 255).astype("uint8")
    _paint_no_data(rgb, both, offdet)

    cand = []
    s = np.nan_to_num(np.abs(d) / sig)
    ny, nx = s.shape
    for y in range(2, ny - 2):
        for x in range(2, nx - 2):
            v = s[y, x]
            if v >= nsig and v == s[y - 1:y + 2, x - 1:x + 2].max() and both[y - 1:y + 2, x - 1:x + 2].all():
                r, dd = wcs.pixel_to_world_values(x, y)
                cand.append({"x": x, "y": ny - 1 - y, "ra": round(float(r), 6), "dec": round(float(dd), 6),
                             "snr": round(float(v), 1), "sign": "brighter_in_A" if d[y, x] > 0 else "brighter_in_B"})
    cand.sort(key=lambda c: -c["snr"])
    return {
        "png": _png(np.flipud(rgb)),
        "noise_sigma": sig,
        "overlap_fraction": round(float(both.mean()), 3),
        "flux_scale_b_to_a": round(k, 4),
        "registration_offset_px": _shift(a, b),
        "candidates": cand[:max_cand],
        "n_candidates_total": len(cand),
    }
