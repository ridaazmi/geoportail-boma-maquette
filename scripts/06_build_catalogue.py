"""
06_build_catalogue.py - Organise les données ouvertes selon le catalogue des données
collectées en phase 1 (7 catégories) et produit les couches complémentaires.

Entrées : data_raw/ (OSM, Overture, GRID3, MNT) + web/data/boma_data.js
Sorties : web/data/boma_catalogue.js (window.BOMA_CAT), web/data/mnt_ombrage.png
"""
import json
import math
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import MultiPoint, Point, Polygon, mapping, shape
from shapely.ops import unary_union, voronoi_diagram

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data_raw"
WEB = ROOT / "web" / "data"
S, W, N, E = -5.875, 12.995, -5.790, 13.125
LAT0, LON0 = (S + N) / 2, (W + E) / 2
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574.0

txt = (WEB / "boma_data.js").read_text(encoding="utf-8")
BOMA = json.loads(txt[txt.index("{"): txt.rstrip().rstrip(";").rindex("}") + 1])


def osm(name):
    return json.loads((RAW / f"osm_cat_{name}.json").read_text(encoding="utf-8"))["elements"]


def ll(el):
    if "lat" in el:
        return el["lon"], el["lat"]
    if "center" in el:
        return el["center"]["lon"], el["center"]["lat"]
    g = el.get("geometry") or []
    if g:
        return sum(p["lon"] for p in g) / len(g), sum(p["lat"] for p in g) / len(g)
    return None


def rnd(o):
    if isinstance(o, (list, tuple)):
        if o and isinstance(o[0], (int, float)):
            return [round(o[0], 5), round(o[1], 5)]
        return [rnd(v) for v in o]
    return o


def feat(geom, **props):
    g = mapping(geom) if hasattr(geom, "geom_type") else geom
    return {"type": "Feature", "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])}, "properties": props}


# ------------------------------------------------------------------ points du catalogue
points = []


def add(lon, lat, couche, nom, typ, source):
    # dédoublonnage : même nom à moins de 150 m
    for p in points:
        if nom and p["properties"]["nom"].lower() == nom.lower():
            q = p["geometry"]["coordinates"]
            if math.hypot((q[0] - lon) * KX, (q[1] - lat) * KY) < 150:
                return
    points.append(feat({"type": "Point", "coordinates": [lon, lat]}, couche=couche, nom=nom or "", type=typ, source=source))


# 02 transport
for el in osm("transport"):
    t = el.get("tags", {})
    c = ll(el)
    if not c:
        continue
    if t.get("aeroway") == "terminal":
        continue
    typ = ("Aéroport" if t.get("aeroway") else "Gare ferroviaire" if t.get("public_transport") == "station" else
           "Port" if t.get("harbour") or t.get("amenity") == "ferry_terminal" else "Arrêt")
    add(*c, "transport", t.get("name") or typ, typ, "OpenStreetMap")

# 03 / 04 / 05 depuis OSM
COLL = {
    "school": ("ecoles", "École"), "college": ("ecoles", "École secondaire"), "university": ("ecoles", "Université"),
    "kindergarten": ("ecoles", "École maternelle"), "place_of_worship": ("culture", "Lieu de culte"),
    "library": ("culture", "Bibliothèque"), "community_centre": ("culture", "Centre communautaire"),
    "theatre": ("culture", "Salle de spectacle"), "townhall": ("administration", "Administration"),
    "police": ("police", "Poste de police"), "courthouse": ("administration", "Tribunal"),
    "prison": ("administration", "Prison"), "post_office": ("administration", "Poste"),
    "marketplace": ("marches", "Marché"), "bank": ("commerces", "Banque"), "restaurant": ("commerces", "Restaurant"),
    "bar": ("commerces", "Bar"), "cafe": ("commerces", "Café"), "fuel": ("commerces", "Station-service"),
    "pharmacy": ("commerces", "Pharmacie"),
}
for name in ("admin_secu", "collectifs", "economie"):
    for el in osm(name):
        t = el.get("tags", {})
        c = ll(el)
        if not c:
            continue
        nom = t.get("name", "")
        am = t.get("amenity")
        if am in COLL:
            couche, typ = COLL[am]
            if am == "restaurant" and "HOTEL" in nom.upper():
                continue
        elif t.get("leisure") in ("pitch", "stadium", "sports_centre", "track"):
            couche, typ = "sport", "Terrain de sport"
        elif t.get("tourism") in ("hotel", "guest_house"):
            couche, typ = "tourisme", "Hôtel"
        elif t.get("tourism") in ("museum", "artwork", "attraction") or t.get("historic"):
            couche, typ = "tourisme", "Site historique et touristique"
        elif t.get("tourism") == "camp_site":
            couche, typ = "administration", "Camp militaire"
        elif t.get("shop") or t.get("office") or t.get("craft"):
            couche, typ = "commerces", "Commerce et service" if t.get("shop") else "Activité économique"
        else:
            continue
        add(*c, couche, nom, typ, "OpenStreetMap")

# Overture (lieux) : sites historiques, gares, finances, hôtels
OV = {"historic_site": ("tourisme", "Site historique et touristique"), "hotel": ("tourisme", "Hôtel"),
      "train_station": ("transport", "Gare ferroviaire"), "airport": ("transport", "Aéroport"),
      "financial_service": ("commerces", "Banque"), "restaurant": ("commerces", "Restaurant"),
      "christian_place_of_worship": ("culture", "Lieu de culte"), "religious_organization": ("culture", "Lieu de culte"),
      "college_university": ("ecoles", "Université"), "elementary_school": ("ecoles", "École"),
      "electronics_store": ("commerces", "Commerce et service"), "gas_station": ("commerces", "Station-service"),
      "personal_or_beauty_service": ("commerces", "Commerce et service")}
for p in json.loads((RAW / "overture_places.json").read_text(encoding="utf-8")):
    if p.get("basic") in OV and (p.get("conf") or 0) >= 0.4:
        couche, typ = OV[p["basic"]]
        add(p["lon"], p["lat"], couche, p.get("name") or typ, typ, "Overture Maps")

# santé (GRID3, déjà intégrée) et écoles existantes
for f in BOMA["equipements"]["features"]:
    pr = f["properties"]
    if pr["theme"] == "Santé":
        add(*f["geometry"]["coordinates"], "sante", pr["nom"], pr["type"], pr["source"])

# ------------------------------------------------------------------ polygones
urban = unary_union([shape(c["geometry"]) for c in BOMA["grille"]["features"]]).buffer(0.0008)

# 01 quartiers approchés : diagramme de Voronoï des localités GRID3, découpé par la zone urbaine
con = sqlite3.connect(RAW / "grid3_settlements.gpkg")
locs = {}
for nom, typ, lat, lon in con.execute(
        f"select localite, localitetype, lat, lon from GRID3_COD_settlement_names_v9_0 "
        f"where lat between {S} and {N} and lon between {W} and {E}"):
    if nom and Point(lon, lat).within(urban):
        locs.setdefault(nom.strip(), (lon, lat))
pts = MultiPoint([Point(*v) for v in locs.values()])
names = {(round(v[0], 6), round(v[1], 6)): k for k, v in locs.items()}
quartiers = []
for cell in voronoi_diagram(pts, envelope=urban.envelope).geoms:
    clip = cell.intersection(urban)
    if clip.is_empty:
        continue
    seed = next((p for p in pts.geoms if cell.contains(p)), None)
    nom = names.get((round(seed.x, 6), round(seed.y, 6)), "") if seed else ""
    quartiers.append(feat(clip.simplify(0.00008), nom=nom, source="GRID3 (localités) — limites approchées"))

# 06 espaces verts et naturels (Overture land cover)
LC = {"forest": "Forêt", "shrub": "Végétation arbustive", "grass": "Prairie / herbacée",
      "wetland": "Zone humide", "crop": "Cultures"}
verts = []
for x in json.loads((RAW / "overture_landcover.json").read_text(encoding="utf-8")):
    if x["subtype"] in LC:
        g = shape(x["geom"]).intersection(Polygon([(W, S), (E, S), (E, N), (W, N)]))
        if not g.is_empty and g.area > 2e-7:
            verts.append(feat(g.simplify(0.0001), type=LC[x["subtype"]], source="Overture Maps (ESA WorldCover)"))

# 06 occupation urbaine (OSM landuse)
LU = {"residential": "Habitat", "industrial": "Zone d'activités / industrielle", "commercial": "Zone commerciale"}
occup = []
for el in osm("environnement"):
    t = el.get("tags", {})
    if t.get("landuse") in LU and el.get("geometry"):
        ring = [(p["lon"], p["lat"]) for p in el["geometry"]]
        if len(ring) >= 4:
            occup.append(feat(Polygon(ring), type=LU[t["landuse"]], nom=t.get("name", ""), source="OpenStreetMap"))

# 06 zones d'érosion (indicatives) : mailles de pente moyenne > 12°
steep = [shape(c["geometry"]) for c in BOMA["grille"]["features"] if c["properties"]["pente"] > 12]
eros = unary_union(steep).buffer(0.00002).simplify(0.00008) if steep else None
erosion = [feat(g, type="Pente forte (> 12°)", source="Dérivé du MNT SRTM") for g in (getattr(eros, "geoms", [eros]) if eros else [])]

# aéroport : emprise (polygone) en plus du point
aero = []
for el in osm("transport"):
    if el.get("tags", {}).get("aeroway") == "aerodrome" and el.get("geometry"):
        aero.append(feat(Polygon([(p["lon"], p["lat"]) for p in el["geometry"]]), nom=el["tags"].get("name", "Aérodrome")))

# ------------------------------------------------------------------ 07 MNT ombré (image)
dem = np.load(RAW / "dem.npz")
z, tx0, ty0 = int(dem["z"]), int(dem["x0"]), int(dem["y0"])
el_ = np.clip(dem["elev"], 0, None).astype(float)
el_ = el_[::2, ::2]
px = 40075016.686 * math.cos(math.radians(LAT0)) / 2 ** (z + 8) * 2
gy, gx = np.gradient(el_, px)
slope = np.arctan(np.hypot(gx, gy) * 1.5)
aspect = np.arctan2(-gx, gy)
az, alt = math.radians(315), math.radians(45)
hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
hs = np.clip(hs, 0, 1)
shade = (1 - hs)
rgba = np.zeros(el_.shape + (4,), dtype=np.uint8)
rgba[..., 0:3] = 20
rgba[..., 3] = (np.clip(shade - 0.25, 0, 1) * 230).astype(np.uint8)
Image.fromarray(rgba, "RGBA").save(WEB / "mnt_ombrage.png", optimize=True)


def tile2lonlat(x, y, zz):
    n = 2 ** zz
    return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


h, w = dem["elev"].shape
lonW, latN = tile2lonlat(tx0, ty0, z)
lonE, latS = tile2lonlat(tx0 + w / 256, ty0 + h / 256, z)
mnt_coords = [[lonW, latN], [lonE, latN], [lonE, latS], [lonW, latS]]

FC = lambda feats: {"type": "FeatureCollection", "features": feats}
out = {
    "points": FC(points), "quartiers": FC(quartiers), "verts": FC(verts), "occupation": FC(occup),
    "erosion": FC(erosion), "aeroport": FC(aero), "mnt": {"url": "data/mnt_ombrage.png", "coordinates": mnt_coords},
}
js = "window.BOMA_CAT = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
(WEB / "boma_catalogue.js").write_text(js, encoding="utf-8")
from collections import Counter
print("points:", Counter(p["properties"]["couche"] for p in points))
print("quartiers:", len(quartiers), "verts:", len(verts), "occupation:", len(occup), "erosion:", len(erosion), "aeroport:", len(aero))
print("taille:", round(len(js) / 1e6, 2), "Mo")
