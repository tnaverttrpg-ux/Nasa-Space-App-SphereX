# SPHERE TRACK

**NASA Space Apps Challenge 2026: "Planet X and SPHEREx"**

SPHERE TRACK is a web app for exploring the time history of any sky position in real NASA SPHEREx data. You enter RA/Dec or pick a preset target. The app:

1. finds every SPHEREx image that contains the position, using the IRSA archive,
2. downloads only small cutouts through the official IRSA cutout service,
3. aligns the cutouts with their WCS onto one north-up grid,
4. plays them back in time order.

Use it to spot moving or variable sources.

## Quick start

Requirements: Python 3.11+ and Node 20+.

```powershell
# backend (from repo root)
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000

# frontend (second terminal)
cd frontend
npm install
npm run dev          # http://localhost:5180  (proxies /api to :8000)
```

On macOS or Linux, use `.venv/bin/python` instead.

Run the tests with `cd backend; .\.venv\Scripts\python -m pytest -q tests`.

Shareable links work like this:

- `http://localhost:5180/?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12` (Barnard's Star)
- `http://localhost:5180/?demo=1` (synthetic demo)

## Features

- Enter RA/Dec in decimal degrees, with validation. You can also resolve an object name through SIMBAD.
- Five preset targets, resolved live through CDS Sesame/SIMBAD: Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis.
- Field of view from 0.02° to 0.5°. Choose a SPHEREx band (D1–D6) and a maximum number of frames (2–48).
- **Sequence** view with previous/next, play/pause, playback speed, arrow-key and space shortcuts, the exact UTC date of each frame, and a real-time (MJD) timeline.
- **Side-by-side**, **Blink** and **Difference** comparison of any two frames.
- Frame metadata read from the FITS headers, labelled **MEASURED**.
- Difference statistics and candidate residuals, labelled **DERIVED**.
- Optional Gaia DR3 overlay. Sources are shown with their proper motion propagated to each frame's epoch.
- Loading progress, per-frame retry (click a red dot on the timeline), timeouts, error states, and an honest "no observations" state.
- **DEMO MODE** with synthetic images, clearly labelled as not SPHEREx data.

## Architecture

```
frontend (React + Vite + TS + Tailwind)          backend (FastAPI)
  App.tsx            form, presets, orchestration   main.py      routes, validation, grid cache
  components/Viewer  modes, playback, timeline      archive.py   IRSA SIA2 + IBE cutouts + disk cache
  components/SkyImage image + SVG overlays          fitsproc.py  HDU pick, FLAGS mask, WCS reprojection,
  api.ts             typed fetch with timeouts                   rendering, difference, registration check
                                                    resolver.py  Sesame/SIMBAD, proper motion, Gaia DR3
                                                    demo.py      synthetic demo frames
```

| Endpoint | Purpose |
|---|---|
| `GET /api/observations?ra&dec&band&limit` | IRSA SIA2 query. Returns science images that contain the position, sorted by time. If more exist than `limit`, it samples evenly across the full time baseline. |
| `GET /api/frame?url&ra&dec&fov` | Downloads one cutout (cached), parses the FITS file, and reprojects it onto the series grid. Returns the metadata measured from the headers. |
| `GET /api/frame/{key}.png?stretch&cmap` | Rendered frame. |
| `GET /api/diff?a&b` | Difference image plus derived statistics and candidates. |
| `GET /api/gaia?ra&dec&fov` | Gaia DR3 sources on the grid. |
| `GET /api/presets`, `GET /api/resolve?name` | Name resolution. |
| `GET /api/demo` | Synthetic demo series. |

The frontend loads frames 4 at a time, so they appear progressively. The first fetch of a cutout takes about 10–20 s on the IRSA side. After that, raw cutouts are cached in `backend/cache/cutouts/` and aligned grids in `backend/cache/grids/`. `PROC_VERSION` in `fitsproc.py` is part of the grid cache key, so changing the processing invalidates old grids automatically.

## Data sources

- **SPHEREx DR1** (`spherex_dr1` collection), from the NASA/IPAC Infrared Science Archive (IRSA).
  - Discovery: IVOA SIA2 at `https://irsa.ipac.caltech.edu/SIA`.
  - Cutouts: IRSA IBE cutout service (`<access_url>?center=ra,dec&size=deg`).
  - Only cutouts are downloaded, never full detector images.
- **SIMBAD** (CDS, Strasbourg), through the Sesame name resolver.
- **Gaia DR3** (ESA), through the Gaia archive TAP service.

## How the processing handles the science

- **HDU selection.** The SPHEREx L2 files have an empty primary HDU. They also contain `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, `EPSF` and `WCS-WAVE` extensions. The code looks for a science extension by name. If none exists, it takes the first 2-D HDU with a celestial WCS. It does not assume a fixed index.
- **Timestamps.** Times come from `DATE-AVG` / `MJD-AVG` (mid-exposure, UTC) in the FITS header. If those are missing, it falls back to `DATE-OBS` / `MJD-OBS`.
- **Bad pixels.** Flag plane names are read from the `MSKNnnnn` header keys, not from hardcoded bit numbers. Pixels flagged TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, PERSIST or OUTLIER are masked and shown grey. SOURCE, GHOST and HALO flags are reported but not masked.
- **Alignment.** Every frame is reprojected with its own WCS (TAN-SIP) onto one shared north-up TAN grid at 6.15″/px, using `reproject_interp`. This removes differences in rotation and scale between visits. Native rotation and pixel scale are shown for each frame.
- **Registration check.** For each difference, the app cross-correlates the point sources and reports any residual global offset within ±4 px. A non-zero offset suggests a registration error, not motion.
- **Calibration and wavelength.** SPHEREx uses a linear variable filter, so the wavelength at the target changes from visit to visit, even within one band. The app reads this wavelength from the `WCS-WAVE` (`-TAB`) wavelength WCS and shows it for each frame.
- **Difference images.** Before subtracting, the app removes a robust median background from each frame. It then matches flux scales with a factor *k*, fitted on pixels that are bright in both frames. The noise σ comes from the median absolute deviation (MAD).
- **Display scaling.** Each frame is scaled independently (median − 2σ up to the 99.7th percentile, with an asinh or linear stretch). Brightness in the display is therefore not a photometric comparison.

## Scientific limitations

- Read candidate residuals as "look here", not "found something". They are unvetted local maxima ≥5σ in a difference image. Common causes are:
  - satellite or asteroid streaks,
  - cosmic rays that the flags missed,
  - ghosts and halos around bright stars,
  - PSF differences between detector positions,
  - real spectral differences, because two frames sample different wavelengths.
- Brightness changes between frames can be spectral, not temporal. The app warns you when the wavelength at the target differs between the two frames.
- The pixels are large (~6.2″), so only fast movers show visible motion over SPHEREx's ~1-year baseline. Barnard's Star moves ~1.7 px per year, and WISE 0855 ~1.3 px per year.
- Saturated cores of bright stars are masked, so a bright mover appears as a moving grey patch with a bright rim.
- Nothing in this tool can identify "Planet X". A moving source needs confirmation from several epochs, a consistent motion vector, catalogue cross-matching (Gaia, WISE) and follow-up observations.
- The search uses SIMBAD J2000 positions, propagated with proper motion to epoch 2025.9 (the middle of DR1). SIMBAD gives positions at epoch J2000 by convention.
- **Exception: WISE 0855.** It uses the coordinate fixed by the challenge brief (RA 133.795129°, Dec −7.245147°). SIMBAD lists a different position (133.81891°, −7.24705°, AllWISE-based), and propagation from it lands about 2′ away. Both positions fall inside the default 6′ field.
- If there are more frames than the selected maximum, the app samples them evenly in time. You will not see every visit unless you raise the maximum (up to 48).
- The Gaia overlay propagates motion linearly in pixel space. This is accurate for small fields, but parallax is ignored.

## Attribution

This research uses data products from SPHEREx, a NASA mission. The archive is hosted by the NASA/IPAC Infrared Science Archive, which is funded by NASA and operated by the California Institute of Technology. This research uses the SIMBAD database, operated at CDS, Strasbourg, France. This work uses data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC). The app is built with Astropy, reproject, PyVO, NumPy, Matplotlib, Pillow, FastAPI, React, Vite and Tailwind CSS.

DEMO MODE images are generated procedurally with NumPy. They are not SPHEREx or NASA data.
