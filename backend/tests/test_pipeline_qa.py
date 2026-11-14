"""Pipeline QA metadata: header values read verbatim, detector-wide vs displayed-field streak counts, robustness."""
import io

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app import fitsproc

RA, DEC, FOV = 150.0, 2.0, 0.05           # displayed field: 0.05° ≈ 30 grid px; cutout below is 60 native px (~0.10°)
STREAK_BIT = 25


def cutout(qa=None, streak_in_field=10, streak_outside=7, with_flags=True, streak_plane=True):
    n, s = 60, 6.15 / 3600
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA, DEC]
    w.wcs.crpix = [30.5, 30.5]
    w.wcs.cdelt = [-s, s]
    hdr = w.to_header()
    for k, v in (qa or {}).items():
        hdr[k] = v
    img = np.random.default_rng(3).normal(10, 1, (n, n)).astype("float32")
    fl = np.zeros((n, n), "int32")
    fl[30, 20:20 + streak_in_field] |= 1 << STREAK_BIT        # centre row: inside the displayed field
    fl[2, 2:2 + streak_outside] |= 1 << STREAK_BIT            # corner: inside the cutout, outside the field
    fh = fits.Header()
    fh["MSKN0000"] = "TRANSIENT"
    if streak_plane:
        fh["MSKN0025"] = "STREAK"
    hdus = [fits.PrimaryHDU(), fits.ImageHDU(img, header=hdr, name="IMAGE")]
    if with_flags:
        hdus.append(fits.ImageHDU(fl, header=fh, name="FLAGS"))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()


FULL = {"L1DQAFLG": "Pass", "L2DQAFLG": "Pass", "HIERARCH L2 SATSTRKS": 3, "HIERARCH L2 SATSTRKS_PXS": 4321}


def qa_of(raw):
    return fitsproc.process_cutout(raw, RA, DEC, FOV)[2]["pipeline_qa"]


def test_header_values_read_verbatim_and_detector_vs_field_counts_distinct():
    qa = qa_of(cutout(FULL))
    assert qa["l1_dqa"] == "Pass" and qa["l2_dqa"] == "Pass"
    assert qa["detector_streaks"] == 3 and qa["detector_streak_pixels"] == 4321      # whole detector, from header
    assert qa["field_streak_pixels"] == 10                                             # only the in-field pixels
    assert qa["field_streak_pixels"] != qa["detector_streak_pixels"]


def test_satstrks_zero():
    qa = qa_of(cutout({**FULL, "HIERARCH L2 SATSTRKS": 0, "HIERARCH L2 SATSTRKS_PXS": 0}, streak_in_field=0, streak_outside=0))
    assert qa["detector_streaks"] == 0 and qa["detector_streak_pixels"] == 0 and qa["field_streak_pixels"] == 0


def test_missing_qa_metadata_is_unavailable_not_invented():
    qa = qa_of(cutout({}))
    assert qa == {"l1_dqa": None, "l2_dqa": None, "detector_streaks": None, "detector_streak_pixels": None, "field_streak_pixels": 10}


def test_invalid_values_are_unavailable():
    qa = qa_of(cutout({"L1DQAFLG": "  ", "L2DQAFLG": 7, "HIERARCH L2 SATSTRKS": "two", "HIERARCH L2 SATSTRKS_PXS": -5}))
    assert qa["l1_dqa"] is None and qa["l2_dqa"] is None and qa["detector_streaks"] is None and qa["detector_streak_pixels"] is None


def test_missing_streak_plane_or_flags_extension():
    assert qa_of(cutout(FULL, streak_plane=False))["field_streak_pixels"] is None
    qa = qa_of(cutout(FULL, with_flags=False))
    assert qa["field_streak_pixels"] is None and qa["detector_streaks"] == 3


def test_qa_metadata_does_not_change_science_output():
    a = fitsproc.process_cutout(cutout(FULL), RA, DEC, FOV)
    b = fitsproc.process_cutout(cutout({}), RA, DEC, FOV)
    assert np.array_equal(a[0], b[0], equal_nan=True) and np.array_equal(a[1], b[1]) and np.array_equal(a[3], b[3])
    assert a[2]["coverage_fraction"] == b[2]["coverage_fraction"] and a[2]["masked_pixels"] == b[2]["masked_pixels"]
    # STREAK pixels are reported, never added to the mask (STREAK is not one of the masked planes)
    assert "STREAK" not in fitsproc.BAD_PLANES and np.isfinite(a[0]).sum() == np.isfinite(b[0]).sum()
