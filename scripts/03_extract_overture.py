"""
03_extract_overture.py - Lieux (équipements) Overture Maps sur Boma, pour compléter OSM.
Sortie : data_raw/overture_places.json
"""
import json
from pathlib import Path
import duckdb

S, W, N, E = -5.875, 12.995, -5.790, 13.125
RELEASE = "2026-11-18.0"
OUT = Path(__file__).resolve().parent.parent / "data_raw" / "overture_places.json"

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
rows = con.execute(f"""
  SELECT names.primary AS name, taxonomy.primary AS cat, basic_category AS basic, confidence,
         ST_X(geometry) AS lon, ST_Y(geometry) AS lat
  FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*', hive_partitioning=1)
  WHERE bbox.xmin BETWEEN {W} AND {E} AND bbox.ymin BETWEEN {S} AND {N}
""").fetchall()
data = [dict(name=r[0], cat=r[1], basic=r[2], conf=r[3], lon=r[4], lat=r[5]) for r in rows]
OUT.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
print(len(data), "lieux")
