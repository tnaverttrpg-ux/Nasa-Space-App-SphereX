"""Name resolution via CDS Sesame (SIMBAD), proper-motion propagation, and Gaia DR3 cone search."""
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote

import astropy.units as u
import httpx
import numpy as np
import pyvo
from astropy.coordinates import SkyCoord
from astropy.time import Time

from .archive import CACHE, ArchiveError
from .fitsproc import grid_wcs

SESAME = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?"
# ESA archive first; GAVO's gaia.dr3lite mirror (same DR3 values, epoch 2016.0) if ESA rate-limits (HTTP 429).
GAIA_SERVICES = [("https://gea.esac.esa.int/tap-server/tap", "gaiadr3.gaia_source"),
                 ("https://dc.g-vo.org/tap", "gaia.dr3lite")]
SEARCH_EPOCH = 2025.9  # mid-point of SPHEREx DR1 coverage (May 2025 - May 2026)

PRESETS = [
    {"id": "barnard", "label": "Barnard's Star", "query": "Barnard's Star", "why": "Highest proper motion star (~10.4\"/yr)"},
    {"id": "epsindib", "label": "Epsilon Indi B", "query": "eps Ind B", "why": "Nearby brown-dwarf binary, ~4.7\"/yr"},
    {"id": "wise0855", "label": "WISE 0855", "query": "WISE J085510.83-071442.5", "why": "Coldest known brown dwarf, ~8.1\"/yr",
     # Coordinate fixed by the challenge brief; SIMBAD's catalogue position differs.
     "fixed": {"ra": 133.795129, "dec": -7.245147, "source": "challenge brief (fixed)"}},
    {"id": "rwaur", "label": "RW Aurigae", "query": "RW Aur", "why": "Young star with deep dimming events"},
    {"id": "rdra", "label": "R Draconis", "query": "R Dra", "why": "Mira long-period variable"},
]


def resolve(name, timeout=20):
    f = CACHE / "resolve.json"
    cache = json.loads(f.read_text()) if f.exists() else {}
    if name in cache:
        return cache[name]
    try:
        r = httpx.get(SESAME + quote(name), timeout=timeout, follow_redirects=True)
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise ArchiveError(f"Sesame/SIMBAD resolver unavailable: {e}", 502)
    root = ET.fromstring(re.sub(r"<!--.*?-->", "", r.text, flags=re.S).strip())
    res = root.find(".//Resolver")
    if res is None or res.find("jradeg") is None:
        raise ArchiveError(f"SIMBAD could not resolve '{name}'", 404)
    num = lambda p: float(res.findtext(p)) if res.findtext(p) else None
    out = {
        "name": name,
        "simbad_id": res.findtext("oname"),
        "otype": res.findtext("otype"),
        "ra_j2000": num("jradeg"),
        "dec_j2000": num("jdedeg"),
        "pmra_masyr": num("pm/pmRA"),
        "pmdec_masyr": num("pm/pmDE"),
        "source": "SIMBAD via CDS Sesame",
    }
    out.update(propagate(out))
    cache[name] = out
    f.write_text(json.dumps(cache, indent=1))
    return out


def propagate(o, epoch=SEARCH_EPOCH):
    """SIMBAD positions are ICRS at epoch J2000; move high-proper-motion targets to the SPHEREx epoch."""
    if not o.get("pmra_masyr") or not o.get("pmdec_masyr"):
        return {"ra": o["ra_j2000"], "dec": o["dec_j2000"], "epoch": 2000.0}
    c = SkyCoord(o["ra_j2000"] * u.deg, o["dec_j2000"] * u.deg, pm_ra_cosdec=o["pmra_masyr"] * u.mas / u.yr,
                 pm_dec=o["pmdec_masyr"] * u.mas / u.yr, obstime=Time(2000.0, format="jyear"))
    with np.errstate(all="ignore"):
        c2 = c.apply_space_motion(new_obstime=Time(epoch, format="jyear"))
    return {"ra": round(float(c2.ra.deg), 6), "dec": round(float(c2.dec.deg), 6), "epoch": epoch}


def presets():
    out = []
    for p in PRESETS:
        item = {k: p[k] for k in ("id", "label", "why")}
        try:
            item["resolved"] = resolve(p["query"])
        except ArchiveError as e:
            item["resolved"], item["error"] = None, str(e)
        if "fixed" in p:
            item["ra"], item["dec"], item["coord_source"] = p["fixed"]["ra"], p["fixed"]["dec"], p["fixed"]["source"]
        elif item["resolved"]:
            r = item["resolved"]
            item["ra"], item["dec"] = r["ra"], r["dec"]
            item["coord_source"] = f"SIMBAD J2000, propagated to {r['epoch']}" if r["epoch"] != 2000.0 else "SIMBAD J2000"
        out.append(item)
    return out


def gaia_sources(ra, dec, fov, gmax=19.0, timeout=60):
    """Gaia DR3 sources with grid pixel position at epoch 2016.0 plus pixel motion per year (linear, small field)."""
    w, (n, _) = grid_wcs(ra, dec, fov)
    rad = fov * 0.75
    # Gaia DR3 is static: cache rows on disk so repeat views never re-query ESA (which rate-limits, HTTP 429).
    f = CACHE / "gaia" / f"{ra:.6f}_{dec:.6f}_{rad:.5f}_{gmax}.json"
    f.parent.mkdir(exist_ok=True)
    if f.exists():
        rows = json.loads(f.read_text())
    else:
        errs = []
        for url, table in GAIA_SERVICES:
            q = f"""SELECT TOP 400 source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM {table}
WHERE 1=CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',{ra:.6f},{dec:.6f},{rad:.5f})) AND phot_g_mean_mag < {gmax}
ORDER BY phot_g_mean_mag"""
            try:
                t = pyvo.dal.TAPService(url).run_sync(q, timeout=timeout).to_table()
                break
            except Exception as e:
                errs.append(f"{url}: {e}")
        else:
            raise ArchiveError("Gaia DR3 query failed: " + " | ".join(errs))
        fin = lambda v: float(v) if np.isfinite(v) else 0.0
        rows = [[str(r["source_id"]), float(r["ra"]), float(r["dec"]), fin(r["pmra"]), fin(r["pmdec"]),
                 float(r["phot_g_mean_mag"])] for r in t]
        f.write_text(json.dumps(rows))
    out = []
    for sid, sra, sdec, pmra, pmdec, g in rows:
        x, y = w.world_to_pixel_values(sra, sdec)
        s = w.wcs.cdelt[1] * 3600 * 1000  # mas per pixel
        out.append({"source_id": sid, "g": round(g, 2),
                    "x": float(x), "y": float(n - 1 - y),  # display coords (north up)
                    "dx_per_yr": -pmra / s, "dy_per_yr": -pmdec / s, "pmra": pmra, "pmdec": pmdec})
    return {"ref_epoch": 2016.0, "grid_size": n, "sources": out}
