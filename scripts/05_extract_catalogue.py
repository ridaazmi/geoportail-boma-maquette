"""
05_extract_catalogue.py - Extraction complémentaire (OSM + Overture Maps) pour couvrir
les catégories du catalogue des données collectées en phase 1.

Sorties : data_raw/osm_cat_*.json, data_raw/overture_divisions.json, data_raw/overture_landuse.json
"""
import json
import time
from pathlib import Path

import requests

S, W, N, E = -5.875, 12.995, -5.790, 13.125
b = f"{S},{W},{N},{E}"
OUT = Path(__file__).resolve().parent.parent / "data_raw"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
HEADERS = {"User-Agent": "geoportail-demo/1.0"}

QUERIES = {
    "admin": f"""(relation["boundary"="administrative"]["admin_level"~"^(7|8|9|10)$"]({b});
                 node["place"~"^(suburb|quarter|neighbourhood|village|hamlet)$"]({b}););out geom;""",
    "transport": f"""(nwr["railway"~"^(station|halt)$"]({b}); nwr["public_transport"~"^(station|platform|stop_position)$"]({b});
                     nwr["highway"="bus_stop"]({b}); nwr["amenity"~"^(bus_station|ferry_terminal|taxi)$"]({b});
                     nwr["aeroway"~"^(aerodrome|terminal)$"]({b}); nwr["landuse"="port"]({b}); nwr["harbour"]({b});
                     way["railway"="rail"]({b}););out center geom tags;""",
    "admin_secu": f"""(nwr["amenity"~"^(townhall|police|courthouse|prison|fire_station|post_office)$"]({b});
                      nwr["office"="government"]({b}); nwr["military"]({b}););out center tags;""",
    "collectifs": f"""(nwr["amenity"~"^(school|college|university|kindergarten|library|community_centre|theatre|arts_centre|cinema|place_of_worship|social_facility)$"]({b});
                      nwr["leisure"~"^(stadium|pitch|sports_centre|track)$"]({b});
                      nwr["tourism"]({b}); nwr["historic"]({b}););out center tags;""",
    "economie": f"""(nwr["amenity"~"^(marketplace|bank|restaurant|bar|cafe|fuel|pharmacy|bureau_de_change)$"]({b});
                    nwr["shop"]({b}); nwr["office"~"^(company|ngo|telecommunication|insurance)$"]({b});
                    nwr["craft"]({b}););out center tags;""",
    "environnement": f"""(way["leisure"~"^(park|garden|nature_reserve)$"]({b}); relation["leisure"~"^(park|garden|nature_reserve)$"]({b});
                         way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|orchard|farmland|residential|industrial|commercial|retail|military|railway)$"]({b});
                         way["natural"~"^(wood|scrub|grassland|wetland)$"]({b});
                         nwr["amenity"="grave_yard"]({b}););out geom tags;""",
}

for name, q in QUERIES.items():
    target = OUT / f"osm_cat_{name}.json"
    if target.exists():
        print("[skip]", name)
        continue
    js = None
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            r = requests.post(url, data={"data": f"[out:json][timeout:120];{q}"}, headers=HEADERS, timeout=150)
            if r.status_code == 200:
                js = r.json()
                break
            print(name, url.split("/")[2], "HTTP", r.status_code)
        except Exception as exc:
            print(name, url.split("/")[2], type(exc).__name__)
        time.sleep(10)
    if js is None:
        print("[fail]", name)
        continue
    target.write_text(json.dumps(js), encoding="utf-8")
    print(f"[ok  ] {name}: {len(js['elements'])} éléments")
    time.sleep(5)

# ---- Overture Maps : divisions (quartiers) et occupation du sol
try:
    import duckdb
    REL = "2026-11-18.0"
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{REL}"
    where = f"bbox.xmin <= {E} AND bbox.xmax >= {W} AND bbox.ymin <= {N} AND bbox.ymax >= {S}"
    div = con.execute(f"""SELECT names.primary, subtype, class, ST_AsGeoJSON(geometry)
        FROM read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning=1)
        WHERE {where} AND subtype IN ('county','locality','localadmin','borough','macrohood','neighborhood','microhood')""").fetchall()
    (OUT / "overture_divisions.json").write_text(json.dumps([dict(name=r[0], subtype=r[1], cls=r[2], geom=json.loads(r[3])) for r in div], ensure_ascii=False), encoding="utf-8")
    print("[ok  ] overture divisions:", len(div))
    lu = con.execute(f"""SELECT names.primary, subtype, class, ST_AsGeoJSON(geometry)
        FROM read_parquet('{base}/theme=base/type=land_use/*', hive_partitioning=1) WHERE {where}""").fetchall()
    (OUT / "overture_landuse.json").write_text(json.dumps([dict(name=r[0], subtype=r[1], cls=r[2], geom=json.loads(r[3])) for r in lu], ensure_ascii=False), encoding="utf-8")
    print("[ok  ] overture land_use:", len(lu))
except Exception as exc:  # Overture est un complément : on continue sans
    print("[warn] Overture indisponible :", exc)
