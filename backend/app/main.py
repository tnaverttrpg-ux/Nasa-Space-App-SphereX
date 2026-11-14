"""SPHERE TRACK API."""
import asyncio
import base64
import functools
import hashlib
import io
import json
import threading
import time

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
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


def _save(key, arr, foot, meta, offdet=None):
    # npz first, json last, each via temp file + atomic rename: the json is the "grid is complete" marker.
    tmp = GRIDS / f"{key}.{threading.get_ident()}.tmp.npz"
    extra = {} if offdet is None else {"offdet": offdet}
    np.savez_compressed(tmp, arr=arr, foot=foot, **extra)
    _publish(tmp, GRIDS / f"{key}.npz")
    tmpj = GRIDS / f"{key}.{threading.get_ident()}.tmp.json"
    tmpj.write_text(json.dumps(meta))
    _publish(tmpj, GRIDS / f"{key}.json")


def _publish(tmp, dest):
    """Atomic rename. Two requests for the same frame produce identical, deterministic output; on Windows the second
    rename fails while the first file is open, so keep the existing file and drop the duplicate."""
    try:
        tmp.replace(dest)
    except PermissionError:
        if not dest.exists():
            raise
        tmp.unlink(missing_ok=True)


def _grid_ok(key):
    """A grid counts as cached only if its marker json AND a readable npz exist; damaged pairs are removed and rebuilt."""
    j, z = GRIDS / f"{key}.json", GRIDS / f"{key}.npz"
    if not j.exists():
        return False
    try:
        # Parse from memory: np.load on a corrupt file leaks its handle on Windows, which would block the cleanup below.
        with np.load(io.BytesIO(z.read_bytes())) as f:
            f["arr"], f["foot"]
        json.loads(j.read_text())
        return True
    except Exception:
        archive.log.warning("grid cache CORRUPT %s - removed, will rebuild", key)
        for p in (j, z):  # json (the "complete" marker) first; a leftover npz is simply overwritten on rebuild
            try:
                p.unlink(missing_ok=True)
            except OSError as e:
                archive.log.warning("could not remove %s: %s", p.name, e)
        return False


def _grid_key(url, ra, dec, fov):
    return hashlib.sha1(f"{fitsproc.PROC_VERSION}|{url}|{ra:.6f}|{dec:.6f}|{fov:.4f}".encode()).hexdigest()[:20]


def _cutout_size(fov):
    return min(fov * 1.5, 0.75)  # 1.5x so the rotated native frame still covers the corners of the north-up grid


def _load(key):
    if not key.replace("-", "").isalnum():
        raise HTTPException(400, "bad frame key")
    if key.startswith("demo-") and not (GRIDS / f"{key}.npz").exists():
        _demo_series()
    f = GRIDS / f"{key}.npz"
    if not f.exists():
        raise HTTPException(404, "frame not processed yet")
    with np.load(f) as z:  # close the handle: an open .npz blocks atomic renames on Windows
        arr, foot = z["arr"], z["foot"]
        offdet = z["offdet"] if "offdet" in z.files else None  # demo grids have none
    return arr, foot, json.loads((GRIDS / f"{key}.json").read_text()), offdet


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
                 collection: str = Query("spherex_dr1"), limit: int = Query(12, ge=2, le=48),
                 fov: float | None = Query(None, ge=0.02, le=0.5, description="If given, mark observations already cached")):
    if collection not in archive.COLLECTIONS:
        raise HTTPException(400, f"collection must be one of {archive.COLLECTIONS}")
    out = archive.query_observations(ra, dec, band, collection, limit)
    if fov is not None:
        for o in out["observations"]:
            o["cached"] = ("grid" if (GRIDS / f"{_grid_key(o['access_url'], ra, dec, fov)}.json").exists()
                           else "cutout" if archive.cached_cutout(o["access_url"], ra, dec, _cutout_size(fov)) else None)
    return out


@app.get("/api/frame")
async def frame(request: Request, url: str, ra: float = RA, dec: float = DEC, fov: float = FOV, exptime_s: float | None = None):
    """Cached grid, else cached cutout, else (deduplicated, rate-limited) IRSA download; then parse + reproject."""
    t0 = time.perf_counter()
    key = _grid_key(url, ra, dec, fov)
    if _grid_ok(key):
        archive.log.info("cache HIT grid %s", key)
        return {"key": key, **json.loads((GRIDS / f"{key}.json").read_text()), "timing": {"source": "grid", "total_s": round(time.perf_counter() - t0, 3)}}
    archive.check_url(url)
    size = _cutout_size(fov)
    path = archive.cached_cutout(url, ra, dec, size)
    raw = await run_in_threadpool(archive.read_cached, path) if path else None
    timing = {"source": "cutout-cache"}
    if raw is not None:
        archive.log.info("cache HIT cutout %s", path.name)
    else:
        job, shared = archive.acquire_cutout(url, ra, dec, size)
        fut = asyncio.wrap_future(job.future)
        try:
            while not fut.done():
                await asyncio.wait({fut}, timeout=0.5)
                if not fut.done() and await request.is_disconnected():
                    archive.log.info("client went away while waiting for %s (shared=%s)", url.rsplit("/", 1)[-1], shared)
                    return Response(status_code=499)
        finally:
            archive.release_cutout(job)
        try:
            raw, info = fut.result()
        except archive.Cancelled:
            return Response(status_code=499)
        timing = {"source": "shared-download" if shared else "download", **info}
    t1 = time.perf_counter()
    try:
        arr, foot, meta, offdet = await run_in_threadpool(fitsproc.process_cutout, raw, ra, dec, fov)
    except Exception as e:
        raise HTTPException(422, f"FITS processing failed: {e}")
    meta.update({"source_url": url, "exptime_s": exptime_s, "grid": {"ra": ra, "dec": dec, "fov": fov}, "demo": False})
    await run_in_threadpool(_save, key, arr, foot, meta, offdet)
    timing.update({"process_s": round(time.perf_counter() - t1, 3), "total_s": round(time.perf_counter() - t0, 2)})
    return {"key": key, **meta, "timing": timing}


@app.get("/api/frame/{key}.png")
def frame_png(key: str, stretch: str = Query("asinh", pattern="^(asinh|linear)$"),
              cmap: str = Query("inferno", pattern="^(inferno|gray|viridis|magma)$")):
    arr, _, _, offdet = _load(key)
    return Response(fitsproc.render(arr, stretch, cmap, offdet), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@functools.lru_cache(maxsize=512)
def _stats_cached(key):
    arr, foot, meta, offdet = _load(key)
    out = fitsproc.grid_stats(arr, foot, offdet)
    out.update({"key": key, "quantity": "aligned-grid surface brightness", "unit": meta.get("bunit") or "unknown",
                "calibrated_photometry": False, "demo": bool(meta.get("demo"))})
    return out


@app.get("/api/frame/{key}/stats")
def frame_stats(key: str):
    """Histogram + statistics of one processed grid (valid, on-detector pixels only). Cached in memory per grid key
    (keys are versioned). No browser caching: results also depend on the statistics method, which can change
    without the grid key changing; the frontend keeps its own per-session cache."""
    return JSONResponse(_stats_cached(key), headers={"Cache-Control": "no-cache"})


@app.get("/api/diff")
def diff(a: str, b: str, nsig: float = Query(5.0, ge=3, le=20)):
    arr_a, fa, ma, oa = _load(a)
    arr_b, fb, mb, ob = _load(b)
    if arr_a.shape != arr_b.shape:
        raise HTTPException(400, "frames are on different grids")
    g = ma["grid"]
    w, _ = fitsproc.grid_wcs(g["ra"], g["dec"], g["fov"])
    offdet = None if oa is None or ob is None else (oa | ob)  # not observed in A or in B
    out = fitsproc.difference(arr_a, fa, arr_b, fb, w, nsig, offdet=offdet)
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
