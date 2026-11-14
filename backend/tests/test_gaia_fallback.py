from astropy.table import Table

from app import resolver


def test_gaia_falls_back_to_mirror_and_caches(monkeypatch, tmp_path):
    calls = []

    class FakeTAP:
        def __init__(self, url):
            self.url = url

        def run_sync(self, q, timeout=None):
            calls.append(self.url)
            if "esac" in self.url:
                raise RuntimeError("Rate limit exceeded (HTTP 429)")
            assert "gaia.dr3lite" in q
            return type("R", (), {"to_table": lambda s: Table(rows=[(1, 150.0, 2.0, -100.0, 500.0, 12.3)],
                names=("source_id", "ra", "dec", "pmra", "pmdec", "phot_g_mean_mag"))})()

    monkeypatch.setattr(resolver.pyvo.dal, "TAPService", FakeTAP)
    monkeypatch.setattr(resolver, "CACHE", tmp_path)
    out = resolver.gaia_sources(150.0, 2.0, 0.05)
    assert len(calls) == 2 and out["sources"][0]["source_id"] == "1"
    src = out["sources"][0]
    assert src["dx_per_yr"] > 0 and src["dy_per_yr"] < 0  # pmra<0 moves west (right), pmdec>0 moves north (up)
    resolver.gaia_sources(150.0, 2.0, 0.05)
    assert len(calls) == 2  # second call served from disk cache
