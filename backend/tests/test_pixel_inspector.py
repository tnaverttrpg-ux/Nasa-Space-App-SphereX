"""Pixel inspector: grid -> sky -> native (SIP-aware) -> detector (linear), classification, flags, cache, robustness."""
import io

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from fastapi.testclient import TestClient

from app import archive, fitsproc, main

RA, DEC, FOV = 150.0, 2.0, 0.05
URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/6/level2_test_D6_spx.fits"
X0, Y0 = 300, 0                       # cutout origin on the detector (WCS 'A' offset)
SIP = {"A_ORDER": 2, "B_ORDER": 2, "A_2_0": 6e-3, "A_0_2": 0.0, "A_1_1": 2e-3, "B_2_0": 0.0, "B_0_2": 5e-3, "B_1_1": 0.0}


def make_cutout(ny=70, target_row=35.5, with_flags=True, hot=None, with_wcs_a=True):
    """Synthetic SPHEREx-like cutout: TAN-SIP celestial WCS, key-less SIP terms, linear WCS 'A', FLAGS planes."""
    nx, s = 70, 6.15 / 3600
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]; w.wcs.crval = [RA, DEC]; w.wcs.crpix = [35.5, target_row]; w.wcs.cdelt = [-s, s]
    hdr = w.to_header()
    hdr.update({"CTYPE1": "RA---TAN-SIP", "CTYPE2": "DEC--TAN-SIP", **SIP})
    if with_wcs_a:
        hdr.update({"WCSAXESA": 2, "WCSNAMEA": "0-based active pixel coordinates", "CTYPE1A": "LINEAR", "CTYPE2A": "LINEAR",
                    "CRPIX1A": 1.0 - X0, "CRPIX2A": 1.0 - Y0, "CRVAL1A": 0.0, "CRVAL2A": 0.0, "CDELT1A": 1.0, "CDELT2A": 1.0})
    hdr["DATE-AVG"] = "2025-05-05T16:49:00"; hdr["MJD-AVG"] = 60800.7; hdr["DETECTOR"] = 6; hdr["BUNIT"] = "MJy / sr"
    img = (np.arange(nx * ny, dtype="float32").reshape(ny, nx) % 97) / 10 + 5      # distinct, finite values
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(img, header=hdr, name="IMAGE")]
    if with_flags:
        fl = np.zeros((ny, nx), "int32"); fl[:, :] |= 1 << 21                       # SOURCE everywhere (informational)
        if hot:
            fl[hot[1], hot[0]] |= 1 << 10                                              # HOT -> masked by the app
        fh = fits.Header(); fh["MSKN0010"] = "HOT"; fh["MSKN0021"] = "SOURCE"; fh["MSKN0000"] = "TRANSIENT"
        hdus.append(fits.ImageHDU(fl, header=fh, name="FLAGS"))
    buf = io.BytesIO(); fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()


@pytest.fixture
def env(monkeypatch, tmp_path):
    (tmp_path / "cutouts").mkdir(); (tmp_path / "grids").mkdir()
    monkeypatch.setattr(archive, "CACHE", tmp_path)
    monkeypatch.setattr(main, "GRIDS", tmp_path / "grids")
    main._cutouts.clear()

    def register(key, raw, store_cutout=True):
        arr, foot, meta, offdet = fitsproc.process_cutout(raw, RA, DEC, FOV)
        meta.update({"source_url": URL, "grid": {"ra": RA, "dec": DEC, "fov": FOV}, "demo": False})
        main._save(key, arr, foot, meta, offdet)
        if store_cutout:
            archive._cutout_path(URL, RA, DEC, main._cutout_size(FOV)).write_bytes(raw)
        return arr, foot, offdet
    yield register, TestClient(main.app)
    main._cutouts.clear()


def get(c, key, x, y):
    r = c.get(f"/api/frame/{key}/pixel?x={x}&y={y}"); assert r.status_code == 200, r.text; return r.json()


def test_grid_to_sky_matches_grid_wcs_and_north_up_orientation(env):
    register, c = env
    arr, *_ = register("k1", make_cutout())
    n = arr.shape[0]; gw, _ = fitsproc.grid_wcs(RA, DEC, FOV)
    for x, y in [(3, 4), (n // 2, n // 2), (n - 2, 1)]:
        j = get(c, "k1", x, y)
        ra, dec = gw.pixel_to_world_values(x, n - 1 - y)              # display y is from the top
        assert j["sky"]["ra"] == pytest.approx(float(ra), abs=1e-12) and j["sky"]["dec"] == pytest.approx(float(dec), abs=1e-12)
    top, bottom = get(c, "k1", 5, 0), get(c, "k1", 5, n - 1)
    assert top["sky"]["dec"] > bottom["sky"]["dec"]                    # north up


def test_native_lookup_is_distortion_aware_and_detector_is_linear(env):
    register, c = env
    raw = make_cutout(); register("k1", raw)
    hdr = fits.getheader(io.BytesIO(raw), "IMAGE"); w_sip = WCS(hdr).celestial
    w_lin = w_sip.deepcopy(); w_lin.sip = None
    j = get(c, "k1", 2, 2)                                             # corner: largest SIP effect
    ex, ey = w_sip.world_to_pixel_values(j["sky"]["ra"], j["sky"]["dec"])
    lx, ly = w_lin.world_to_pixel_values(j["sky"]["ra"], j["sky"]["dec"])
    assert j["native"]["x"] == pytest.approx(float(ex), abs=0.006) and j["native"]["y"] == pytest.approx(float(ey), abs=0.006)
    assert np.hypot(ex - lx, ey - ly) > 0.5                            # SIP genuinely matters here, and was applied
    d = j["detector"]                                                   # detector = native + linear offset, NO SIP
    assert d["x"] == pytest.approx(j["native"]["x"] + X0, abs=0.006) and d["y"] == pytest.approx(j["native"]["y"] + Y0, abs=0.006)
    assert d["ix"] == j["native"]["ix"] + X0 and d["iy"] == j["native"]["iy"] + Y0


def test_valid_pixel_reports_original_value_and_decoded_flags(env):
    register, c = env
    raw = make_cutout(); arr, *_ = register("k1", raw)
    n = arr.shape[0]
    j = get(c, "k1", n // 2, n // 2)
    img = fits.getdata(io.BytesIO(raw), "IMAGE")
    assert j["grid"]["state"] == "valid" and j["grid"]["value"] == pytest.approx(float(arr[n - 1 - n // 2, n // 2]))
    assert j["native"]["available"] and j["native"]["value"] == float(img[j["native"]["iy"], j["native"]["ix"]])
    assert j["native"]["flags"] == 1 << 21 and j["native"]["flag_names"] == ["SOURCE"] and j["native"]["masked_by_app"] is False


def test_masked_pixel_traced_to_flagged_native_pixel(env):
    register, c = env
    probe = make_cutout()
    arr0, *_ = register("probe", probe)
    n = arr0.shape[0]; j0 = get(c, "probe", n // 2 + 3, n // 2 - 2)
    hot = (j0["native"]["ix"], j0["native"]["iy"])
    main._cutouts.clear()
    raw = make_cutout(hot=hot); register("k2", raw)
    j = get(c, "k2", n // 2 + 3, n // 2 - 2)
    assert j["grid"]["state"] == "masked_or_invalid" and j["grid"]["value"] is None
    assert j["native"]["available"] and "HOT" in j["native"]["flag_names"] and j["native"]["masked_by_app"] is True
    assert j["native"]["value"] == float(fits.getdata(io.BytesIO(raw), "IMAGE")[hot[1], hot[0]])   # original value, not filled


def test_off_detector_pixel_has_no_native_pixel_and_is_not_clamped(env):
    register, c = env
    register("k3", make_cutout(ny=30, target_row=4.5))                 # cutout clipped at detector row 0
    _, _, meta, offdet = main._load("k3")
    rows, cols = np.nonzero(np.flipud(offdet))
    assert len(rows)
    j = get(c, "k3", int(cols[0]), int(rows[0]))
    assert j["grid"]["state"] == "off_detector" and j["grid"]["value"] is None
    assert j["native"]["available"] is False and "outside the detector" in j["native"]["reason"]
    assert j["detector"]["on_detector"] is False and j["detector"]["ix"] is None and j["detector"]["y"] < -0.5
    assert "value" not in j["native"] or j["native"].get("value") is None


def test_missing_cutout_returns_grid_only(env):
    register, c = env
    arr, *_ = register("k4", make_cutout(), store_cutout=False)
    j = get(c, "k4", 10, 10)
    assert j["sky"] is not None and j["grid"]["value"] is not None
    assert j["native"]["available"] is False and "not in the local cache" in j["native"]["reason"] and j["detector"] is None


def test_synthetic_demo_frame(env):
    _, c = env
    j = c.get("/api/frame/demo-0/pixel?x=5&y=5").json()
    assert j["demo"] is True and j["sky"] is None and j["native"]["available"] is False and "synthetic" in j["native"]["reason"]


def test_missing_flags_extension(env):
    register, c = env
    register("k5", make_cutout(with_flags=False))
    j = get(c, "k5", 15, 15)
    assert j["native"]["available"] and j["native"]["flags"] is None and j["native"]["flags_available"] is False
    assert j["native"]["flag_names"] is None and j["native"]["masked_by_app"] is None


def test_missing_detector_wcs_reports_no_detector_coordinates(env):
    register, c = env
    register("k6", make_cutout(with_wcs_a=False))
    j = get(c, "k6", 15, 15)
    assert j["native"]["available"] and j["detector"] is None


def test_invalid_coordinates_and_unknown_key(env):
    register, c = env
    arr, *_ = register("k1", make_cutout())
    n = arr.shape[0]
    assert c.get(f"/api/frame/k1/pixel?x={n}&y=0").status_code == 422
    assert c.get(f"/api/frame/k1/pixel?x=0&y={n}").status_code == 422
    assert c.get("/api/frame/k1/pixel?x=-1&y=0").status_code == 422
    assert c.get("/api/frame/k1/pixel?x=a&y=0").status_code == 422
    assert c.get("/api/frame/nope/pixel?x=0&y=0").status_code == 404


def test_non_finite_grid_values_are_never_reported_as_numbers():
    arr = np.full((5, 5), np.inf, "float32"); arr[0, 0] = np.nan
    for x, y in [(0, 4), (2, 2)]:
        j = fitsproc.inspect_pixel(x, y, arr, np.ones(arr.shape, bool), np.zeros(arr.shape, bool), None, None)
        assert j["grid"]["value"] is None and j["grid"]["value_finite"] is False and j["grid"]["state"] == "masked_or_invalid"


def test_cutout_cache_reuse_bound_and_corruption(env, monkeypatch):
    register, c = env
    raw = make_cutout(); register("k1", raw)
    reads = []
    real = archive.read_cached
    monkeypatch.setattr(archive, "read_cached", lambda p: reads.append(p) or real(p))
    for k in range(5):
        get(c, "k1", 10 + k, 10)
    assert len(reads) == 1                                              # parsed once, reused for later clicks
    monkeypatch.setattr(main, "CUTOUT_CACHE_MAX", 2)
    for i in range(4):
        main._cutouts[("fake", i, 0)] = {}
        with main._cutouts_lock:
            while len(main._cutouts) > main.CUTOUT_CACHE_MAX:
                main._cutouts.popitem(last=False)
    assert len(main._cutouts) <= 2
    main._cutouts.clear()
    p = archive._cutout_path(URL, RA, DEC, main._cutout_size(FOV))
    p.write_bytes(raw[:5000])                                           # corrupt cached cutout
    j = get(c, "k1", 10, 10)
    assert j["native"]["available"] is False and j["sky"] is not None   # graceful: grid-only, no crash


def test_inspection_does_not_modify_scientific_outputs(env):
    register, c = env
    raw = make_cutout(); arr, foot, offdet = register("k1", raw)
    before = (main.GRIDS / "k1.npz").read_bytes(), (main.GRIDS / "k1.json").read_bytes()
    for x, y in [(0, 0), (10, 12), (20, 3)]:
        get(c, "k1", x, y)
    assert ((main.GRIDS / "k1.npz").read_bytes(), (main.GRIDS / "k1.json").read_bytes()) == before
    a2, f2, m2, o2 = fitsproc.process_cutout(raw, RA, DEC, FOV)
    assert np.array_equal(arr, a2, equal_nan=True) and np.array_equal(foot, f2) and np.array_equal(offdet, o2)
