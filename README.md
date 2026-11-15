# SPHERE TRACK

**See how one patch of sky changes over time, using real NASA SPHEREx images.**

SPHEREx is a NASA space telescope that photographs the entire sky again and again. Because it returns to the same places, its images form a record of how the sky changes: some stars drift slowly across the background, and some brighten and fade. SPHERE TRACK lets anyone pick a spot in the sky, collects every SPHEREx picture of that spot from NASA's public archive, lines the pictures up and plays them in date order, like a flip-book. You can then compare two dates side by side, flick between them, or subtract one from the other to highlight what changed.

SPHERE TRACK is an **exploration tool**. It shows real observations and points to changes worth a closer look. It does not confirm discoveries, and it has not found, and cannot by itself find, "Planet X".

*NASA Space Apps Challenge 2026 · Challenge: "Planet X and SPHEREx"*

---

## Contents

1. [Challenge context](#challenge-context) · 2. [Problem](#problem) · 3. [Our solution](#our-solution) · 4. [Main features](#main-features) · 5. [How it works](#how-it-works) · 6. [Architecture](#architecture) · 7. [Technology stack](#technology-stack) · 8. [Data sources](#data-sources) · 9. [Scientific methodology](#scientific-methodology) · 10. [Performance](#performance) · 11. [Scientific limitations](#scientific-limitations) · 12. [Installation (Windows)](#installation-windows) · 13. [Screenshots and demonstration](#screenshots-and-demonstration) · 14. [Testing and validation](#testing-and-validation) · 15. [Team](#team) · 16. [AI-use disclosure](#ai-use-disclosure) · 17. [Disclaimer](#disclaimer)

Detailed documents: [Scientific methods](docs/SCIENTIFIC_METHODS.md) · [Data sources and attribution](docs/DATA_SOURCES.md) · [Scientific limitations and validation](docs/SCIENTIFIC_LIMITATIONS.md) · [AI disclosure](docs/AI_DISCLOSURE.md) · [Submission checklist](docs/SUBMISSION_CHECKLIST.md)

## Challenge context

"Planet X" is the name for a hypothetical undiscovered planet far beyond Neptune. A body that distant would be cold and faint, so it would shine mostly in infrared light, and it would move slowly against the background stars. SPHEREx observes the whole sky in infrared and revisits each position several times a year, so its archive is a natural place to look for faint objects that shift position over time. Nearby brown dwarfs and fast-moving stars show the same kind of motion and are much easier to see, which makes them good test cases.

## Problem

The SPHEREx images are public, but they are hard to use outside professional astronomy:

- They are stored in archive services designed for researchers, queried through specialised protocols.
- Each visit is taken at a different orientation and, because of how SPHEREx splits light into colours, at a slightly different wavelength.
- The files are in FITS, a scientific format that needs specialist software to open, align and compare.

As a result, the question "has anything here moved or changed?" is out of reach for most people.

## Our solution

SPHERE TRACK turns any sky position into an aligned, time-ordered image sequence in a web browser, using only official archive services:

1. **Find:** ask the NASA/IPAC Infrared Science Archive (IRSA) which SPHEREx images contain the position.
2. **Retrieve:** download a small cutout around the position from each image, not the full file.
3. **Align:** use each image's built-in coordinate information (WCS) to place it on one shared, north-up grid.
4. **Compare:** play the frames in time order, or compare any two frames side by side, by blinking, or by subtraction.

The app keeps **measured** values (read from the FITS files) visibly separate from **derived** values (computed by the app), and warns about effects that can look like change but are not: different wavelengths, masked pixels, detector edges and registration offsets.

## Main features

**Viewer**
- Target entry by RA/Dec (decimal degrees, validated) or by object name via SIMBAD. Five preset targets: Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis.
- Field of view 0.02°–0.5°, SPHEREx detector band D1–D6, and 2–48 frames, sampled evenly across the full time span.
- **Sequence** playback with speed control and a real-time timeline; **Side-by-side**, **Blink** and **Difference** comparison of any two frames.
- Synchronised zoom and pan across all panels.
- Shareable URLs that reproduce the view.

**Inspection**
- **Pixel Inspector:** click any pixel to see its aligned-grid value, sky coordinates, the original FITS pixel value and quality flags, and the position on the detector.
- **Difference imaging** with candidate residuals (position, significance, sign), a registration-offset check and a wavelength-mismatch warning.
- **Intensity histogram** and robust statistics for each frame.
- **Pipeline QA** panel showing the pipeline's own quality flags and satellite-streak counts, kept separate from the per-pixel flags.
- Optional **Gaia DR3 overlay**, with each star moved to the frame's date using its catalogued proper motion.

**Overview**
- **Observation dashboard:** data quality, field coverage and timing for the loaded frames.
- **Sky coverage map:** the archive footprint of every observation around the target, with an overlap inspector, overlap-density shading, a minimap and filters.

**Usability**
- Graphite Dark and Muted Grey Light themes (following the system setting by default), keyboard shortcuts, accessible tooltips and a layout that works on phones.
- Progressive loading, per-frame retry and honest empty and error states.
- **Demo mode** (`?demo=1`) with synthetic images, always labelled as not SPHEREx data.

## How it works

1. You choose a target, band, field of view and number of frames.
2. The backend queries IRSA for every SPHEREx science image containing that position (IVOA SIA2), sorted by time. If there are more than you asked for, it picks frames spread evenly across the whole time span.
3. For each selected image, the backend requests a cutout from the IRSA cutout service, slightly larger than the field so that a rotated image still covers the corners.
4. It reads the science image, the quality flags and the header from the cutout, masks unusable pixels, and reprojects the image onto a shared north-up grid centred on the target.
5. The browser shows each frame as soon as it is ready. Results are cached on disk, so later views of the same target are near-instant.

## Architecture

```
frontend/ (React + TypeScript, Vite dev server :5180)         backend/ (FastAPI, Uvicorn :8000)
  App.tsx                 search form, orchestration            app/main.py      HTTP API, validation, grid cache
  components/Viewer       modes, playback, timeline             app/archive.py   IRSA SIA2 search, IBE cutouts,
  components/SkyImage     image, zoom/pan, overlays                              download queue, disk caches
  components/PixelInspector, Histogram, Dashboard, SkyMap        app/fitsproc.py  FITS parsing, masking, WCS
  sky.ts                  gnomonic projection helpers                            reprojection, rendering, difference
  api.ts                  typed API client                       app/resolver.py  SIMBAD/Sesame, proper motion, Gaia DR3
                                                                 app/demo.py      synthetic demo frames
```

The Vite dev server proxies `/api` to the backend.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness check. |
| `GET /api/presets`, `GET /api/resolve?name=` | Preset targets and name resolution (SIMBAD via CDS Sesame). |
| `GET /api/observations?ra&dec&band&limit[&fov][&include_all]` | SIA2 search. Returns sampled observations with parsed footprints; `include_all=true` adds every observation in the band. |
| `GET /api/frame?url&ra&dec&fov` | Retrieve (or reuse) one cutout, reproject it onto the series grid, return measured metadata. |
| `GET /api/frame/{key}.png?stretch&cmap` | Rendered frame image. |
| `GET /api/frame/{key}/stats` | Histogram and statistics of the aligned grid. |
| `GET /api/frame/{key}/pixel?x&y` | Pixel Inspector lookup (grid, sky, native FITS and detector values). |
| `GET /api/diff?a&b[&nsig][&scale_sigma]` | Difference image, derived statistics and candidate residuals. |
| `GET /api/gaia?ra&dec&fov` | Gaia DR3 sources on the grid. |
| `GET /api/demo` | Synthetic demo series. |

## Technology stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, Lucide icons, Sonner notifications. Charts and the sky map are hand-written SVG, with no charting or mapping library. |
| Backend | Python, FastAPI, Uvicorn, httpx. |
| Astronomy | Astropy (FITS, WCS, coordinates, time), reproject, PyVO (SIA2, TAP), NumPy, Matplotlib (colour maps), Pillow. |
| Testing | pytest (backend), Playwright-core driving Microsoft Edge (browser suites). |

## Data sources

- **SPHEREx Data Release 1** (`spherex_dr1`), NASA/IPAC Infrared Science Archive (IRSA): SIA2 search and the IBE cutout service.
- **SIMBAD** (CDS, Strasbourg), via the Sesame name resolver.
- **ESA Gaia DR3**, via the Gaia archive TAP service, with the GAVO Data Center `gaia.dr3lite` mirror as a fallback.

Full details, links and required acknowledgements: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Scientific methodology

In brief:

- **Image extraction:** the science image is found by extension name (`IMAGE`), not by a fixed position in the file; times come from the mid-exposure header keys (`DATE-AVG` / `MJD-AVG`).
- **Quality masking:** flag names are read from the file's own header; pixels with the TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, PERSIST or OUTLIER flags are masked and drawn grey.
- **Alignment:** each frame is reprojected with its own WCS onto a north-up grid at 6.15″ per pixel (bilinear interpolation).
- **Wavelength:** SPHEREx's wavelength varies across the detector, so the wavelength at the target is read for every frame and compared before differencing.
- **Difference imaging:** background removal, a fitted flux scale between frames, robust noise estimation, and ≥5σ local maxima listed as candidates.
- **Footprints:** archive footprint polygons are validated and drawn in a gnomonic projection centred on the target.

The app always distinguishes **interpolated aligned-grid values**, **original native FITS values**, **detector coordinates**, **detector-wide pipeline QA** and **per-pixel FITS flags**. Pixel values are surface brightness in the file's unit (`BUNIT`); they are not calibrated photometry.

Full description: [docs/SCIENTIFIC_METHODS.md](docs/SCIENTIFIC_METHODS.md).

## Performance

Measured during development, in comments in `archive.py`: a cutout is about 4 MB, IRSA delivers it at roughly 250–350 KiB/s, and parsing plus reprojection takes about 0.07 s. Downloading therefore dominates, and the optimisations focus on avoiding repeat downloads.

- **Disk caches:** cutouts, aligned grids, archive searches, name resolutions and Gaia queries are cached. Grid cache keys include a processing version, so changing the processing automatically invalidates old grids.
- **Cutout reuse:** a larger cached cutout of the same file and centre is reused when you narrow the field of view.
- **Nested sampling:** the frames chosen for a smaller frame count are a subset of those for a larger count, so raising the count only fetches the extra frames.
- **Download control:**
  - Identical downloads are shared between requests.
  - A download is cancelled when nobody is waiting for it any more.
  - IRSA downloads are capped at 3 concurrent requests overall, with retries and back-off that honour `Retry-After`.
  - The browser loads 3 frames at a time and shows each as it arrives.
- **In-memory caches:** frame statistics and parsed cutouts for the Pixel Inspector are kept in memory. Sky-map polygons are projected once per search, not on every mouse move.

## Scientific limitations

The most important limitations:

- A residual or moving source is a **candidate for follow-up, not a discovery**. SPHERE TRACK does not claim to have discovered Planet X.
- A pipeline QA "Pass" is not proof that an image is free of artefacts.
- Brightness differences between frames can be caused by **different wavelengths**, not by change over time.
- Aligned-grid values are interpolated; pixels are large (about 6.2″), so only fast-moving sources show visible motion over the roughly one-year baseline.

Full list, with the validation evidence: [docs/SCIENTIFIC_LIMITATIONS.md](docs/SCIENTIFIC_LIMITATIONS.md).

## Installation (Windows)

**Requirements:** Windows 10 or 11, Python 3.11 or newer, Node.js 20 or newer, and an internet connection (data is fetched live from IRSA, CDS and ESA).

**One-click start:** double-click `start.bat` in the repository root. On first run it:

1. creates the Python environment in `backend\.venv` and installs `backend\requirements.txt`;
2. runs `npm install` in `frontend\`;
3. starts the backend and frontend in two windows;
4. opens http://localhost:5180 (the homepage; **Launch Explorer** opens the scientific app at `/explorer`).

Close the two server windows to stop the app.

**Manual start (two terminals):**

```powershell
# terminal 1: backend
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000

# terminal 2: frontend
cd frontend
npm install
npm run dev        # http://localhost:5180 homepage, /explorer app (proxies /api to :8000)
```

On macOS or Linux, use `.venv/bin/python` in place of `.\.venv\Scripts\python`. `start.bat` and the `test:backend` npm script are Windows-only.

The first load of a target downloads its cutouts from IRSA, which takes about 10–20 s per frame. Later loads come from the local cache in `backend/cache/`.

## Screenshots and demonstration

The homepage (`/`) shows real SPHEREx frames and screenshots of the Explorer, stored in `frontend/public/media/`:

- `barnard-d6-*.png`: three real Barnard's Star D6 frames (0.5° field), rendered by SPHERE TRACK from cached IRSA data. Provenance is shown beside each image on the homepage.
- `screens/*.webp`: viewer, difference, pixel inspector, dashboard, sky map and Pipeline QA, captured from the running Explorer showing real cached data. Regenerate them with `node scripts/capture-home-media.mjs` (in `frontend/`, both servers running; `CAPTURE_THEME=light` for the light theme).

**Suggested walk-through** (load each target once beforehand so it is cached):

1. Open http://localhost:5180, press **Launch Explorer**, and choose **Barnard's Star**. Press **Play**: the star moves across the sequence. Point out the measured metadata (date, wavelength at the target, pixel scale).
2. Switch to **Difference** with the earliest and latest frames. The red/blue pair at the centre is the star's motion. Note the wavelength warning and the registration offset.
3. Click a pixel to open the **Pixel Inspector** and show the difference between the interpolated grid value and the original FITS pixel.
4. Turn on the **Gaia DR3 overlay**: Barnard's Star's catalogued position, moved to each frame's date, follows the star.
5. Open the **Sky map** workspace, click a point to list every overlapping footprint, and show the **Dashboard**.
6. Open `?demo=1` to show how synthetic data is labelled.

Example shareable URL: `http://localhost:5180/explorer?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12` (Barnard's Star, D6). Older links of the form `/?ra=…` still open the Explorer with the same selection.

**Hosting note:** `/explorer` is handled in the browser, so a static host must serve `index.html` for that path (an SPA fallback). The Vite dev and preview servers already do this.

## Testing and validation

| Command (in `frontend/`) | What it runs |
|---|---|
| `npm run test:backend` | Backend pytest suite (90 tests). |
| `npm run check` | TypeScript type check and ESLint (application code and browser tests). |
| `npm run build` | Production build. |
| `npm run test:e2e` | All 13 browser suites, including the homepage suite (needs both servers running). The one check that needs live IRSA downloads reports SKIP, not FAIL, only when IRSA is confirmed down (HTTP 502/503/504, no connection, or retries exhausted). |
| `npm run test:e2e -- qa skymap` | Selected browser suites. |
| `npm run test:all` | All of the above, in order. |

The browser suites drive Microsoft Edge against real IRSA data and check results against independently computed values. For example, they confirm that:

- sky-map footprints match an independent gnomonic projection;
- overlap-inspector results match a spherical point-in-polygon test;
- pixel-inspector values match the API.

The latest verified results (2026-11-15) were 90/90 backend tests and 227/227 browser checks, repeated in two consecutive full runs. The type check, lint and production build were clean. Details: [docs/SCIENTIFIC_LIMITATIONS.md](docs/SCIENTIFIC_LIMITATIONS.md#validation-evidence).

## Team

| Member | Role and contributions |
|---|---|
| Kiaan Samir | *[to be completed by the team]* |
| Revant Ghimiray | *[to be completed by the team]* |
| Abhinav Kumar Singh | *[to be completed by the team]* |
| Arya Agarwala | *[to be completed by the team]* |

## AI-use disclosure

AI tools assisted development: Claude Code (implementation, debugging, refactoring, testing) and ChatGPT (planning, architecture discussion, troubleshooting, explanations, UI/UX guidance). The core idea, problem selection, scientific decisions, research and validation, product direction and final review are the team's. Details: [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).

## Disclaimer

SPHERE TRACK is an independent project created for the NASA International Space Apps Challenge 2026. It is **not endorsed by, sponsored by or affiliated with NASA**, Caltech/IPAC, the SPHEREx mission team, ESA, CDS or GAVO. Use of NASA data does not imply NASA endorsement.

**Demo-mode images are synthetic.** They are generated with NumPy and are not SPHEREx or NASA data.

**Acknowledgements:** this project uses data from SPHEREx, a NASA mission, obtained from the NASA/IPAC Infrared Science Archive, which is funded by NASA and operated by the California Institute of Technology. It uses the SIMBAD database, operated at CDS, Strasbourg, France, and data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC). The Gaia fallback uses the GAVO Data Center. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for full acknowledgements.
