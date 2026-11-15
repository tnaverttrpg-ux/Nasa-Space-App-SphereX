# Data sources and attribution

This document lists every external data source SPHERE TRACK contacts, as implemented in `backend/app/archive.py` and `backend/app/resolver.py`. The app contacts no other services. Links and acknowledgement texts should be re-checked against the providers' pages before submission (see the [submission checklist](SUBMISSION_CHECKLIST.md)).

## Summary

| Source | Used for | Endpoint in the code | Cached locally |
|---|---|---|---|
| NASA/IPAC IRSA, SIA2 | Finding SPHEREx images that contain a position | `https://irsa.ipac.caltech.edu/SIA` | `backend/cache/sia/` |
| NASA/IPAC IRSA, IBE cutout service | Downloading cutouts of those images | `https://irsa.ipac.caltech.edu/ibe/data/spherex/…?center=…&size=…` | `backend/cache/cutouts/` |
| CDS Sesame (SIMBAD) | Resolving object names; J2000 positions and proper motions | `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?` | `backend/cache/resolve.json` |
| ESA Gaia archive (TAP) | Gaia DR3 overlay | `https://gea.esac.esa.int/tap-server/tap`, table `gaiadr3.gaia_source` | `backend/cache/gaia/` |
| GAVO Data Center (TAP) | Fallback for the Gaia DR3 overlay | `https://dc.g-vo.org/tap`, table `gaia.dr3lite` | `backend/cache/gaia/` |

## SPHEREx (NASA/IPAC Infrared Science Archive)

- **Mission:** SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer), a NASA mission. Links: https://science.nasa.gov/mission/spherex/ and https://spherex.caltech.edu
- **Archive:** NASA/IPAC Infrared Science Archive (IRSA), https://irsa.ipac.caltech.edu. SPHEREx at IRSA: https://irsa.ipac.caltech.edu/Missions/spherex.html
- **Data release:** SPHEREx Data Release 1, archive collection **`spherex_dr1`**.
  - The interface always uses this collection.
  - The backend API also accepts `spherex_qr3`, but the interface never requests it.
  - The code assumes DR1 covers roughly May 2025 to May 2026 (`resolver.SEARCH_EPOCH` comment).
- **Products used:** Level 2 science images (`dataproduct_subtype = science`). From each cutout the app reads:
  - the `IMAGE` extension;
  - the `FLAGS` extension;
  - the primary and image headers;
  - the spectral WCS (`WCS-WAVE`).

  Other extensions (`VARIANCE`, `ZODI`, `EPSF`) are present in the files but not used.
- **Access:**
  - Search by IVOA SIA2; cutouts from the IRSA IBE cutout service.
  - Only cutouts (1.5 × the field of view, at most 0.75°) are downloaded, never full images.
  - Downloads are limited to 3 concurrent requests, with retries and back-off that honour `Retry-After`.
- **Acknowledgement (IRSA):** "This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology."
- **Acknowledgement (SPHEREx):** "This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration."
  - **To verify:** the team must check this wording against the acknowledgement IRSA publishes for SPHEREx data before submission.

## SIMBAD via CDS Sesame

- **Service:** Sesame name resolver, Centre de Données astronomiques de Strasbourg (CDS). Links: https://cds.unistra.fr/cgi-bin/Sesame and SIMBAD at https://simbad.cds.unistra.fr/simbad/
- **Used for:** the five preset targets and the name search box. The app reads the J2000 ICRS position and proper motion, and propagates the position to epoch 2025.9 (see [methods §14](SCIENTIFIC_METHODS.md#14-target-resolution)).
  - WISE 0855 instead uses the coordinate fixed by the challenge brief.
- **Acknowledgement:** "This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France."
- **Reference:** Wenger, M. et al. 2000, *A&AS* 143, 9, "The SIMBAD astronomical database".

## ESA Gaia DR3

- **Mission and release:** ESA Gaia, Data Release 3. Link: https://www.cosmos.esa.int/web/gaia/dr3
- **Primary service:** ESA Gaia archive TAP, https://gea.esac.esa.int/tap-server/tap, table `gaiadr3.gaia_source`.
- **Query:** `source_id, ra, dec, pmra, pmdec, phot_g_mean_mag`, cone radius 0.75 × FOV, G < 19, brightest 400 sources.
- **Fallback:** if the ESA query fails for any reason (for example when ESA rate-limits with HTTP 429), the same query is sent to the GAVO Data Center mirror.
  - Service: https://dc.g-vo.org/tap, table `gaia.dr3lite`, a reduced copy of the DR3 source table with the same DR3 values at epoch 2016.0.
- **Acknowledgement:** "This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement."
  - Credit guidelines: https://www.cosmos.esa.int/web/gaia-users/credits
- **References:**
  - Gaia Collaboration, Prusti, T. et al. 2016, *A&A* 595, A1 (the Gaia mission).
  - Gaia Collaboration, Vallenari, A. et al. 2023, *A&A* 674, A1 (Gaia DR3 summary).
- **GAVO acknowledgement:** "This work uses the GAVO Data Center, operated by the German Astrophysical Virtual Observatory (GAVO)." Link: https://dc.g-vo.org

## Software

SPHERE TRACK is built on open-source software, including:

- **Python:** Astropy, reproject, PyVO, NumPy, Matplotlib, Pillow, FastAPI, Uvicorn and httpx.
- **Frontend:** React, Vite, Tailwind CSS, Lucide and Sonner.
- **Astropy citation:** the Astropy project requests citation of Astropy Collaboration 2013 (*A&A* 558, A33), 2018 (*AJ* 156, 123) and 2022 (*ApJ* 935, 167).

## Synthetic data

Demo mode (`?demo=1`) uses images generated procedurally with NumPy (`backend/app/demo.py`). They are **not** SPHEREx, NASA or any other observatory's data, and are labelled as synthetic in the interface.

## NASA non-endorsement

SPHERE TRACK is an independent project created for the NASA International Space Apps Challenge 2026. It is **not endorsed by, sponsored by or affiliated with** NASA, JPL, Caltech/IPAC, the SPHEREx mission team, ESA, CDS or GAVO. Use of NASA data, and of the NASA and SPHEREx names to describe the data, does not imply endorsement. The project does not use the NASA insignia ("meatball") or other NASA logos.

- NASA media usage guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/
- **To verify:** the team should also check whether the Space Apps Challenge requires its own disclaimer text.
