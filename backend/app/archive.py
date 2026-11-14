"""IRSA SPHEREx archive access: SIA2 discovery + IBE cutout download with a local disk cache."""
import hashlib
import io
import json
import logging
import os
import random
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutTimeout
from pathlib import Path

import httpx
import numpy as np
import pyvo
from astropy.io import fits

log = logging.getLogger("spheretrack")
if not log.handlers:  # uvicorn configures only its own loggers
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s spheretrack %(levelname)s %(message)s", "%H:%M:%S"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
ALLOWED_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
BANDS = ("D1", "D2", "D3", "D4", "D5", "D6")

CACHE = Path(__file__).resolve().parent.parent / "cache"
(CACHE / "cutouts").mkdir(parents=True, exist_ok=True)
(CACHE / "sia").mkdir(parents=True, exist_ok=True)

_pool = ThreadPoolExecutor(max_workers=4)


class ArchiveError(Exception):
    def __init__(self, msg, status=502):
        super().__init__(msg)
        self.status = status


# Archive-search cache format. v1 = plain list of rows (no footprints). v2 = {"version": 2, "rows": [...]} with the
# original SIA2 s_region kept verbatim. v1 files are never deleted: they are the fallback when IRSA is unreachable.
SIA_CACHE_VERSION = 2


def _sia_file(ra, dec, collection, version):
    base = f"{ra:.6f}|{dec:.6f}|{collection}"
    key = hashlib.sha1((base if version == 1 else f"v{version}|{base}").encode()).hexdigest()[:20]
    return CACHE / "sia" / f"{key}.json"


def _query_sia(ra, dec, collection):
    sia = pyvo.dal.SIA2Service(SIA_URL)
    # A tiny circle = "images that contain this position".
    t = sia.search(pos=(ra, dec, 0.0005), collection=collection).to_table()
    rows = []
    for r in t:
        if str(r["dataproduct_subtype"]) != "science":
            continue
        sreg = r["s_region"] if "s_region" in t.colnames else None
        rows.append({
            "obs_id": str(r["obs_id"]),
            "band": str(r["energy_bandpassname"]).replace("SPHEREx-", ""),
            "access_url": str(r["access_url"]),
            "mjd_start": float(r["t_min"]),
            "mjd_end": float(r["t_max"]),
            "exptime_s": float(r["t_exptime"]),
            "em_min_um": float(r["em_min"]) * 1e6,
            "em_max_um": float(r["em_max"]) * 1e6,
            "collection": str(r["obs_collection"]),
            "s_region": None if sreg is None or np.ma.is_masked(sreg) else str(sreg),
        })
    rows.sort(key=lambda x: x["mjd_start"])
    return rows


def _sia_rows(ra, dec, collection):
    f2 = _sia_file(ra, dec, collection, SIA_CACHE_VERSION)
    if f2.exists():
        try:
            data = json.loads(f2.read_text())
            if isinstance(data, dict) and data.get("version") == SIA_CACHE_VERSION:
                return data["rows"]
        except (ValueError, KeyError):
            pass                                            # unreadable v2 file: re-query below (it is overwritten)
    try:
        rows = _query_sia(ra, dec, collection)
    except Exception as e:
        f1 = _sia_file(ra, dec, collection, 1)
        if f1.exists():                                     # old cache without footprints: still usable, say why
            log.warning("IRSA unreachable for footprint refresh (%s); using v1 search cache without footprints", e)
            return [{**r, "s_region": None, "footprint_unavailable": "cached search predates footprints and IRSA could not be reached"}
                    for r in json.loads(f1.read_text())]
        raise
    tmp = f2.with_name(f2.name + f".{threading.get_ident()}.part")
    tmp.write_text(json.dumps({"version": SIA_CACHE_VERSION, "rows": rows}))
    tmp.replace(f2)
    return rows


def parse_s_region(s_region, unavailable=None):
    """ObsCore s_region -> {"status": ok|missing|invalid|unavailable, "vertices": [[ra, dec], ...], "frame", "reason"}.
    Only POLYGON in ICRS (explicit, or omitted as ObsCore mandates) is accepted. Vertices are returned exactly as given
    (RA normalised to [0, 360)); the closing duplicate vertex is dropped. Nothing is approximated or invented."""
    if unavailable:
        return {"status": "unavailable", "vertices": None, "frame": None, "reason": unavailable}
    if s_region is None or not str(s_region).strip():
        return {"status": "missing", "vertices": None, "frame": None, "reason": "no s_region in the archive record"}
    bad = lambda why: {"status": "invalid", "vertices": None, "frame": None, "reason": why}
    tok = str(s_region).replace(",", " ").split()
    if tok[0].upper() != "POLYGON":
        return bad(f"unsupported region shape '{tok[0]}'")
    rest, frame = tok[1:], "ICRS"
    if rest and not _is_number(rest[0]):
        frame = rest[0].upper()
        rest = rest[1:]
        if frame not in ("ICRS", "J2000", "FK5"):
            return bad(f"unsupported frame '{frame}'")
    if len(rest) % 2 or not all(_is_number(t) for t in rest):
        return bad("coordinates are not RA/Dec number pairs")
    v = [[float(rest[i]), float(rest[i + 1])] for i in range(0, len(rest), 2)]
    if len(v) > 1 and v[0] == v[-1]:
        v = v[:-1]                                          # closed polygon: drop repeated first vertex
    if len(v) < 3 or len(v) > 100:
        return bad(f"{len(v)} vertices (need 3-100)")
    if not all(np.isfinite(c) for p in v for c in p):
        return bad("non-finite coordinate")
    if any(not (-90 <= d <= 90) for _, d in v) or any(not (0 <= r <= 360) for r, _ in v):
        return bad("coordinate out of range")
    v = [[r % 360.0, d] for r, d in v]
    # non-degenerate: positive area on the tangent plane at the vertex centroid
    xyz = np.array([[np.cos(np.radians(d)) * np.cos(np.radians(r)), np.cos(np.radians(d)) * np.sin(np.radians(r)), np.sin(np.radians(d))] for r, d in v])
    c = xyz.mean(0); c /= np.linalg.norm(c)
    e = np.cross([0, 0, 1], c); e = e / np.linalg.norm(e) if np.linalg.norm(e) > 1e-12 else np.array([1.0, 0, 0]); nvec = np.cross(c, e)
    px, py = (xyz @ e) / (xyz @ c), (xyz @ nvec) / (xyz @ c)
    area = 0.5 * abs(np.dot(px, np.roll(py, -1)) - np.dot(py, np.roll(px, -1)))
    if not np.all(xyz @ c > 0) or area < 1e-10:
        return bad("degenerate polygon (zero area)")
    return {"status": "ok", "vertices": v, "frame": frame, "reason": None}


def _is_number(t):
    try:
        float(t)
        return True
    except ValueError:
        return False


def _with_footprint(r):
    return {**{k: v for k, v in r.items() if k != "footprint_unavailable"},
            "footprint": parse_s_region(r.get("s_region"), r.get("footprint_unavailable"))}


def query_observations(ra, dec, band, collection, limit, timeout=90, include_all=False):
    try:
        rows = _pool.submit(_sia_rows, ra, dec, collection).result(timeout=timeout)
    except FutTimeout:
        raise ArchiveError("IRSA SIA2 query timed out", 504)
    except Exception as e:  # network / DAL errors
        raise ArchiveError(f"IRSA SIA2 query failed: {e}")
    counts = {b: sum(r["band"] == b for r in rows) for b in BANDS}
    in_band = [r for r in rows if r["band"] == band]
    total = len(in_band)
    sel = [in_band[i] for i in nested_sample(total, limit)] if total > limit else in_band
    out = {"total_in_band": total, "band_counts": counts, "observations": [_with_footprint(r) for r in sel],
           "target": {"ra": ra, "dec": dec}}
    if include_all:                                          # every observation in the band (for the sky map)
        out["all_observations"] = [_with_footprint(r) for r in in_band]
    return out


def nested_sample(total, limit):
    """Indices of `limit` observations spread over the whole time baseline, chosen so that the set for a smaller
    limit is contained in the set for a larger one (van der Corput order: ends, middle, quarters, ...).
    Changing the frame count therefore only fetches the additional frames instead of a different sample."""
    limit = min(limit, total)
    order, seen, k = [], set(), 0
    for u in (0.0, 1.0):
        i = round(u * (total - 1))
        seen.add(i); order.append(i)
    while len(order) < limit:
        k += 1
        n, d, u = k, 0.5, 0.0
        while n:  # base-2 radical inverse of k
            u += d * (n & 1); n >>= 1; d /= 2
        i = round(u * (total - 1))
        if i not in seen:
            seen.add(i); order.append(i)
    return sorted(order[:limit])


# ---------------------------------------------------------------------------------------------------------------
# Cutouts (official IRSA IBE cutout service: <access_url>?center=ra,dec&size=deg).
# Profiling: a cutout is ~4 MB regardless of size (mostly the EPSF table) and IRSA delivers ~250-350 KiB/s per
# connection, so download time dominates (10-16 s) while parsing + reprojection take ~0.07 s.
# ---------------------------------------------------------------------------------------------------------------
IRSA_CONCURRENCY = max(1, int(os.environ.get("SPHERETRACK_IRSA_CONCURRENCY", "3")))
MAX_ATTEMPTS = 5
RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
TIMEOUT = httpx.Timeout(connect=15, read=60, write=15, pool=30)  # read = max gap between chunks, not total time

_irsa_slots = threading.BoundedSemaphore(IRSA_CONCURRENCY)  # global cap across all users/tabs
_client = httpx.Client(timeout=TIMEOUT, follow_redirects=True)  # keep-alive; thread-safe
_dl_pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="cutout")
_inflight: dict[str, "CutoutJob"] = {}
_inflight_lock = threading.Lock()


class Cancelled(Exception):
    """Every requester of an in-flight download went away."""


class CutoutJob:
    def __init__(self):
        self.future: Future = Future()
        self.cancel = threading.Event()
        self.waiters = 0


def check_url(access_url):
    if not access_url.startswith(ALLOWED_PREFIX) or "?" in access_url:
        raise ArchiveError("access_url is not an IRSA SPHEREx file URL", 400)


def _prefix(access_url, ra, dec):
    return hashlib.sha1(f"{access_url}|{ra:.6f}|{dec:.6f}".encode()).hexdigest()[:24]


def _ibe_url(access_url, ra, dec, size):
    return f"{access_url}?center={ra:.6f},{dec:.6f}&size={size:.5f}"


def _valid_fits(data):
    """A cached/downloaded cutout is usable only if complete (whole 2880-byte blocks) and has a science image."""
    if not data.startswith(b"SIMPLE") or len(data) % 2880:
        return False
    try:
        from .fitsproc import science_hdu
        with fits.open(io.BytesIO(data)) as h:
            return science_hdu(h).data is not None
    except Exception:
        return False


def cached_cutout(access_url, ra, dec, size):
    """Path of a valid cached cutout for this file + centre at least `size` wide, else None.
    A larger cutout with the same centre contains the smaller field, so narrowing the FOV reuses it."""
    best = None
    for f in (CACHE / "cutouts").glob(_prefix(access_url, ra, dec) + "_*.fits"):
        s = float(f.stem.split("_", 1)[1])
        if s >= size - 1e-9 and (best is None or s < best[0]):
            best = (s, f)
    if best is None:  # v1 files were named by the hash of the exact cutout URL (size = 1.5 x FOV): migrate on use
        for s in sorted({round(min(f / 100 * 1.5, 0.75), 5) for f in range(2, 51)}):
            if s < size - 1e-9:
                continue
            legacy = CACHE / "cutouts" / (hashlib.sha1(_ibe_url(access_url, ra, dec, s).encode()).hexdigest()[:24] + ".fits")
            if legacy.exists():
                best = (s, legacy.rename(_cutout_path(access_url, ra, dec, s)))
                break
    return best[1] if best else None


def _cutout_path(access_url, ra, dec, size):
    return CACHE / "cutouts" / f"{_prefix(access_url, ra, dec)}_{size:.5f}.fits"


def read_cached(path):
    """Bytes of a cached cutout, or None (and the file removed) if it is incomplete/corrupt."""
    data = path.read_bytes()
    if _valid_fits(data):
        return data
    log.warning("cache CORRUPT %s - deleted, will re-download", path.name)
    path.unlink(missing_ok=True)
    return None


def acquire_cutout(access_url, ra, dec, size):
    """Join (dedupe) or start the download of one cutout. Caller must release_cutout(job) when done waiting."""
    dest = _cutout_path(access_url, ra, dec, size)
    key = str(dest)
    with _inflight_lock:
        job = _inflight.get(key)
        shared = job is not None and not job.cancel.is_set()
        if not shared:
            job = CutoutJob()
            _inflight[key] = job
            _dl_pool.submit(_run_job, job, key, _ibe_url(access_url, ra, dec, size), dest)
        job.waiters += 1
    return job, shared


def release_cutout(job):
    """Drop one waiter; when nobody is waiting any more an unfinished download is cancelled (nothing is cached)."""
    with _inflight_lock:
        job.waiters -= 1
        if job.waiters <= 0 and not job.future.done():
            job.cancel.set()


def _run_job(job, key, url, dest):
    try:
        job.future.set_result(_download(job, url, dest))
    except Cancelled as e:
        log.info("download CANCELLED (no requester left) %s", dest.name)
        job.future.set_exception(e)
    except BaseException as e:  # noqa: BLE001 - delivered to every waiter
        job.future.set_exception(e)
    finally:
        with _inflight_lock:
            if _inflight.get(key) is job:
                del _inflight[key]


def _backoff(attempt, retry_after=None):
    """Exponential backoff with jitter (1.5, 3, 6, 12 s ±50 %), or the server's Retry-After if it sent one."""
    if retry_after:
        try:
            return min(30.0, float(retry_after))
        except ValueError:
            pass
    return min(20.0, 1.5 * 2 ** (attempt - 1)) * random.uniform(0.5, 1.5)


def _download(job, url, dest):
    t_start = time.perf_counter()
    for attempt in range(1, MAX_ATTEMPTS + 1):
        while not _irsa_slots.acquire(timeout=0.5):  # wait for a global IRSA slot, but stay cancellable
            if job.cancel.is_set():
                raise Cancelled()
        retry_after, data = None, None
        try:
            with _client.stream("GET", url) as r:
                status, retry_after = r.status_code, r.headers.get("retry-after")
                if status == 200:
                    buf = bytearray()
                    for chunk in r.iter_bytes(65536):
                        if job.cancel.is_set():
                            raise Cancelled()
                        buf += chunk
                    data = bytes(buf)
        except httpx.TimeoutException:
            status = "timeout"
        except httpx.TransportError as e:
            status = f"network error ({type(e).__name__})"
        finally:
            _irsa_slots.release()

        if data is not None and _valid_fits(data):
            tmp = dest.with_name(dest.name + f".{threading.get_ident()}.part")
            tmp.write_bytes(data)
            tmp.replace(dest)  # atomic: a crash never leaves a half-written file under the real name
            dt = time.perf_counter() - t_start
            log.info("cache MISS -> downloaded %s (%.0f KB, %.1fs, attempt %d)", dest.name, len(data) / 1024, dt, attempt)
            return data, {"download_s": round(dt, 2), "attempts": attempt, "bytes": len(data)}
        if data is not None:
            status = "incomplete FITS"
        transient = status in RETRYABLE or not isinstance(status, int)
        if not transient:  # 4xx etc.: retrying will not help
            raise ArchiveError(f"IRSA cutout service returned HTTP {status}", 404 if status == 404 else 502)
        if attempt == MAX_ATTEMPTS:
            raise ArchiveError(f"IRSA cutout failed after {attempt} attempts (last: {status})", 504 if status == "timeout" else 502)
        delay = _backoff(attempt, retry_after)
        log.info("IRSA %s for %s - retry %d/%d in %.1fs", status, dest.name, attempt, MAX_ATTEMPTS - 1, delay)
        if job.cancel.wait(delay):
            raise Cancelled()
    raise AssertionError("unreachable")


def fetch_cutout(access_url, ra, dec, size_deg):
    """Blocking helper (scripts/tests): cached bytes or a deduplicated download."""
    check_url(access_url)
    path = cached_cutout(access_url, ra, dec, size_deg)
    data = read_cached(path) if path else None
    if data is not None:
        return data
    job, _ = acquire_cutout(access_url, ra, dec, size_deg)
    try:
        return job.future.result()[0]
    finally:
        release_cutout(job)
