"""
02_extract_dem.py - Téléchargement d'un modèle numérique de terrain (tuiles Terrarium,
AWS Open Data "Terrain Tiles", dérivées de SRTM) et assemblage en grille d'altitude.

Sortie : data_raw/dem.npz  (altitudes en mètres + géoréférencement)
"""
import io
import math
from pathlib import Path

import numpy as np
import requests
from PIL import Image

BBOX = (-5.875, 12.995, -5.790, 13.125)  # S, W, N, E
Z = 14
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
OUT = Path(__file__).resolve().parent.parent / "data_raw"
OUT.mkdir(exist_ok=True)


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


s, w, n_, e = BBOX
x0, y0 = (int(v) for v in tile_xy(n_, w, Z))
x1, y1 = (int(v) for v in tile_xy(s, e, Z))
rows = []
for ty in range(y0, y1 + 1):
    row = []
    for tx in range(x0, x1 + 1):
        r = requests.get(URL.format(z=Z, x=tx, y=ty), timeout=60)
        r.raise_for_status()
        a = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.float64)
        row.append(a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768)
    rows.append(np.hstack(row))
elev = np.vstack(rows).astype(np.float32)
np.savez_compressed(OUT / "dem.npz", elev=elev, z=Z, x0=x0, y0=y0)
print("MNT", elev.shape, "min/max", float(elev.min()), float(elev.max()))
