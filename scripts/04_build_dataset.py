"""
04_build_dataset.py - Intégration (ETL) et calcul de la grille de critères AMC.

Entrées : data_raw/ (OSM, MNT Terrarium, GRID3 santé)
Sortie  : web/data/boma_data.js  (couches GeoJSON + grille hexagonale de critères)

Dans la solution cible, ces traitements seront réalisés en SQL PostGIS / pgRouting
(distances réseau, isochrones) et rejouables par les administrateurs.
"""
import json
import math
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import linemerge, polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_raw"
OUT = ROOT / "web" / "data"
OUT.mkdir(parents=True, exist_ok=True)

S, W, N, E = -5.875, 12.995, -5.790, 13.125
LAT0, LON0 = (S + N) / 2, (W + E) / 2
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574.0
HEX_R = 125.0  # rayon de l'hexagone (m) -> ~4 ha par maille


def to_m(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def to_ll(x, y):
    return LON0 + x / KX, LAT0 + y / KY


def rnd(coords):
    return [[round(c[0], 5), round(c[1], 5)] for c in coords]


def load(name):
    return json.loads((RAW / f"osm_{name}.json").read_text(encoding="utf-8"))["elements"]


# ---------------------------------------------------------------- Voirie
ROAD_CLASS = {
    "trunk": "Voirie principale", "primary": "Voirie principale", "secondary": "Voirie principale",
    "tertiary": "Voirie secondaire", "unclassified": "Voirie secondaire",
    "residential": "Voie d'accès", "living_street": "Voie d'accès", "service": "Voie d'accès",
    "track": "Piste", "road": "Voie d'accès",
}
roads_fc, struct_lines, all_road_lines = [], [], []
for el in load("roads"):
    hw = el["tags"]["highway"]
    coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
    if len(coords) < 2:
        continue
    cls = ROAD_CLASS.get(hw, "Voie d'accès")
    surf = el["tags"].get("surface", "inconnu")
    roads_fc.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": rnd(coords)},
                     "properties": {"id": el["id"], "nom": el["tags"].get("name", ""), "classe": cls,
                                    "osm": hw, "revetement": surf}})
    lm = LineString([to_m(*c) for c in coords])
    all_road_lines.append(lm)
    if cls in ("Voirie principale", "Voirie secondaire"):
        struct_lines.append(lm)

# ---------------------------------------------------------------- Équipements
equip = []
c = sqlite3.connect(RAW / "grid3_health.gpkg")
for nom, typ, aire, zs, lat, lon in c.execute(
        f"select essnom1, esstype, airesante, zonesante, lat, lon from GRID3_COD_health_facilities_v9_0 "
        f"where lat between {S} and {N} and lon between {W} and {E}"):
    equip.append(dict(lon=lon, lat=lat, nom=(nom or "").strip(), type=typ, theme="Santé",
                      aire=aire, zone=zs, source="GRID3 v9.0"))

OSM_TYPES = {
    "school": ("École", "Éducation"), "college": ("École secondaire", "Éducation"),
    "university": ("Université", "Éducation"), "kindergarten": ("École maternelle", "Éducation"),
    "marketplace": ("Marché", "Économie"), "bank": ("Banque", "Économie"), "fuel": ("Station-service", "Économie"),
    "place_of_worship": ("Lieu de culte", "Social"), "townhall": ("Administration", "Administration"),
    "police": ("Police", "Administration"), "drinking_water": ("Point d'eau", "Eau"),
    "water_point": ("Point d'eau", "Eau"), "waste_disposal": ("Point de collecte déchets", "Déchets"),
}
for el in load("pois"):
    t = el["tags"]
    am = t.get("amenity")
    if am in ("hospital", "clinic", "doctors"):
        continue  # couverts par GRID3 (source officielle)
    if am not in OSM_TYPES:
        continue
    lat = el.get("lat") or el.get("center", {}).get("lat")
    lon = el.get("lon") or el.get("center", {}).get("lon")
    typ, theme = OSM_TYPES[am]
    equip.append(dict(lon=lon, lat=lat, nom=t.get("name", ""), type=typ, theme=theme, source="OpenStreetMap"))

health_pts = [Point(to_m(e["lon"], e["lat"])) for e in equip if e["theme"] == "Santé"]
school_pts = [Point(to_m(e["lon"], e["lat"])) for e in equip if e["theme"] == "Éducation"]

# ---------------------------------------------------------------- Hydrographie
waterways_fc, ww_lines = [], []
for el in load("waterways"):
    coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
    if len(coords) < 2:
        continue
    waterways_fc.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": rnd(coords)},
                         "properties": {"nom": el["tags"].get("name", ""), "type": el["tags"]["waterway"]}})
    ww_lines.append(LineString([to_m(*c) for c in coords]))

# Limite de la ville (relation admin)
city_fc = []
for el in load("admin"):
    segs = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
            for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
    polys = list(polygonize(linemerge(segs)))
    if polys:
        g = unary_union(polys).simplify(0.0002)
        city_fc.append({"type": "Feature", "geometry": mapping(g), "properties": {"nom": el["tags"].get("name")}})

# ---------------------------------------------------------------- Bâti (centroïdes)
bld = np.array([to_m(el["center"]["lon"], el["center"]["lat"]) for el in load("buildings") if "center" in el])

# ---------------------------------------------------------------- MNT
dem = np.load(RAW / "dem.npz")
elev = np.clip(dem["elev"], 0, None).astype(np.float64)
z, tx0, ty0 = int(dem["z"]), int(dem["x0"]), int(dem["y0"])
px_m = 40075016.686 * math.cos(math.radians(LAT0)) / 2 ** (z + 8)
# lissage 5x5 (le SRTM 30 m est suréchantillonné à ~10 m dans les tuiles z14)
pad = np.pad(elev, 2, mode="edge")
elev_s = sum(pad[i:i + elev.shape[0], j:j + elev.shape[1]] for i in range(5) for j in range(5)) / 25
slope = np.degrees(np.arctan(np.hypot(*np.gradient(elev_s, px_m))))  # pente en degrés


def dem_px(lon, lat):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int((y - ty0) * 256), int((x - tx0) * 256)


def sample(arr, lon, lat):
    r, cidx = dem_px(lon, lat)
    r = min(max(r, 0), arr.shape[0] - 1)
    cidx = min(max(cidx, 0), arr.shape[1] - 1)
    return float(arr[r, cidx])

# ---------------------------------------------------------------- Grille hexagonale
x0, y0 = to_m(W, S)
x1, y1 = to_m(E, N)
dx, dy = 1.5 * HEX_R, math.sqrt(3) * HEX_R
centers = []
col = 0
x = x0
while x <= x1:
    y = y0 + (dy / 2 if col % 2 else 0)
    while y <= y1:
        centers.append((x, y))
        y += dy
    x += dx
    col += 1
centers = np.array(centers)

# comptage du bâti par maille (plus proche centre)
counts = np.zeros(len(centers), dtype=int)
for i in range(0, len(bld), 2000):
    chunk = bld[i:i + 2000]
    d2 = ((chunk[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
    idx = d2.argmin(1)
    ok = d2[np.arange(len(chunk)), idx] <= HEX_R ** 2
    np.add.at(counts, idx[ok], 1)

road_tree = STRtree(all_road_lines)
struct_tree = STRtree(struct_lines)
ww_tree = STRtree(ww_lines)
health_tree = STRtree(health_pts)
school_tree = STRtree(school_pts)
pts = [Point(c) for c in centers]
_, d_road = road_tree.query_nearest(pts, return_distance=True, all_matches=False)
_, d_struct = struct_tree.query_nearest(pts, return_distance=True, all_matches=False)
_, d_ww = ww_tree.query_nearest(pts, return_distance=True, all_matches=False)
_, d_health = health_tree.query_nearest(pts, return_distance=True, all_matches=False)
_, d_school = school_tree.query_nearest(pts, return_distance=True, all_matches=False)

# secteur = aire de santé de l'établissement GRID3 le plus proche
grid3 = [(Point(to_m(e["lon"], e["lat"])), e["aire"]) for e in equip if e.get("aire")]
g3_tree = STRtree([g for g, _ in grid3])
near_idx = g3_tree.query_nearest(pts, all_matches=False)[1]

cells, sector_geoms = [], defaultdict(list)
for i, (cx, cy) in enumerate(centers):
    n_bld = int(counts[i])
    if n_bld < 3 and d_road[i] > 150:
        continue  # hors tissu urbanisé
    lon, lat = to_ll(cx, cy)
    ring_m = [(cx + HEX_R * math.cos(math.radians(a)), cy + HEX_R * math.sin(math.radians(a))) for a in range(0, 360, 60)]
    ring = [to_ll(*p) for p in ring_m]
    samples = [(lon, lat)] + [to_ll((cx + p[0]) / 2, (cy + p[1]) / 2) for p in ring_m]
    alt = float(np.mean([sample(elev, *s) for s in samples]))
    pente = float(np.mean([sample(slope, *s) for s in samples]))
    if alt < 2 and n_bld == 0:
        continue  # plan d'eau (fleuve)
    # Susceptibilité inondation (proxy) : basse altitude relative + proximité cours d'eau + faible pente
    s_alt = np.clip((40 - alt) / 35, 0, 1)
    s_ww = np.clip((400 - d_ww[i]) / 400, 0, 1)
    s_flat = np.clip((6 - pente) / 6, 0, 1)
    inond = round(float(0.5 * s_alt + 0.35 * s_ww + 0.15 * s_flat), 3)
    sect = grid3[near_idx[i]][1]
    poly = Polygon(ring + [ring[0]])
    sector_geoms[sect].append(poly)
    cells.append({
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [rnd(ring + [ring[0]])]},
        "properties": {
            "id": i, "secteur": sect,
            "bati": n_bld,
            "d_sante": round(float(d_health[i])), "d_ecole": round(float(d_school[i])),
            "d_voirie": round(float(d_struct[i])), "d_eau": round(float(d_ww[i])),
            "alt": round(alt, 1), "pente": round(pente, 1), "inond": inond,
        },
    })

sectors_fc = []
for name, geoms in sector_geoms.items():
    g = unary_union(geoms).buffer(0.00001).simplify(0.00015)
    sectors_fc.append({"type": "Feature", "geometry": mapping(g),
                       "properties": {"secteur": name, "mailles": len(geoms)}})


def fix(fc):  # arrondi des géométries shapely
    def r(o):
        if isinstance(o, (list, tuple)):
            if o and isinstance(o[0], (int, float)):
                return [round(o[0], 5), round(o[1], 5)]
            return [r(v) for v in o]
        return o
    for f in fc:
        f["geometry"] = {"type": f["geometry"]["type"], "coordinates": r(f["geometry"]["coordinates"])}
    return fc


equip_fc = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(e["lon"], 6), round(e["lat"], 6)]},
             "properties": {k: v for k, v in e.items() if k not in ("lon", "lat")}} for e in equip]

data = {
    "meta": {"bbox": [W, S, E, N], "hex_r": HEX_R, "genere": "2026-11-21",
             "sources": ["OpenStreetMap (ODbL)", "GRID3 COD Health Facilities v9.0 (CC BY 4.0)",
                         "AWS Terrain Tiles / SRTM"]},
    "voirie": {"type": "FeatureCollection", "features": roads_fc},
    "equipements": {"type": "FeatureCollection", "features": equip_fc},
    "hydro": {"type": "FeatureCollection", "features": waterways_fc},
    "limite": {"type": "FeatureCollection", "features": fix(city_fc)},
    "secteurs": {"type": "FeatureCollection", "features": fix(sectors_fc)},
    "grille": {"type": "FeatureCollection", "features": cells},
}
js = "window.BOMA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
(OUT / "boma_data.js").write_text(js, encoding="utf-8")
print(f"voirie={len(roads_fc)} equipements={len(equip_fc)} hydro={len(waterways_fc)} "
      f"secteurs={len(sectors_fc)} mailles={len(cells)} taille={len(js)/1e6:.1f} Mo")
print("thèmes:", Counter(e["theme"] for e in equip))
alts = [c["properties"]["alt"] for c in cells]; pentes = [c["properties"]["pente"] for c in cells]
print("alt", min(alts), max(alts), "pente", min(pentes), max(pentes), "bati max", max(c["properties"]["bati"] for c in cells))
