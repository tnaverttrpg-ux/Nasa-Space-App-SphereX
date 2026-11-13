"""SPHERE TRACK API."""
import base64
import hashlib
import json

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import archive, demo, fitsproc, resolver
from .archive import CACHE, ArchiveError

app = FastAPI(title="SPHERE TRACK API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
GRIDS = CACHE / "grids"
GRIDS.mkdir(parents=True, exist_ok=True)

RA = Query(..., ge=0, lt=360, description="Right ascension, decimal degrees (ICRS)")
DEC = Query(..., ge=-90, le=90, description="Declination, decimal degrees (ICRS)")
FOV = Query(0.1, ge=0.02, le=0.5, description="Field of view, degrees")


@app.exception_handler(ArchiveError)
def _archive_err(_, e: ArchiveError):
    return JSONResponse({"detail": str(e)}, status_code=e.status)


def _save(key, arr, foot, meta):
    np.savez_compressed(GRIDS / f"{key}.npz", arr=arr, foot=foot)
    (GRIDS / f"{key}.json").write_text(json.dumps(meta))


def _load(key):
    if not key.replace("-", "").isalnum():
        raise HTTPException(400, "bad frame key")
    if key.startswith("demo-") and not (GRIDS / f"{key}.npz").exists():
        _demo_series()
    f = GRIDS / f"{key}.npz"
    if not f.exists():
        raise HTTPException(404, "frame not processed yet")
    z = np.load(f)
    return z["arr"], z["foot"], json.loads((GRIDS / f"{key}.json").read_text())


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/presets")
def presets():
    return resolver.presets()


@app.get("/api/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=100)):
    return resolver.resolve(name)


@app.get("/api/observations")
def observations(ra: float = RA, dec: float = DEC, band: str = Query("D3", pattern="^D[1-6]$"),
                 collection: str = Query("spherex_dr1"), limit: int = Query(12, ge=2, le=48)):
    if collection not in archive.COLLECTIONS:
        raise HTTPException(400, f"collection must be one of {archive.COLLECTIONS}")
    return archive.query_observations(ra, dec, band, collection, limit)


@app.get("/api/frame")
def frame(url: str, ra: float = RA, dec: float = DEC, fov: float = FOV, exptime_s: float | None = None):
    """Download (cached) cutout, parse FITS, reproject onto the series grid. Returns measured metadata."""
    key = hashlib.sha1(f"{fitsproc.PROC_VERSION}|{url}|{ra:.6f}|{dec:.6f}|{fov:.4f}".encode()).hexdigest()[:20]
    if (GRIDS / f"{key}.json").exists():
        return {"key": key, **json.loads((GRIDS / f"{key}.json").read_text())}
    # 1.5x so the rotated native frame still covers the corners of the north-up grid
    raw = archive.fetch_cutout(url, ra, dec, min(fov * 1.5, 0.75))
    try:
        arr, foot, meta = fitsproc.process_cutout(raw, ra, dec, fov)
    except Exception as e:
        raise HTTPException(422, f"FITS processing failed: {e}")
    meta.update({"source_url": url, "exptime_s": exptime_s, "grid": {"ra": ra, "dec": dec, "fov": fov}, "demo": False})
    _save(key, arr, foot, meta)
    return {"key": key, **meta}


@app.get("/api/frame/{key}.png")
def frame_png(key: str, stretch: str = Query("asinh", pattern="^(asinh|linear)$"),
              cmap: str = Query("inferno", pattern="^(inferno|gray|viridis|magma)$")):
    arr, _, _ = _load(key)
    return Response(fitsproc.render(arr, stretch, cmap), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/diff")
def diff(a: str, b: str, nsig: float = Query(5.0, ge=3, le=20)):
    arr_a, fa, ma = _load(a)
    arr_b, fb, mb = _load(b)
    if arr_a.shape != arr_b.shape:
        raise HTTPException(400, "frames are on different grids")
    g = ma["grid"]
    w, _ = fitsproc.grid_wcs(g["ra"], g["dec"], g["fov"])
    out = fitsproc.difference(arr_a, fa, arr_b, fb, w, nsig)
    out["png"] = "data:image/png;base64," + base64.b64encode(out["png"]).decode()
    out["kind"] = "derived"
    out["demo"] = bool(ma.get("demo"))
    wa, wb = ma.get("wavelength_at_target"), mb.get("wavelength_at_target")
    out["wavelength_mismatch_um"] = round(abs(wa["center_um"] - wb["center_um"]), 4) if wa and wb else None
    return out


@app.get("/api/gaia")
def gaia(ra: float = RA, dec: float = DEC, fov: float = FOV):
    return resolver.gaia_sources(ra, dec, fov)


def _demo_series():
    fov = demo.SIZE * fitsproc.GRID_SCALE_DEG
    out = []
    for i, (arr, foot, meta) in enumerate(demo.demo_frames()):
        meta.update({"demo": True, "grid": {"ra": 0.0, "dec": 0.0, "fov": fov}})
        _save(f"demo-{i}", arr, foot, meta)
        out.append({"key": f"demo-{i}", **meta})
    return out


@app.get("/api/demo")
def demo_series():
    return {"demo": True, "label": "SYNTHETIC DEMO - not SPHEREx data", "frames": _demo_series()}
