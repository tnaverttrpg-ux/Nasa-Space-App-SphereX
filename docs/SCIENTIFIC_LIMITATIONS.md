# Scientific limitations and validation

SPHERE TRACK is an **exploration and investigation tool**. It helps a person look at how real SPHEREx observations of one position change over time. It is **not an autonomous discovery system**: it does not decide what is real, it does not confirm detections, and its output is a starting point for checking, not a result.

## What the app does not claim

- **A moving or changing residual is a candidate, not a discovery.**
  - Difference-image candidates are unvetted local maxima at or above 5σ (adjustable).
  - Common causes are satellite or asteroid trails, cosmic-ray hits the flags missed, ghosts and halos around bright stars, PSF differences between detector positions, and real spectral differences.
  - Confirming a moving source needs several epochs, a consistent motion vector, cross-matching against catalogues (for example Gaia and WISE) and independent follow-up observations.
- **SPHERE TRACK does not claim to discover Planet X.** Nothing in the app can identify Planet X, and the team makes no such claim. The interface states that a changing source is "never evidence of 'Planet X' on its own".

## Data-quality limitations

- **Pipeline QA "Pass" is not proof that an observation is free of artefacts.**
  - `L1DQAFLG` / `L2DQAFLG` report the outcome of the pipeline's automated checks.
  - The interface reports them verbatim, with a note that a Pass "does not certify the image is free of artefacts".
- **Whole-detector streak counts are not displayed-field flags.**
  - `SATSTRKS` and `SATSTRKS_PXS` describe the whole SPHEREx detector image; a reported streak may lie far outside the displayed field.
  - The count of `STREAK`-flagged pixels inside the displayed field is computed separately from the per-pixel FITS flags, and the two are labelled separately.
  - Unflagged linear trails can still be present.
- **Per-pixel flags are reported, not all masked.** Only the planes listed in [methods §4](SCIENTIFIC_METHODS.md#4-quality-mask-handling) are masked. Pixels flagged `SOURCE`, `GHOST` or `HALO` remain in the data.
- **Saturated cores are masked.** A bright moving star can therefore appear as a moving grey patch with a bright rim.

## Coverage limitations

- **Overlapping footprints do not guarantee valid pixel coverage.**
  - The sky map shows the archive's **whole-detector** outlines.
  - Lying inside an outline means the detector pointed there. It does not mean a usable pixel exists: masks, flags, detector edges and cutout clipping still apply.
  - The overlap inspector and density shading are labelled as whole-detector footprint overlap.
- **Detector-edge regions may have no native pixels.**
  - Near the detector edge the retrieved cutout is clipped, and the affected grid pixels were never observed.
  - They are drawn dark grey with a hatch and excluded from statistics, and the Pixel Inspector reports that no native pixel exists there.
- **The displayed-field square is not the native cutout footprint.** Native cutout outlines are not stored and are not drawn.
- **Missing or invalid footprints are excluded, not treated as zero-area.** Observations without a valid `s_region` polygon are listed with a reason and left out of the map, overlap counts and density shading.

## Measurement limitations

- **Different wavelengths are not changes over time.** SPHEREx's linear variable filter means each visit samples the target at a slightly different wavelength. A brightness difference between two frames may be spectral, not temporal. The app warns when A and B differ by more than 0.02 µm at the target, and the fitted flux scale *k* cannot remove a genuine spectral difference.
- **Aligned-grid values are interpolated.** Reprojection mixes neighbouring native pixels (bilinear), and masked pixels spread slightly. Original values are available only through the Pixel Inspector, and only when the cutout is cached locally.
- **Values are not calibrated photometry.** Pixel values are surface brightness in the file's `BUNIT` (MJy/sr). The app does no aperture photometry, colour correction or flux calibration. Display scaling is set per frame, so on-screen brightness is not comparable between frames.
- **The background model is simple.** Difference imaging subtracts one robust median per frame, so spatially varying backgrounds (for example zodiacal light gradients) are not modelled.
- **Spatial and time resolution are limited.**
  - Grid pixels are 6.15″, and the native SPHEREx pixels are about 6.2″.
  - Over the roughly one-year DR1 baseline, only fast-moving sources show visible motion: Barnard's Star (about 10.4″/yr) moves about 1.7 grid pixels per year.
  - Slow movers cannot be seen.
- **Sampling may skip visits.** When more observations exist than the selected frame count, frames are sampled evenly in time, and visits in between are not shown unless the count is raised (up to 48).
- **The Gaia overlay is approximate.**
  - Positions are propagated linearly from epoch 2016.0 using proper motion only; parallax is ignored.
  - At most the 400 brightest sources with G < 19 are fetched.
- **Target coordinates come from catalogues.** SIMBAD J2000 positions are propagated to epoch 2025.9. WISE 0855 uses the coordinate fixed by the challenge brief, which differs from SIMBAD's position by about 2′; both lie inside the default field.

## Validation evidence

The following evidence is taken from the automated test suites in this repository. These tests ran on 2026-11-15, with the results shown.

### Test runs

| Check | Result |
|---|---|
| Backend tests (`npm run test:backend`, 10 files) | 90 passed |
| Browser suites (`npm run test:e2e`, 12 suites, real IRSA data, Microsoft Edge) | 227/227 checks passed in each of two consecutive full runs |
| TypeScript type check, ESLint, production build | Clean |

### What specific tests verify

**Projection and geometry** (`frontend/e2e/skymap.mjs`, `coverage.mjs`)
- All 41 Barnard's Star D6 footprint polygons match an independent gnomonic projection written separately in the test.
- Whole-detector footprints measure 3.55°–3.68° across.
- Overlap-inspector results match an independent spherical point-in-polygon test, including at a point covered by 37 footprints, at the target (all 41) and at a point with none.
- Screen-to-sky inversion round-trips to within 10⁻¹³°, including at RA 0°/360° and high declination.
- Footprints straddling RA 0°/360° project correctly.
- The density shading agrees with exact counts at every sampled grid point except within 2.5 px of a polygon edge.

**Footprint parsing and cache** (`backend/tests/test_footprints.py`)
- Malformed polygons (wrong shape, frame, odd coordinates, too few vertices, non-finite, out of range, degenerate) are rejected with reasons.
- Old search caches are refreshed once and never deleted.
- An IRSA outage falls back correctly.

**Pixel inspection** (`frontend/e2e/pixel.mjs`, `backend/tests/test_pixel_inspector.py`)
- The pixel clicked on screen matches the API under zoom and pan.
- Off-detector pixels report no native pixel.
- A saturated core shows its masking flag on the native pixel.
- Detector coordinates use the linear WCS `A` without SIP terms.

**Pipeline QA** (`frontend/e2e/qa.mjs`, `backend/tests/test_pipeline_qa.py`)
- Across all 12 sampled Barnard's Star D6 frames, the streak advisory appears exactly when `SATSTRKS` > 0.
- The 2026-05-05 frame reports L1/L2 Pass, 1 satellite streak and 3,616 streak pixels detector-wide, but **0** STREAK-flagged pixels in the displayed field. This illustrates why the two counts are labelled separately.

**Detector edge** (`frontend/e2e/edge.mjs`)
- For observation 2025W33_2C_0321_3 at 0.5° field of view, the target lies 37 px from the detector edge.
- The rendered image shows the hatched off-detector band and the separate light-grey mask colour.

**Difference imaging and statistics** (`backend/tests/test_diff_contrast.py`, `test_histogram.py`, `frontend/e2e/hist.mjs`, `nav.mjs`)
- The display contrast setting does not change the detected candidates.
- Histogram statistics shown in the interface match the API for multiple frames.

**Archive access** (`backend/tests/test_archive.py`, `test_release_audit.py`, `test_gaia_fallback.py`, `test_sampling.py`)
- Retry and timeout behaviour, cache isolation and corruption recovery.
- The Gaia fallback when ESA fails.
- Nested, evenly spread frame sampling.

These tests check that the software does what it is designed to do. **They do not validate any astronomical result**, and none is claimed.
