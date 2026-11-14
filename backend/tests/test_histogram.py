"""Histogram/statistics endpoint and the display_limits refactor (render output must be byte-identical)."""
import io

import numpy as np
import pytest
from astropy.visualization import AsinhStretch, LinearStretch
from fastapi.testclient import TestClient
from matplotlib import colormaps

from app import fitsproc, main


def old_limits(arr):
    """Frozen copy of the limit code that lived inline in render() before the refactor."""
    a = np.array(arr, dtype="float64")
    good = np.isfinite(a)
    if good.sum() < 4:
        return None
    med, sig = fitsproc._robust(a)
    lo, hi = med - 2 * sig, float(np.percentile(a[good], 99.7))
    if hi <= lo:
        hi = lo + 1
    return lo, hi


def old_render(arr, stretch="asinh", cmap="inferno", offdet=None):
    """Frozen copy of render() before the refactor."""
    a = np.array(arr, dtype="float64")
    good = np.isfinite(a)
    if good.sum() < 4:
        norm = np.zeros_like(a)
    else:
        med, sig = fitsproc._robust(a)
        lo, hi = med - 2 * sig, float(np.percentile(a[good], 99.7))
        if hi <= lo:
            hi = lo + 1
        norm = np.clip((np.where(good, a, lo) - lo) / (hi - lo), 0, 1)
        norm = (AsinhStretch(0.1) if stretch == "asinh" else LinearStretch())(norm)
    rgb = (colormaps[cmap](norm)[..., :3] * 255).astype("uint8")
    fitsproc._paint_no_data(rgb, good, offdet)
    return fitsproc._png(np.flipud(rgb))


def arrays():
    rng = np.random.default_rng(7)
    sky = rng.normal(10, 1, (40, 40)); sky[5, 5] = 900; sky[0:3] = np.nan          # stars + no-data rows
    yield sky
    yield np.full((20, 20), 3.0)                                                     # constant (hi <= lo branch)
    x = np.full((10, 10), np.nan); x[0, :3] = 1.0; yield x                           # < 4 finite pixels
    y = rng.normal(0, 1, (30, 30)); y[1, 1] = np.inf; y[2, 2] = -np.inf; yield y   # infinities
    yield np.full((8, 8), np.nan)                                                   # nothing finite


@pytest.mark.parametrize("i", range(5))
def test_display_limits_identical_to_previous_inline_code(i):
    a = list(arrays())[i]
    old, new = old_limits(a), fitsproc.display_limits(a)
    assert (old is None and new is None) or (old == new)


@pytest.mark.parametrize("stretch", ["asinh", "linear"])
@pytest.mark.parametrize("cmap", ["inferno", "gray"])
def test_rendered_png_byte_identical_after_refactor(stretch, cmap):
    for a in arrays():
        off = np.zeros(a.shape, bool); off[:2] = ~np.isfinite(a[:2])
        assert fitsproc.render(a, stretch, cmap) == old_render(a, stretch, cmap)
        assert fitsproc.render(a, stretch, cmap, off) == old_render(a, stretch, cmap, off)


def grid():
    rng = np.random.default_rng(1)
    a = rng.normal(5, 2, (50, 50)).astype("float32")
    foot = np.ones(a.shape, bool)
    off = np.zeros(a.shape, bool)
    a[:10] = np.nan; off[:10] = True                 # off-detector band (NaN, as in real grids)
    a[20, 20:25] = np.nan; foot[20, 20:25] = False   # flagged pixels (NaN, outside footprint)
    a[30, 30] = np.inf                               # non-finite value inside the field
    foot[40, 0:3] = False                            # finite but outside the footprint -> excluded too
    return a, foot, off


def test_valid_pixel_selection_and_exclusions():
    a, foot, off = grid()
    s = fitsproc.grid_stats(a, foot, off)
    expected = np.isfinite(a) & foot & ~off
    assert s["n_valid"] == int(expected.sum()) == 2500 - 500 - 5 - 1 - 3
    assert s["n_off_detector"] == 500
    assert s["n_masked_or_invalid"] == 5 + 1 + 3
    assert s["n_valid"] + s["n_off_detector"] + s["n_masked_or_invalid"] == s["n_grid"]


def test_histogram_bins_and_conservation():
    a, foot, off = grid()
    s = fitsproc.grid_stats(a, foot, off)
    h = s["histogram"]
    assert len(h["counts"]) == 128 and len(h["edges"]) == 129 and np.all(np.diff(h["edges"]) > 0)
    assert sum(h["counts"]) + h["underflow"] + h["overflow"] == s["n_valid"]   # every valid pixel accounted for


def test_statistical_values_match_numpy_on_valid_pixels():
    a, foot, off = grid()
    s = fitsproc.grid_stats(a, foot, off)
    v = a[np.isfinite(a) & foot & ~off].astype("float64")
    st = s["stats"]
    assert st["mean"] == pytest.approx(v.mean()) and st["median"] == pytest.approx(np.median(v))
    assert st["robust_sigma"] == pytest.approx(1.4826 * np.median(np.abs(v - np.median(v))))
    for p in (1, 5, 50, 95, 99, 99.7):
        assert st["percentiles"][str(p)] == pytest.approx(np.percentile(v, p))
    assert np.isfinite(list(st["percentiles"].values())).all()


def test_display_limits_reported_are_the_render_limits():
    a, foot, off = grid()
    s = fitsproc.grid_stats(a, foot, off)
    assert (s["display_limits"]["min"], s["display_limits"]["max"]) == fitsproc.display_limits(a)


def test_empty_valid_data():
    a = np.full((16, 16), np.nan, "float32")
    s = fitsproc.grid_stats(a, np.zeros(a.shape, bool), np.ones(a.shape, bool))
    assert s["n_valid"] == 0 and s["stats"] is None and s["histogram"] is None and s["display_limits"] is None


def test_constant_image_histogram_has_finite_width():
    a = np.full((10, 10), 4.0, "float32")
    h = fitsproc.grid_stats(a, np.ones(a.shape, bool))["histogram"]
    assert h["edges"][-1] > h["edges"][0] and sum(h["counts"]) == 100


def test_stats_endpoint_structure_errors_and_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "GRIDS", tmp_path)
    main._stats_cached.cache_clear()
    a, foot, off = grid()
    main._save("abc123", a, foot, {"bunit": "MJy / sr", "demo": False}, off)
    c = TestClient(main.app)
    r = c.get("/api/frame/abc123/stats")
    j = r.json()
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"   # method-dependent: not browser-cached
    assert j["unit"] == "MJy / sr" and j["quantity"] == "aligned-grid surface brightness" and j["calibrated_photometry"] is False
    assert j["n_valid"] == fitsproc.grid_stats(a, foot, off)["n_valid"]
    c.get("/api/frame/abc123/stats")
    assert main._stats_cached.cache_info().hits >= 1                     # computed once per grid key
    assert c.get("/api/frame/nothere/stats").status_code == 404
    assert c.get("/api/frame/bad.key/stats").status_code in (400, 404)
    main._stats_cached.cache_clear()
