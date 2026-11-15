# Scientific methods

This document describes exactly what SPHERE TRACK does to the data, as implemented in `backend/app/` and `frontend/src/`. Function names are given so each step can be checked in the code. Where a quantity is derived rather than measured, it says so.

## 1. Kinds of value

The app shows five kinds of value. They are never mixed, and the interface labels them differently.

| Kind | What it is | Where it comes from |
|---|---|---|
| **Aligned-grid value** | Surface brightness of one pixel on the shared north-up grid. **Interpolated**: it is a weighted mix of nearby original pixels after reprojection. | `fitsproc.process_cutout` → `reproject_interp` |
| **Native FITS value** | The original pixel value in the `IMAGE` extension of the retrieved cutout, with no resampling. | `fitsproc.inspect_pixel` (Pixel Inspector only) |
| **Detector coordinate** | Position on the SPHEREx detector's active pixel area (0-based, 2040 × 2040). | Alternate WCS `A` in the FITS header (`fitsproc.detector_linear`) |
| **Pipeline QA metadata** | Quality summary written by the SPHEREx pipeline for the **whole detector image**: `L1DQAFLG`, `L2DQAFLG`, `L2 SATSTRKS`, `L2 SATSTRKS_PXS`. | FITS header (`fitsproc.pipeline_qa`) |
| **Per-pixel FITS flags** | Bit flags for **individual pixels** in the `FLAGS` extension (for example `OVERFLOW`, `STREAK`, `SOURCE`). | `FLAGS` extension; plane names from `MSKNnnnn` header keys |

Pixel values are in the unit given by the file's `BUNIT` header (MJy/sr for the SPHEREx images used here). They are **surface brightness values for display and comparison, not calibrated photometry**. The app does not perform aperture photometry, colour correction or absolute flux calibration.

## 2. Finding observations

- **Search:** the IRSA SIA2 service (`https://irsa.ipac.caltech.edu/SIA`) is queried with a 0.0005° circle at the target, collection `spherex_dr1`. In effect this asks for images that contain this position (`archive._query_sia`).
- **Rows kept:** only `dataproduct_subtype = science` rows are kept. Each row keeps its observation ID, band, access URL, start/end MJD, exposure time, wavelength range and the archive's footprint polygon (`s_region`), stored verbatim.
- **Sampling:** if more observations exist than the requested frame count, frames are chosen by `archive.nested_sample`. It takes the first and last, then fills in using a base-2 radical-inverse sequence. This spreads frames over the whole time baseline, and the set for a smaller count is always a subset of the set for a larger one.

## 3. FITS image extraction

- **Cutouts:** cutouts come from the IRSA IBE cutout service (`<access_url>?center=ra,dec&size=deg`). The size is 1.5 × the field of view (at most 0.75°), so a rotated native image still covers the corners of the north-up grid. Only URLs under `https://irsa.ipac.caltech.edu/ibe/data/spherex/` are accepted.
- **Validation:** a cutout is accepted only if it is a complete FITS file (whole 2880-byte blocks) containing a 2-D science image (`archive._valid_fits`).
- **Science HDU:** the science image is found by extension name (`IMAGE`, `SCI` or `SCIENCE`), falling back to the first 2-D HDU with a celestial WCS. No fixed HDU index is assumed (`fitsproc.science_hdu`).
- **Time:** taken from `DATE-AVG` / `MJD-AVG` (mid-exposure), falling back to `DATE-OBS` / `MJD-OBS`.
- **Measured metadata:** detector, observation ID, unit, native pixel scale and rotation, flag counts and pipeline version are read directly from the headers and shown as **measured** values.

## 4. Quality-mask handling

- **Flag planes:** plane names are read from the `FLAGS` extension header (`MSKNnnnn` keys), so bit numbers are never hard-coded.
- **Masked planes:** pixels with any of these planes are set to NaN *before* reprojection and drawn **light grey**: `TRANSIENT`, `OVERFLOW`, `SUR_ERROR`, `NONFUNC`, `MISSING_DATA`, `HOT`, `COLD`, `PERSIST`, `OUTLIER` (`fitsproc.BAD_PLANES`).
- **Reported but not masked:** other planes, for example `SOURCE`, `GHOST`, `HALO` and `STREAK`, are counted and reported but not masked.
- **NaN spread:** because masked pixels are NaN, interpolation spreads them slightly. An aligned-grid pixel next to a masked native pixel can become invalid.

## 5. WCS coordinates, alignment and reprojection

- **Shared grid:** all frames of a series share one grid (`fitsproc.grid_wcs`): a gnomonic (`TAN`) projection centred on the target, north up, east left, 6.15″ per pixel, with side ⌈FOV / 6.15″⌉ pixels.
- **Reprojection:** each frame is reprojected from its own celestial WCS, including SIP distortion terms, with `reproject.reproject_interp` (bilinear). This removes differences in rotation, scale and distortion between visits.
- **Footprint:** the reprojection footprint is kept, and a grid pixel counts as covered when the footprint exceeds 0.5.
- **Display orientation:** grids are stored in FITS row order (row 0 = south) and flipped only for display.
- **Registration check:** each difference image also reports a residual global offset. Point sources (> 5σ) in the two frames are cross-correlated by FFT within ±4 grid pixels (`fitsproc._shift`). A non-zero offset suggests an alignment error, not motion.

## 6. Wavelength

SPHEREx uses a linear variable filter, so the wavelength changes across the detector, and the same sky position is seen at a different wavelength on each visit, even within one band.

- For each frame the app evaluates the spectral WCS (key `W`, `WCS-WAVE` table) at the target and reports the centre wavelength and width at that position.
- Comparison views warn when frames A and B differ by more than 0.02 µm at the target. The difference endpoint reports the mismatch (`wavelength_mismatch_um`).

## 7. Difference imaging

`fitsproc.difference(a, b)` works only on grid pixels that are valid in **both** frames:

1. **Background:** the robust median of each frame is subtracted (one value per frame, not a spatially varying background).
2. **Flux scale:** pixels brighter than 10σ in both frames are found. If there are at least 5, the scale factor *k* is the median of their A/B ratio; otherwise *k* = 1. The difference is *d* = A − *k*·B. This compensates for different wavelengths and calibrations between visits, but cannot remove genuine spectral differences.
3. **Noise:** σ is the robust standard deviation of *d*, 1.4826 × the median absolute deviation (MAD).
4. **Candidates:** local maxima of |*d*|/σ at or above the detection threshold (default 5σ, adjustable 3–20σ).
   - Each must be the maximum of its 3 × 3 neighbourhood, with all 9 pixels valid in both frames, and must not be within 2 pixels of the grid edge.
   - Up to 25 are returned, ordered by significance, with the total count. Each has a grid position, RA/Dec from the grid WCS, significance and sign (brighter in A or in B).
5. **Display:** the colour range (default ±5σ, coolwarm map) is a display setting only. It does not change the candidates, which always use their own threshold.

Candidates are **unvetted local maxima**, not detections of astronomical sources (see [limitations](SCIENTIFIC_LIMITATIONS.md)).

## 8. Display scaling and intensity statistics

- **Display scaling:** each frame is scaled independently from the robust median − 2σ up to the 99.7th percentile, then shown with an asinh or linear stretch (`fitsproc.display_limits`, `render`). Display brightness is therefore not comparable between frames.
- **Statistics:** the histogram and statistics (`fitsproc.grid_stats`) use only finite, covered, on-detector grid pixels.
  - They report the mean, median, robust σ, minimum, maximum and the 1st/5th/50th/95th/99th/99.7th percentiles.
  - The histogram has 128 bins over the 0.5th–99th percentile range; pixels outside that range are counted as underflow or overflow.
  - All of these are **aligned-grid (interpolated) values**.

## 9. Pixel inspection

A click on any image selects one grid pixel; the same sky pixel stays selected when you step between frames. The `/api/frame/{key}/pixel` endpoint (`fitsproc.inspect_pixel`) returns:

1. **Grid value and state:**
   - *valid*: finite and covered;
   - *masked or invalid*: NaN or not covered, on the detector;
   - *off detector*: see §10.
2. **Sky position:** the grid pixel centre converted to RA/Dec with the grid WCS.
3. **Native FITS pixel:**
   - The sky position is converted into the native image with its full WCS, including SIP distortion, and the native pixel containing that point is chosen (nearest integer).
   - The app reports that pixel's original value, its FLAGS bit value, the decoded flag names, and whether the app masks it.
   - It never downloads anything: native values are available only when the cutout is already in the local cache. Otherwise, or when the position lies outside the cutout, the reason is shown.
4. **Detector pixel:** the native position converted with the pipeline's alternate WCS `A` (`WCSNAMEA` = "0-based active pixel coordinates").
   - This WCS is applied exactly as declared, as a pure linear offset. Astropy's `WCS(key="A")` would also attach the header's SIP terms and shift the result by about 10–20 px.
   - The app reports whether the point lies on the 2040 × 2040 active area.

Absent quantities are returned as empty with a reason. Nothing is clamped, rounded into range or filled in.

## 10. Detector-edge coverage

Near the edge of the SPHEREx detector, IRSA clips the cutout, so parts of the grid were **never observed**.

- **Off-detector pixels:** grid pixels whose centre maps outside the retrieved cutout, and which are already NaN, are marked off-detector (`fitsproc.off_detector_mask`). They are drawn dark grey with a diagonal hatch so they cannot be mistaken for dark sky, and are excluded from statistics. Data pixels are never recoloured.
- **Distance to the edge:** when the whole cutout lies on the active area, the target's detector position and its distance to the nearest detector edge are reported (`fitsproc.detector_position`).
- **Coverage figures:** the dashboard reports coverage, off-detector and (derived) masked fractions for each frame.

## 11. Pipeline QA interpretation

- **Header values:** `fitsproc.pipeline_qa` reports `L1DQAFLG`, `L2DQAFLG`, `HIERARCH L2 SATSTRKS` (satellite streaks) and `HIERARCH L2 SATSTRKS_PXS` (streak pixels) exactly as written. These are **detector-wide** values for the whole SPHEREx image, not for the displayed field.
- **Field count:** the app separately counts native pixels with the `STREAK` flag whose centres fall inside the displayed field. This count is computed from the per-pixel FLAGS and labelled "Displayed field · from FITS FLAGS".
- **Advisory:** a fixed satellite-streak advisory appears when, and only when, `SATSTRKS` > 0. It says that reported streaks may lie outside the displayed field and that unflagged trails may remain.
- **Missing values:** absent or malformed values are shown as "Unavailable", never guessed. A QA "Pass" is reported as the pipeline's result, with a note that it does not certify the image is free of artefacts.

## 12. Sky footprint projection (Sky coverage map)

- **Validation:** each observation's `s_region` is validated by `archive.parse_s_region`.
  - Accepted: `POLYGON` only, in ICRS/J2000/FK5 or with no frame given; numeric RA/Dec pairs; 3–100 vertices after dropping the closing duplicate; finite values in range; and a non-zero area.
  - Anything else is marked *missing*, *invalid* or *unavailable* with a reason, and is never drawn.
- **Search cache:** archive searches are cached in a versioned format. Older caches without footprints are kept and refreshed once from IRSA.
- **Projection:** footprints are drawn in a gnomonic projection centred on the target (`frontend/src/sky.ts`).
  - Great-circle polygon edges become straight lines.
  - RA wrap-around at 0°/360° is handled by working with sin/cos of ΔRA.
  - Points 90° or more from the target cannot be projected, and such footprints are rejected.
  - Vertex order is normalised to a consistent winding.
- **Overlap inspector:** a click is converted back to RA/Dec (inverse gnomonic). Every valid footprint is then tested with an even-odd point-in-polygon test in the same tangent plane. This is exact for polygons with great-circle edges.
- **Overlap density:** shading is computed exactly along one horizontal scanline per 2 screen pixels and drawn in five classes (1, 2–5, 6–10, 11–20, 21+).
- **Footprint vs displayed field:**
  - The footprint outline is the **whole detector** (about 3.5° across).
  - The square drawn at the centre is SPHERE TRACK's displayed field, exactly the grid of §5.
  - Native cutout outlines are not stored, so they are not drawn.

## 13. Gaia DR3 overlay

- **Query:** `resolver.gaia_sources` sends an ADQL cone search (radius 0.75 × FOV, G < 19, brightest 400) to the ESA Gaia archive (`gaiadr3.gaia_source`).
  - If the ESA query fails for any reason, the same query is sent to the GAVO Data Center mirror (`gaia.dr3lite`).
  - Results are cached on disk.
- **Epoch propagation:** positions are at the Gaia reference epoch 2016.0. For each frame, a star is moved by its proper motion × (frame decimal year − 2016.0), linearly in grid pixels.
  - Parallax and radial velocity are ignored, which is adequate for small fields.
  - Sources with no proper motion are treated as stationary.
- **Display:** the interface applies a G-magnitude limit to reduce clutter.

## 14. Target resolution

- **Names:** resolved with CDS Sesame (SIMBAD), which returns ICRS positions at epoch J2000 and proper motions.
- **Proper motion:** for targets with proper motion, the search position is propagated with Astropy `SkyCoord.apply_space_motion` to epoch 2025.9, chosen in the code as the mid-point of DR1 coverage.
- **WISE 0855 exception:** it uses the coordinate fixed by the challenge brief (RA 133.795129°, Dec −7.245147°) instead of SIMBAD's.

## 15. Synthetic demo data

`?demo=1` shows 10 frames generated with NumPy (`backend/app/demo.py`): noise, 45 static stars, one synthetic moving source and one synthetic variable source. Demo frames:

- have no sky position, WCS, native data or pipeline QA;
- are labelled with a "DEMO MODE … not SPHEREx or NASA data" banner and frame dates reading "SYNTHETIC frame N";
- are never mixed with SPHEREx data.
