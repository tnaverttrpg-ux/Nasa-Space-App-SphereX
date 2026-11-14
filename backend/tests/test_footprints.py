"""Observation footprints: s_region preservation/parsing, archive-cache versioning, fallbacks, API exposure."""
import json

import pytest
from astropy.table import Table
from fastapi.testclient import TestClient

from app import archive, main

REAL = ("POLYGON ICRS 266.69818339020907 5.472469522295728 270.1773378537016 5.149486050441448 "
        "269.9973138381142 1.660074934294828 266.5011710028342 1.9904353173956755 266.69818339020907 5.472469522295728")
RA, DEC = 268.3, 3.5


class FakeSIA:
    calls = 0
    fail = False
    s_regions = [REAL, None, "POLYGON ICRS 1 2 3"]

    def __init__(self, url): pass

    def search(self, pos, collection):
        FakeSIA.calls += 1
        if FakeSIA.fail:
            raise ConnectionError("IRSA down")
        rows = [("science", f"obs{i}", "SPHEREx-D6", f"https://irsa.ipac.caltech.edu/ibe/data/spherex/x/{i}.fits",
                 60800.0 + i, 60800.01 + i, 113.6, 4.4e-6, 5.0e-6, "spherex_dr1", sr) for i, sr in enumerate(FakeSIA.s_regions)]
        rows.append(("calibration", "cal", "SPHEREx-D6", "u", 1.0, 1.0, 1.0, 1e-6, 1e-6, "spherex_dr1", REAL))
        t = Table(rows=rows, names=("dataproduct_subtype", "obs_id", "energy_bandpassname", "access_url", "t_min", "t_max",
                                    "t_exptime", "em_min", "em_max", "obs_collection", "s_region"), dtype=[object] * 11)
        return type("R", (), {"to_table": lambda self: t})()


@pytest.fixture
def sia(monkeypatch, tmp_path):
    (tmp_path / "sia").mkdir(); (tmp_path / "cutouts").mkdir()
    monkeypatch.setattr(archive, "CACHE", tmp_path)
    monkeypatch.setattr(archive.pyvo.dal, "SIA2Service", FakeSIA)
    FakeSIA.calls, FakeSIA.fail, FakeSIA.s_regions = 0, False, [REAL, None, "POLYGON ICRS 1 2 3"]
    return tmp_path


# ---- parsing --------------------------------------------------------------------------------------------------------
def test_parse_real_irsa_polygon_drops_closing_vertex_keeps_values():
    f = archive.parse_s_region(REAL)
    assert f["status"] == "ok" and f["frame"] == "ICRS" and len(f["vertices"]) == 4
    assert f["vertices"][0] == [266.69818339020907, 5.472469522295728] and f["vertices"][2] == [269.9973138381142, 1.660074934294828]


def test_missing_and_unavailable_are_distinct_from_invalid():
    assert archive.parse_s_region(None)["status"] == "missing" and archive.parse_s_region("  ")["status"] == "missing"
    u = archive.parse_s_region(REAL, unavailable="cached search predates footprints")
    assert u["status"] == "unavailable" and u["vertices"] is None


@pytest.mark.parametrize("bad, why", [
    ("POLYGON ICRS 1 2 3", "pairs"), ("CIRCLE ICRS 10 10 1", "shape"), ("POLYGON GALACTIC 1 2 3 4 5 6", "frame"),
    ("POLYGON ICRS 1 2 3 4", "vertices"), ("POLYGON ICRS 10 nan 11 2 12 3", "non-finite"), ("POLYGON ICRS 10 95 11 2 12 3", "range"),
    ("POLYGON ICRS 10 2 10 2 10 2", "vertices"),          # identical points: only 2 left after dropping the closing duplicate
    ("POLYGON ICRS 10 0 11 0 12 0", "degenerate"),        # collinear on a great circle (the equator): zero area
    ("POLYGON ICRS 10 2 10.5 2 10.5 2 10 2 10 2", "degenerate"), ("POLYGON ICRS a b c d e f", "pairs"),
])
def test_malformed_polygons_rejected_with_reason(bad, why):
    f = archive.parse_s_region(bad)
    assert f["status"] == "invalid" and f["vertices"] is None and why in f["reason"]


def test_ra_wraparound_polygon_is_valid_and_kept_as_given():
    f = archive.parse_s_region("POLYGON ICRS 358.5 1.0 1.5 1.0 1.5 -1.0 358.5 -1.0")
    assert f["status"] == "ok" and [v[0] for v in f["vertices"]] == [358.5, 1.5, 1.5, 358.5]


def test_points_on_a_parallel_are_a_real_spherical_polygon():
    # constant Dec is a small circle, not a great circle: a thin but genuine polygon (not degenerate)
    assert archive.parse_s_region("POLYGON ICRS 10 2 11 2 12 2")["status"] == "ok"


def test_frame_may_be_omitted_and_ra_360_normalised():
    f = archive.parse_s_region("POLYGON 360 1 1 1 1 -1")
    assert f["status"] == "ok" and f["vertices"][0][0] == 0.0


# ---- archive cache versioning ----------------------------------------------------------------------------------------
def test_s_region_preserved_and_v2_cache_written(sia):
    rows = archive._sia_rows(RA, DEC, "spherex_dr1")
    assert [r["s_region"] for r in rows] == [REAL, None, "POLYGON ICRS 1 2 3"]       # verbatim, calibration row dropped
    data = json.loads(archive._sia_file(RA, DEC, "spherex_dr1", 2).read_text())
    assert data["version"] == 2 and len(data["rows"]) == 3
    archive._sia_rows(RA, DEC, "spherex_dr1")
    assert FakeSIA.calls == 1                                                            # cached: no repeat search


def test_old_v1_cache_is_refreshed_once_and_never_deleted(sia):
    f1 = archive._sia_file(RA, DEC, "spherex_dr1", 1)
    f1.write_text(json.dumps([{"obs_id": "old", "band": "D6", "access_url": "u", "mjd_start": 1.0, "mjd_end": 1.0,
                                "exptime_s": 1.0, "em_min_um": 4.4, "em_max_um": 5.0, "collection": "spherex_dr1"}]))
    rows = archive._sia_rows(RA, DEC, "spherex_dr1")
    assert FakeSIA.calls == 1 and rows[0]["s_region"] == REAL and f1.exists()
    archive._sia_rows(RA, DEC, "spherex_dr1"); assert FakeSIA.calls == 1


def test_irsa_failure_falls_back_to_v1_without_footprints(sia):
    archive._sia_file(RA, DEC, "spherex_dr1", 1).write_text(json.dumps([{"obs_id": "old", "band": "D6", "access_url": "u",
        "mjd_start": 1.0, "mjd_end": 1.0, "exptime_s": 1.0, "em_min_um": 4.4, "em_max_um": 5.0, "collection": "spherex_dr1"}]))
    FakeSIA.fail = True
    out = archive.query_observations(RA, DEC, "D6", "spherex_dr1", 12, include_all=True)
    fp = out["observations"][0]["footprint"]
    assert fp["status"] == "unavailable" and "IRSA could not be reached" in fp["reason"] and out["total_in_band"] == 1
    assert not archive._sia_file(RA, DEC, "spherex_dr1", 2).exists()                    # nothing half-written


def test_irsa_failure_without_any_cache_is_an_error(sia):
    FakeSIA.fail = True
    with pytest.raises(archive.ArchiveError):
        archive.query_observations(RA, DEC, "D6", "spherex_dr1", 12)


def test_corrupt_v2_cache_is_requeried(sia):
    archive._sia_file(RA, DEC, "spherex_dr1", 2).write_text("{not json")
    assert archive._sia_rows(RA, DEC, "spherex_dr1")[0]["s_region"] == REAL and FakeSIA.calls == 1


# ---- API -------------------------------------------------------------------------------------------------------------
def test_observations_api_exposes_footprints_and_all_rows(sia, monkeypatch):
    monkeypatch.setattr(main, "GRIDS", sia / "grids"); (sia / "grids").mkdir()
    c = TestClient(main.app)
    j = c.get(f"/api/observations?ra={RA}&dec={DEC}&band=D6&limit=2&include_all=true").json()
    assert j["target"] == {"ra": RA, "dec": DEC} and j["total_in_band"] == 3 and len(j["observations"]) == 2
    st = [o["footprint"]["status"] for o in j["all_observations"]]
    assert st == ["ok", "missing", "invalid"] and j["all_observations"][0]["s_region"] == REAL
    j2 = c.get(f"/api/observations?ra={RA}&dec={DEC}&band=D6&limit=2").json()
    assert "all_observations" not in j2 and [o["obs_id"] for o in j2["observations"]] == [o["obs_id"] for o in j["observations"]]


def test_existing_sampling_behaviour_unchanged(sia):
    FakeSIA.s_regions = [REAL] * 41
    out = archive.query_observations(RA, DEC, "D6", "spherex_dr1", 12)
    assert [o["obs_id"] for o in out["observations"]] == [f"obs{i}" for i in archive.nested_sample(41, 12)]
