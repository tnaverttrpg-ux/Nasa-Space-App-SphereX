"""IRSA SPHEREx archive access: SIA2 discovery + IBE cutout download with a local disk cache."""
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from pathlib import Path

import httpx
import numpy as np
import pyvo

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


def _sia_rows(ra, dec, collection):
    key = hashlib.sha1(f"{ra:.6f}|{dec:.6f}|{collection}".encode()).hexdigest()[:20]
    f = CACHE / "sia" / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())
    sia = pyvo.dal.SIA2Service(SIA_URL)
    # A tiny circle = "images that contain this position".
    t = sia.search(pos=(ra, dec, 0.0005), collection=collection).to_table()
    rows = []
    for r in t:
        if str(r["dataproduct_subtype"]) != "science":
            continue
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
        })
    rows.sort(key=lambda x: x["mjd_start"])
    f.write_text(json.dumps(rows))
    return rows


def query_observations(ra, dec, band, collection, limit, timeout=90):
    try:
        rows = _pool.submit(_sia_rows, ra, dec, collection).result(timeout=timeout)
    except FutTimeout:
        raise ArchiveError("IRSA SIA2 query timed out", 504)
    except Exception as e:  # network / DAL errors
        raise ArchiveError(f"IRSA SIA2 query failed: {e}")
    counts = {b: sum(r["band"] == b for r in rows) for b in BANDS}
    sel = [r for r in rows if r["band"] == band]
    total = len(sel)
    if total > limit:  # evenly sample the full time baseline rather than taking the first N
        sel = [sel[i] for i in np.unique(np.linspace(0, total - 1, limit).round().astype(int))]
    return {"total_in_band": total, "band_counts": counts, "observations": sel}


def fetch_cutout(access_url, ra, dec, size_deg, timeout=150):
    """Download an IBE cutout (official IRSA cutout service: ?center=&size=). Returns FITS bytes."""
    if not access_url.startswith(ALLOWED_PREFIX) or "?" in access_url:
        raise ArchiveError("access_url is not an IRSA SPHEREx file URL", 400)
    url = f"{access_url}?center={ra:.6f},{dec:.6f}&size={size_deg:.5f}"
    f = CACHE / "cutouts" / (hashlib.sha1(url.encode()).hexdigest()[:24] + ".fits")
    if f.exists():
        return f.read_bytes()
    for attempt in range(3):  # IRSA returns sporadic 503s under load
        try:
            r = httpx.get(url, timeout=timeout, follow_redirects=True)
        except httpx.TimeoutException:
            raise ArchiveError("IRSA cutout request timed out", 504)
        except httpx.HTTPError as e:
            raise ArchiveError(f"IRSA cutout request failed: {e}")
        if r.status_code < 500:
            break
        time.sleep(3 * (attempt + 1))
    if r.status_code != 200 or not r.content.startswith(b"SIMPLE"):
        raise ArchiveError(f"IRSA cutout service returned HTTP {r.status_code}")
    tmp = f.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(f)
    return r.content
