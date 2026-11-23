"""
01_extract_osm.py - Extraction des données OpenStreetMap pour la zone de Boma (RDC).

Sortie : data_raw/osm_*.json (réponses brutes Overpass)
Usage  : python 01_extract_osm.py
Licence des données : ODbL (c) contributeurs OpenStreetMap
"""
import json
import time
from pathlib import Path

import requests

BBOX = (-5.875, 12.995, -5.790, 13.125)  # S, W, N, E  (ville de Boma)
OVERPASS = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "geoportail-demo/1.0"}
OUT = Path(__file__).resolve().parent.parent / "data_raw"
OUT.mkdir(exist_ok=True)

b = "{},{},{},{}".format(*BBOX)
QUERIES = {
    "roads": f'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track|road)$"]({b});out geom;',
    "pois": f"""(
      nwr["amenity"~"^(school|college|university|kindergarten|hospital|clinic|doctors|health_post|pharmacy|marketplace|drinking_water|water_point|waste_disposal|recycling|police|townhall|bank|place_of_worship|bus_station|fuel)$"]({b});
      nwr["healthcare"]({b});
      nwr["man_made"~"^(water_well|water_tap|water_tower)$"]({b});
      nwr["landuse"="landfill"]({b});
    );out center tags;""",
    "buildings": f'way["building"]({b});out center;',
    "waterways": f'way["waterway"~"^(river|stream|canal|drain|ditch)$"]({b});out geom;',
    "water": f'(way["natural"="water"]({b});relation["natural"="water"]({b}););out geom;',
    "landuse": f'way["landuse"~"^(residential|commercial|industrial|farmland|forest|grass|meadow|military|cemetery|port|railway)$"]({b});out geom;',
    "admin": f'relation["boundary"="administrative"]["admin_level"~"^(6|7|8|9|10)$"]({b});out geom;',
}

for name, q in QUERIES.items():
    target = OUT / f"osm_{name}.json"
    if target.exists():
        print(f"[skip] {name}")
        continue
    print(f"[get ] {name} ...", end=" ", flush=True)
    for attempt in range(3):
        r = requests.post(OVERPASS, data={"data": f"[out:json][timeout:180];{q}"}, headers=HEADERS, timeout=240)
        if r.status_code == 200:
            break
        print(f"HTTP {r.status_code}, nouvel essai", end=" ")
        time.sleep(15)
    r.raise_for_status()
    js = r.json()
    target.write_text(json.dumps(js), encoding="utf-8")
    print(len(js["elements"]), "éléments")
    time.sleep(3)
