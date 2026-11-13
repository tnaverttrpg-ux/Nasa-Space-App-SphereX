"""SYNTHETIC demo frames. Generated with NumPy; these are NOT SPHEREx data and are always labelled as such."""
import numpy as np

N_FRAMES, SIZE = 10, 64


def demo_frames():
    rng = np.random.default_rng(42)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    star = lambda x, y, f: f * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.1 ** 2))
    field = [(rng.uniform(4, SIZE - 4), rng.uniform(4, SIZE - 4), rng.uniform(20, 300)) for _ in range(45)]
    frames = []
    for i in range(N_FRAMES):
        img = rng.normal(10, 1.5, (SIZE, SIZE))
        for x, y, f in field:
            img += star(x, y, f)
        img += star(18 + 2.6 * i, 40 - 1.4 * i, 120)          # synthetic mover
        img += star(48, 14, 60 * (1 + 0.8 * np.sin(i / 1.6)))  # synthetic variable
        meta = {"date_obs": f"SYNTHETIC frame {i + 1}", "mjd": None, "decimal_year": 2026.0 + i * 0.02,
                "bunit": "arbitrary", "wavelength_at_target": None, "coverage_fraction": 1.0,
                "note": "Synthetic demo image - not SPHEREx data"}
        frames.append((img.astype("float32"), np.ones_like(img, bool), meta))
    return frames
