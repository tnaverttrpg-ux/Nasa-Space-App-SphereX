"""Difference display contrast (scale_sigma) is display-only: statistics and candidates never depend on it."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import fitsproc, main


def pair():
    rng = np.random.default_rng(11)
    a = rng.normal(10, 1, (60, 60)).astype("float32")
    b = a + rng.normal(0, 0.3, a.shape).astype("float32")
    a[30, 20] += 40; b[30, 24] += 40           # a source that "moved" 4 px
    a[10, 50] += 15                             # a source that brightened
    foot = np.ones(a.shape, bool)
    w, _ = fitsproc.grid_wcs(150.0, 2.0, 60 * fitsproc.GRID_SCALE_DEG)
    return a, b, foot, w


SCI = ("noise_sigma", "overlap_fraction", "flux_scale_b_to_a", "registration_offset_px", "candidates", "n_candidates_total")


@pytest.mark.parametrize("scale", [1.0, 2.5, 5.0, 12.0, 50.0])
def test_statistics_and_candidates_independent_of_display_contrast(scale):
    a, b, foot, w = pair()
    ref = fitsproc.difference(a, foot, b, foot, w)
    out = fitsproc.difference(a, foot, b, foot, w, scale_sigma=scale)
    for k in SCI:
        assert out[k] == ref[k], k
    assert (out["png"] == ref["png"]) == (scale == 5.0)   # only the picture changes


def test_default_is_five_sigma_and_threshold_still_controls_candidates():
    a, b, foot, w = pair()
    assert fitsproc.difference(a, foot, b, foot, w)["png"] == fitsproc.difference(a, foot, b, foot, w, scale_sigma=5.0)["png"]
    lo = fitsproc.difference(a, foot, b, foot, w, nsig=3.0, scale_sigma=20.0)
    hi = fitsproc.difference(a, foot, b, foot, w, nsig=10.0, scale_sigma=20.0)
    assert lo["n_candidates_total"] >= hi["n_candidates_total"] and lo["noise_sigma"] == hi["noise_sigma"]


def test_endpoint_reports_display_scale_and_validates(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "GRIDS", tmp_path)
    a, b, foot, w = pair()
    meta = {"grid": {"ra": 150.0, "dec": 2.0, "fov": 60 * fitsproc.GRID_SCALE_DEG}, "demo": False}
    main._save("ka", a, foot, meta); main._save("kb", b, foot, meta)
    c = TestClient(main.app)
    d5, d12 = c.get("/api/diff?a=ka&b=kb").json(), c.get("/api/diff?a=ka&b=kb&scale_sigma=12").json()
    assert d5["display_scale_sigma"] == 5.0 and d12["display_scale_sigma"] == 12.0 and d5["detection_nsig"] == 5.0
    assert all(d5[k] == d12[k] for k in SCI) and d5["png"] != d12["png"]
    assert c.get("/api/diff?a=ka&b=kb&scale_sigma=0.5").status_code == 422
    assert c.get("/api/diff?a=ka&b=kb&scale_sigma=99").status_code == 422
