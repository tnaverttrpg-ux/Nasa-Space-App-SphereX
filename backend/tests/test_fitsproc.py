import io

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app import fitsproc

RA, DEC, FOV = 150.0, 2.0, 0.05


def make_fits(star_ra, star_dec, rot_deg=30.0, put_image_in=2):
    """Synthetic cutout: rotated native WCS, science image NOT in the first extension."""
    n, s = 40, 6.2 / 3600
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [20.5, 20.5]
    t = np.radians(rot_deg)
    w.wcs.cd = np.array([[-np.cos(t), np.sin(t)], [np.sin(t), np.cos(t)]]) * s
    yy, xx = np.mgrid[0:n, 0:n]
    x0, y0 = w.world_to_pixel_values(star_ra, star_dec)
    img = 5 + 1000 * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / 2.0)
    img += np.random.default_rng(1).normal(0, 0.5, img.shape)
    hdr = w.to_header()
    hdr["DATE-AVG"] = "2025-05-05T16:49:00"
    hdr["MJD-AVG"] = 60800.7
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(np.zeros((3, 3)), name="JUNK")]
    hdus.insert(put_image_in, fits.ImageHDU(img.astype("float32"), header=hdr, name="IMAGE"))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()


def test_science_hdu_found_and_star_aligned_via_wcs():
    arr, foot, meta = fitsproc.process_cutout(make_fits(RA, DEC), RA, DEC, FOV)
    assert meta["hdu"] == "IMAGE" and meta["mjd"] == 60800.7
    assert abs(meta["native_rotation_deg"]) > 20
    y, x = np.unravel_index(np.nanargmax(arr), arr.shape)
    c = (arr.shape[0] - 1) / 2
    assert abs(x - c) <= 1 and abs(y - c) <= 1  # star lands at grid centre despite rotation


def test_difference_flags_moved_source_and_reports_no_registration_offset_for_static_field():
    off = 4 * 6.15 / 3600
    a = fitsproc.process_cutout(make_fits(RA, DEC), RA, DEC, FOV)
    b = fitsproc.process_cutout(make_fits(RA, DEC + off, rot_deg=-10), RA, DEC, FOV)
    w, _ = fitsproc.grid_wcs(RA, DEC, FOV)
    d = fitsproc.difference(a[0], a[1], b[0], b[1], w)
    signs = {c["sign"] for c in d["candidates"]}
    assert signs == {"brighter_in_A", "brighter_in_B"}
    top = d["candidates"][0]
    assert abs(top["ra"] - RA) < 0.01
    assert d["registration_offset_px"] == (0, -4)  # single source moved 4 px north (display up)


def test_render_png():
    arr, _, _ = fitsproc.process_cutout(make_fits(RA, DEC), RA, DEC, FOV)
    assert fitsproc.render(arr).startswith(b"\x89PNG")
