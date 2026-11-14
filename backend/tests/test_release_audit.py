"""Release-freeze reliability checks: cache isolation, shared cancellation, retries/timeouts, grid corruption."""
import json
import threading
import time

import httpx
import numpy as np
import pytest

from app import archive, fitsproc, main
from test_archive import FakeIRSA, fits_bytes  # noqa: F401  (fixture helpers)

BASE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/"
D6_V27 = BASE + "6/level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits"
D3_V27 = BASE + "3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
D6_V28 = D6_V27.replace("v27-2026-197", "v28-2026-300")          # hypothetical reprocessed release
D6_QR = D6_V27.replace("/dr1/", "/qr3/")                          # other data release


@pytest.fixture
def irsa(monkeypatch, tmp_path):
    (tmp_path / "cutouts").mkdir()
    monkeypatch.setattr(archive, "CACHE", tmp_path)
    monkeypatch.setattr(archive, "_backoff", lambda attempt, ra=None: 0.01)
    def install(script=(), gate=None):
        f = FakeIRSA(script, gate)
        monkeypatch.setattr(archive, "_client", f)
        return f
    return install


# 1. cache isolation --------------------------------------------------------------------------------------------
def test_cutout_cache_never_shared_across_release_band_version_or_centre(irsa):
    irsa()
    archive.fetch_cutout(D6_V27, 10.0, 20.0, 0.30)                   # one large cached cutout
    assert archive.cached_cutout(D6_V27, 10.0, 20.0, 0.15) is not None  # same file+centre: reusable
    for url, ra, dec in [(D3_V27, 10.0, 20.0), (D6_V28, 10.0, 20.0), (D6_QR, 10.0, 20.0),
                         (D6_V27, 10.000001, 20.0), (D6_V27, 10.0, 20.000001)]:
        assert archive.cached_cutout(url, ra, dec, 0.15) is None, (url, ra, dec)


def test_grid_key_depends_on_processing_version_file_centre_and_fov(monkeypatch):
    k = main._grid_key(D6_V27, 10.0, 20.0, 0.1)
    assert len({k, main._grid_key(D3_V27, 10.0, 20.0, 0.1), main._grid_key(D6_V28, 10.0, 20.0, 0.1),
                main._grid_key(D6_V27, 10.000001, 20.0, 0.1), main._grid_key(D6_V27, 10.0, 20.0, 0.11)}) == 5
    monkeypatch.setattr(fitsproc, "PROC_VERSION", fitsproc.PROC_VERSION + 1)
    assert main._grid_key(D6_V27, 10.0, 20.0, 0.1) != k


def test_url_validation_rejects_non_irsa_and_query_strings():
    for bad in ["https://evil.example/x.fits", D6_V27 + "?center=1,2&size=3", "http://irsa.ipac.caltech.edu/ibe/data/spherex/x.fits"]:
        with pytest.raises(archive.ArchiveError):
            archive.check_url(bad)


# 2. shared in-flight download, one requester cancels -------------------------------------------------------------
def test_one_requester_cancels_other_still_receives_and_caches(irsa):
    gate = threading.Event()
    f = irsa(gate=gate)
    a, shared_a = archive.acquire_cutout(D6_V27, 10.0, 20.0, 0.15)
    b, shared_b = archive.acquire_cutout(D6_V27, 10.0, 20.0, 0.15)
    assert a is b and not shared_a and shared_b
    archive.release_cutout(a)                     # requester A goes away mid-download
    assert not a.cancel.is_set()
    gate.set()
    data, info = b.future.result(5)               # requester B still gets the full file
    archive.release_cutout(b)
    assert archive._valid_fits(data) and f.calls == 1
    assert archive.cached_cutout(D6_V27, 10.0, 20.0, 0.15) is not None


def test_new_requester_after_cancellation_starts_fresh_download(irsa):
    gate = threading.Event()
    f = irsa(gate=gate)
    a, _ = archive.acquire_cutout(D6_V27, 10.0, 20.0, 0.15)
    archive.release_cutout(a)                     # everyone left -> cancelled
    b, shared = archive.acquire_cutout(D6_V27, 10.0, 20.0, 0.15)
    assert b is not a and not shared              # never joins a cancelled job
    gate.set()
    with pytest.raises(archive.Cancelled):
        a.future.result(5)
    assert archive._valid_fits(b.future.result(5)[0])
    archive.release_cutout(b)


# 5. retries and timeouts -----------------------------------------------------------------------------------------
def test_repeated_503_gives_up_after_max_attempts(irsa):
    f = irsa([(503, b"")] * 10)
    with pytest.raises(archive.ArchiveError) as e:
        archive.fetch_cutout(D6_V27, 10.0, 20.0, 0.15)
    assert f.calls == archive.MAX_ATTEMPTS and e.value.status == 502 and "503" in str(e.value)
    assert not list((archive.CACHE / "cutouts").iterdir())


def test_timeouts_and_network_errors_are_retried(irsa):
    f = irsa([httpx.ReadTimeout("slow"), httpx.ConnectError("down")])
    assert archive._valid_fits(archive.fetch_cutout(D6_V27, 10.0, 20.0, 0.15)) and f.calls == 3


def test_persistent_timeouts_end_with_504(irsa):
    f = irsa([httpx.ReadTimeout("slow")] * 10)
    with pytest.raises(archive.ArchiveError) as e:
        archive.fetch_cutout(D6_V27, 10.0, 20.0, 0.15)
    assert f.calls == archive.MAX_ATTEMPTS and e.value.status == 504


def test_backoff_schedule_bounded_and_honours_retry_after():
    assert archive._backoff(1, "5") == 5.0 and archive._backoff(1, "999") == 30.0
    for attempt, lo, hi in [(1, 0.75, 2.25), (2, 1.5, 4.5), (3, 3, 9), (4, 6, 18), (9, 10, 30)]:
        assert all(lo <= archive._backoff(attempt) <= hi for _ in range(200))


def test_cancel_during_backoff_stops_promptly(irsa, monkeypatch):
    monkeypatch.setattr(archive, "_backoff", lambda attempt, ra=None: 30.0)
    irsa([(503, b"")] * 5)
    job, _ = archive.acquire_cutout(D6_V27, 10.0, 20.0, 0.15)
    time.sleep(0.2)
    t = time.perf_counter()
    archive.release_cutout(job)
    with pytest.raises(archive.Cancelled):
        job.future.result(5)
    assert time.perf_counter() - t < 1.0          # not stuck in a 30 s sleep


# 4. corrupted grid cache -----------------------------------------------------------------------------------------
def test_corrupt_or_missing_grid_npz_is_detected_and_removed(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "GRIDS", tmp_path)
    main._save("k1", np.ones((3, 3), "float32"), np.ones((3, 3), bool), {"a": 1})
    assert main._grid_ok("k1")
    (tmp_path / "k1.npz").write_bytes(b"PK\x03\x04garbage")
    assert not main._grid_ok("k1") and not (tmp_path / "k1.json").exists()
    (tmp_path / "k2.json").write_text(json.dumps({"a": 1}))       # marker without data
    assert not main._grid_ok("k2") and not (tmp_path / "k2.json").exists()
