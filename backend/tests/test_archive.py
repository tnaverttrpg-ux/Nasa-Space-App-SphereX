import io
import threading
import time

import numpy as np
import pytest
from astropy.io import fits

from app import archive

URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/level2_test_spx.fits"


def fits_bytes():
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(np.ones((4, 4), "float32"), name="IMAGE")]).writeto(buf)
    return buf.getvalue()


class FakeIRSA:
    """Scripted responses for archive._client.stream; counts calls; can block until released."""
    def __init__(self, script, gate=None):
        self.script, self.calls, self.gate = list(script), 0, gate

    def stream(self, method, url):
        self.calls += 1
        status, body = self.script.pop(0) if self.script else (200, fits_bytes())
        fake = self

        class Resp:
            status_code, headers = status, {}

            def __enter__(self): return self
            def __exit__(self, *a): return False

            def iter_bytes(self, n):
                for i in range(0, len(body), 2880):
                    if fake.gate is not None:
                        fake.gate.wait(5)
                    yield body[i:i + 2880]
        return Resp()


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


def test_retries_transient_then_caches(irsa):
    f = irsa([(503, b""), (429, b"")])
    data = archive.fetch_cutout(URL, 10.0, 20.0, 0.15)
    assert f.calls == 3 and archive._valid_fits(data)
    assert archive.fetch_cutout(URL, 10.0, 20.0, 0.15) == data and f.calls == 3  # disk cache hit


def test_permanent_error_not_retried(irsa):
    f = irsa([(404, b"")])
    with pytest.raises(archive.ArchiveError):
        archive.fetch_cutout(URL, 10.0, 20.0, 0.15)
    assert f.calls == 1


def test_truncated_download_is_retried_and_never_cached(irsa):
    f = irsa([(200, fits_bytes()[:5000])])
    archive.fetch_cutout(URL, 10.0, 20.0, 0.15)
    assert f.calls == 2
    assert all(archive._valid_fits(p.read_bytes()) for p in (archive.CACHE / "cutouts").glob("*.fits"))
    assert not list((archive.CACHE / "cutouts").glob("*.part"))


def test_concurrent_identical_requests_share_one_download(irsa):
    gate = threading.Event()
    f = irsa(gate=gate)
    out = []
    ts = [threading.Thread(target=lambda: out.append(archive.fetch_cutout(URL, 10.0, 20.0, 0.15))) for _ in range(3)]
    [t.start() for t in ts]
    time.sleep(0.3)
    gate.set()
    [t.join(5) for t in ts]
    assert f.calls == 1 and len(out) == 3 and out[0] == out[1] == out[2]


def test_cancel_when_last_waiter_leaves_writes_nothing(irsa):
    gate = threading.Event()
    irsa(gate=gate)
    job, shared = archive.acquire_cutout(URL, 10.0, 20.0, 0.15)
    job2, shared2 = archive.acquire_cutout(URL, 10.0, 20.0, 0.15)
    assert job is job2 and not shared and shared2
    archive.release_cutout(job2)
    assert not job.cancel.is_set()  # one waiter left: keep downloading
    archive.release_cutout(job)
    assert job.cancel.is_set()
    gate.set()
    with pytest.raises(archive.Cancelled):
        job.future.result(5)
    assert not list((archive.CACHE / "cutouts").iterdir())


def test_grid_publish_tolerates_concurrent_identical_writer(tmp_path, monkeypatch):
    from app import main
    dest, tmp = tmp_path / "k.json", tmp_path / "k.1.tmp.json"
    dest.write_text("same"); tmp.write_text("same")
    monkeypatch.setattr(type(tmp), "replace", lambda self, d: (_ for _ in ()).throw(PermissionError("locked")))
    main._publish(tmp, dest)
    assert dest.read_text() == "same" and not tmp.exists()


def test_larger_cutout_reused_for_smaller_fov_and_corrupt_cache_rejected(irsa):
    f = irsa()
    archive.fetch_cutout(URL, 10.0, 20.0, 0.15)
    assert archive.cached_cutout(URL, 10.0, 20.0, 0.12) is not None  # 0.15° cutout covers a 0.12° request
    assert archive.cached_cutout(URL, 10.0, 20.0, 0.30) is None       # but not a larger one
    p = archive.cached_cutout(URL, 10.0, 20.0, 0.15)
    p.write_bytes(p.read_bytes()[:3000])                               # simulate corruption
    assert archive.read_cached(p) is None and not p.exists()
    archive.fetch_cutout(URL, 10.0, 20.0, 0.15)
    assert f.calls == 2
