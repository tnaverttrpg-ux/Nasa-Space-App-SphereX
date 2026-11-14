# SPHERE TRACK

**NASA Space Apps Challenge 2026: "Planet X and SPHEREx"**

SPHERE TRACK is a web app for exploring the time history of any sky position in real NASA SPHEREx data. You enter RA/Dec or pick a preset target. The app:

1. finds every SPHEREx image that contains the position, using the IRSA archive,
2. downloads only small cutouts through the official IRSA cutout service,
3. aligns the cutouts with their WCS onto one north-up grid,
4. plays them back in time order.

Use it to spot moving or variable sources.

> **SPHERE TRACK is an exploration tool, not a discovery system.** It shows real observations and points out changes worth a closer look. It does not confirm moving objects. It has not found, and cannot by itself find, "Planet X".

## Problem

SPHEREx maps the whole sky in 102 infrared colours and revisits every position several times a year. That repetition is a time series. A nearby brown dwarf, a high-proper-motion star or an outer Solar System body would shift between visits. Variable stars change brightness.

The data is hard for the public to use:
- the images live in archive services designed for professionals,
- each visit has a different orientation and wavelength,
- raw FITS files need specialist software.

## Solution

SPHERE TRACK turns any sky position into a time-ordered, aligned image sequence in a browser, using only official archive services:

- **Discover:** IRSA SIA2 finds the observations.
- **Retrieve:** the IRSA cutout service returns small cutouts.
- **Align:** each frame's WCS reprojects it onto one shared grid.
- **Compare:** sequence, blink and difference views.

It keeps measured values (FITS headers) separate from derived values (difference statistics, candidate residuals). It also warns about effects that look like motion but are not, such as wavelength differences, masked pixels and registration offsets.

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
- Difference view with a colour legend (red = brighter in A, blue = brighter in B). Candidate residuals can be selected from the list or on the image; each shows RA/Dec, grid pixel, significance and sign.
- Optional Gaia DR3 overlay. Sources are shown with their proper motion propagated to each frame's epoch, with a G-magnitude limit to control clutter.
- Short tooltips that explain Right Ascension, Declination, field of view, wavelength, proper motion and difference imaging. They work with the keyboard and the mouse.
- Loading progress bar, toast notifications, per-frame retry (click a red dot on the timeline) and "Retry failed", timeouts, error states, and an honest "no observations" state. When other bands have data, the empty state offers them.
- Keyboard: ← → step frames, space plays and pauses, and every control is reachable with Tab.
- **DEMO MODE** with synthetic images, clearly labelled as not SPHEREx data.

## Architecture

```
frontend (React + Vite + TS + Tailwind)          backend (FastAPI)
  App.tsx            form, presets, orchestration   main.py      routes, validation, grid cache
  components/Viewer  modes, playback, timeline      archive.py   IRSA SIA2 + IBE cutouts + disk cache
  components/SkyImage image + SVG overlays          fitsproc.py  HDU pick, FLAGS mask, WCS reprojection,
  components/InfoTip accessible tooltips                         rendering, difference, registration check
  api.ts             typed fetch with timeouts
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

Other caches:
- SIA2 results: `backend/cache/sia/`.
- SIMBAD resolutions: `backend/cache/resolve.json`.
- Gaia query results: `backend/cache/gaia/`.

These caches are permanent. Delete `backend/cache/sia/` to pick up a new SPHEREx data release.

## Technologies

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4. Lucide icons; Sonner toast notifications. |
| Backend | Python, FastAPI, Uvicorn, httpx. |
| Astronomy | Astropy (FITS, WCS, coordinates, time), reproject, PyVO (SIA2/TAP), NumPy, Matplotlib (colour maps), Pillow. |
| Services | NASA/IPAC IRSA (SIA2, IBE cutouts), CDS Sesame/SIMBAD, ESA Gaia archive with a GAVO DC mirror. |

## Data sources

- **SPHEREx DR1** (`spherex_dr1` collection), from the NASA/IPAC Infrared Science Archive (IRSA).
  - Discovery: IVOA SIA2 at `https://irsa.ipac.caltech.edu/SIA`.
  - Cutouts: IRSA IBE cutout service (`<access_url>?center=ra,dec&size=deg`).
  - Only cutouts are downloaded, never full detector images.
- **SIMBAD** (CDS, Strasbourg), through the Sesame name resolver.
- **Gaia DR3** (ESA), through the Gaia archive TAP service. When ESA rate-limits the request (HTTP 429), the app falls back to the `gaia.dr3lite` mirror at the GAVO Data Center (`dc.g-vo.org`), which serves the same DR3 values at epoch 2016.0.

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

## Demo script (about 4 minutes)

Before judging, warm the cache: load each target once. The first live fetch takes 10–20 s per cutout; later loads are instant.

1. **Barnard's Star.** Open `http://localhost:5180` and click **Example: Barnard's Star**.
   - Point out the measured metadata panel: DATE-AVG, wavelength at the target, pixel scale and rotation.
   - Press **Play** and raise the speed. The star moves north over the timeline.
2. **Blink.** Choose A = earliest frame and B = latest frame. Note the wavelength warning.
3. **Difference.** The red/blue dipole at the centre shows the star's motion. Select a candidate to show its coordinates. Point out the satellite streak: it is a residual, not a moving celestial object.
4. **Gaia overlay.** Turn on **Gaia DR3 overlay**. The green circle for Barnard's Star follows the star frame by frame, propagated from Gaia's 2016 position.
5. **WISE 0855.** Choose WISE 0855 from the challenge targets. It is a faint 4–5 µm source and is best viewed in D6. Explain the limits: 6″ pixels, a ~1-year baseline, and that no single residual is a discovery.
6. **Share and honesty.** Copy the URL to show it reproduces the view. Optionally open `?demo=1` to show how synthetic data is labelled.

## Team

| Member |
|---|
| Kiaan Samir |
| Revant Ghimiray |
| Abhinav Kumar Singh |
| Arya Agarwala |

## Disclaimer

SPHERE TRACK is an independent project created for the NASA International Space Apps Challenge. It is not endorsed by, sponsored by or affiliated with NASA, Caltech/IPAC, the SPHEREx mission team, ESA or CDS. The NASA name, and any NASA images or data, are used under NASA's media and data usage guidelines. No NASA endorsement is implied.

## Attribution

This research uses data products from SPHEREx, a NASA mission. The archive is hosted by the NASA/IPAC Infrared Science Archive, which is funded by NASA and operated by the California Institute of Technology. This research uses the SIMBAD database, operated at CDS, Strasbourg, France. This work uses data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC). The Gaia fallback uses the GAVO Data Center, operated by the German Astrophysical Virtual Observatory. The app is built with Astropy, reproject, PyVO, NumPy, Matplotlib, Pillow, FastAPI, React, Vite and Tailwind CSS.

DEMO MODE images are generated procedurally with NumPy. They are not SPHEREx or NASA data.
