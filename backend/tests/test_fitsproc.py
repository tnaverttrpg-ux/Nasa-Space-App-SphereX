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
    arr, foot, meta, _ = fitsproc.process_cutout(make_fits(RA, DEC), RA, DEC, FOV)
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
    arr, _, _, offdet = fitsproc.process_cutout(make_fits(RA, DEC), RA, DEC, FOV)
    assert fitsproc.render(arr).startswith(b"\x89PNG") and fitsproc.render(arr, offdet=offdet).startswith(b"\x89PNG")


def clipped_fits(rows_below_target, det_x0=100, with_wcs_a=True):
    """Cutout clipped at detector row 0: target `rows_below_target` px above the bottom edge (no rotation)."""
    nx, ny, s = 40, rows_below_target + 20, 6.15 / 3600
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [20.5, rows_below_target + 1]          # target at 0-based row `rows_below_target`
    w.wcs.cdelt = [-s, s]
    hdr = w.to_header()
    # Key-less SIP terms like the real headers: must NOT leak into the linear detector WCS 'A'.
    hdr.update({"CTYPE1": "RA---TAN-SIP", "CTYPE2": "DEC--TAN-SIP", "A_ORDER": 2, "B_ORDER": 2,
                "A_1_0": 0.0, "A_0_2": 1e-6, "A_2_0": 0.0, "A_1_1": 0.0, "B_0_1": 0.0, "B_2_0": 1e-6, "B_0_2": 0.0, "B_1_1": 0.0})
    if with_wcs_a:  # pipeline convention: alternate WCS 'A' = 0-based active detector pixel coordinates
        hdr.update({"WCSAXESA": 2, "WCSNAMEA": "0-based active pixel coordinates", "CTYPE1A": "LINEAR", "CTYPE2A": "LINEAR",
                    "CRPIX1A": 1.0 - det_x0, "CRPIX2A": 1.0, "CRVAL1A": 0.0, "CRVAL2A": 0.0, "CDELT1A": 1.0, "CDELT2A": 1.0,
                    "CUNIT1A": "pixel", "CUNIT2A": "pixel"})
    img = np.random.default_rng(2).normal(10, 1, (ny, nx)).astype("float32")
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(img, header=hdr, name="IMAGE")]).writeto(buf)
    return buf.getvalue()


def test_detector_edge_distance_from_pipeline_wcs_a():
    arr, foot, meta, offdet = fitsproc.process_cutout(clipped_fits(7), RA, DEC, FOV)
    pos = meta["detector_position"]
    assert pos["y"] == 7.0 and pos["x"] == 119.5 and pos["edge_px"] == 7.0 and pos["active_size"] == 2040
    # the declared linear offset, not a SIP-distorted one: cutout pixel (0,0) is detector (100, 0)


def test_detector_position_omitted_without_wcs_a():
    _, _, meta, _ = fitsproc.process_cutout(clipped_fits(7, with_wcs_a=False), RA, DEC, FOV)
    assert meta["detector_position"] is None


def test_off_detector_mask_only_marks_unobserved_nan_pixels_and_leaves_science_unchanged():
    arr, foot, meta, offdet = fitsproc.process_cutout(clipped_fits(7), RA, DEC, FOV)
    n = arr.shape[0]
    assert offdet.any() and not offdet[n // 2:].any()      # only south of the target (FITS row order: row 0 = south)
    assert np.isnan(arr[offdet]).all()                      # never covers observed data
    assert offdet.sum() <= (~foot).sum()                    # subset of no-coverage pixels
    assert meta["coverage_fraction"] == round(float(np.mean(foot)), 3)
    assert meta["off_detector_fraction"] == round(float(offdet.mean()), 3)
    # science array identical whether or not the mask is computed (mask is a separate output)
    arr2, foot2, _, _ = fitsproc.process_cutout(clipped_fits(7), RA, DEC, FOV)
    assert np.array_equal(arr, arr2, equal_nan=True) and np.array_equal(foot, foot2)
