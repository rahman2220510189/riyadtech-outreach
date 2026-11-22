"""
Test data uses a fake release (1999-12-31.0), reserved .invalid domains and GeoNames ids from
990000000, so integration tests on a real (dev) database can remove exactly what they created.

Builds small test files shaped like the real Overture release (schema v2.0.0) and GeoNames dumps.
Test-only; needs pyarrow (pip install pyarrow). The generated files are committed, so the
tests do not need Python. Re-run after changing this script:

    python test/fixtures/overture/make_fixtures.py

Layout (served by test/helpers/fixture-server.ts; "{BASE}" in JSON becomes the server URL):
    stac/catalog.json, stac/<release>/<theme>/<type>/collection.json + items
    data/places/part-0000N.zstd.parquet, data/divisions/part-00000.zstd.parquet
    geonames/cities5000.zip, geonames/admin1CodesASCII.txt
"""
import io
import json
import os
import random
import struct
import zipfile

import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
# A fake release name: test rows (places.release, area_outlines.release) can never be mistaken for real ones.
RELEASE = "1999-12-31.0"
random.seed(42)

# ---------------------------------------------------------------------------- places

ADDRESS = pa.struct([("freeform", pa.string()), ("locality", pa.string()), ("postcode", pa.string()),
                     ("region", pa.string()), ("country", pa.string())])
BBOX = pa.struct([("xmin", pa.float32()), ("xmax", pa.float32()), ("ymin", pa.float32()), ("ymax", pa.float32())])
PLACE_SCHEMA = pa.schema([
    ("id", pa.string()),
    ("geometry", pa.binary()),
    ("bbox", BBOX),
    ("version", pa.int32()),
    ("names", pa.struct([("primary", pa.string())])),
    ("taxonomy", pa.struct([("primary", pa.string()), ("hierarchy", pa.list_(pa.string())),
                            ("alternates", pa.list_(pa.string()))])),
    ("basic_category", pa.string()),
    ("confidence", pa.float64()),
    ("websites", pa.list_(pa.string())),
    ("socials", pa.list_(pa.string())),
    ("emails", pa.list_(pa.string())),
    ("phones", pa.list_(pa.string())),
    ("addresses", pa.list_(ADDRESS)),
    ("operating_status", pa.string()),
])

TAX = {
    "dentist": ["health_care", "outpatient_care_facility", "dental_clinic", "general_dentistry"],
    "web": ["services_and_business", "design_service", "web_designer"],
    "software": ["services_and_business", "technical_service", "software_development"],
    "law": ["services_and_business", "legal_service", "attorney_or_law_firm", "business_law"],
    "accountant": ["services_and_business", "financial_service", "accountant"],
    "hotel": ["lodging", "hotel"],
    "motel": ["lodging", "hotel", "motel"],
    "restaurant": ["food_and_drink", "restaurant", "casual_eatery"],
    "marketing": ["services_and_business", "professional_service", "marketing_agency"],
    "aesthetic": ["health_care", "outpatient_care_facility", "specialized_health_care", "medical_skin_care", "aesthetic_medicine"],
    "realestate": ["services_and_business", "real_estate_service", "real_estate_agent"],
    "physio": ["health_care", "outpatient_care_facility", "physical_medicine_and_rehabilitation", "physical_therapy"],
}


def point_wkb(lng, lat):
    return struct.pack("<BIdd", 1, 1, lng, lat)


def place(pid, name, lng, lat, kind, website=None, confidence=0.9, status="open", country=None,
          locality=None, region=None, emails=None, phone=None):
    h = TAX[kind]
    return {
        "id": pid,
        "geometry": point_wkb(lng, lat),
        "bbox": {"xmin": lng, "xmax": lng, "ymin": lat, "ymax": lat},
        "version": 1,
        "names": {"primary": name},
        "taxonomy": {"primary": h[-1], "hierarchy": h, "alternates": []},
        "basic_category": h[2] if len(h) > 2 else h[-1],
        "confidence": confidence,
        "websites": [website] if website else None,
        "socials": None,
        "emails": emails,
        "phones": [phone] if phone else None,
        "addresses": [{"freeform": f"1 {name} Street", "locality": locality, "postcode": None,
                       "region": region, "country": country}] if (country or locality) else None,
        "operating_status": status,
    }


def filler(prefix, n, lng0, lng1, lat0, lat1, country):
    rows = []
    for i in range(n):
        rows.append(place(f"{prefix}-{i}", f"Cafe {prefix} {i}", random.uniform(lng0, lng1),
                          random.uniform(lat0, lat1), "restaurant", f"https://cafe-{prefix}-{i}.invalid",
                          country=country))
    return rows


MCR = []  # Manchester area (city centre 53.4808, -2.2426)
MCR += [
    place("gb-1", "Smile Dental Manchester", -2.2400, 53.4800, "dentist", "https://www.smiledental-mcr.invalid/",
          country="GB", locality="Manchester", emails=["Hello@smiledental-mcr.invalid"], phone="+44 161 000 0001"),
    place("gb-2a", "Brightsmile Dental Ancoats", -2.2300, 53.4850, "dentist", "https://brightsmile.invalid/ancoats",
          confidence=0.8, country="GB", locality="Manchester"),
    place("gb-2b", "Brightsmile Dental Didsbury", -2.2300, 53.4150, "dentist", "https://www.brightsmile.invalid/didsbury",
          confidence=0.95, country="GB", locality="Didsbury"),
    place("gb-3", "Pixel & Pine Studio", -2.2500, 53.4790, "web", "pixelandpine.invalid/contact", country="GB"),
    place("gb-4", "North Code Ltd", -2.2450, 53.4700, "software", "https://northcode.invalid", country="GB"),
    place("gb-5", "Harper Law", -2.2420, 53.4810, "law", "https://harperlaw.invalid", country="GB"),
    place("gb-6", "No Web Dental", -2.2410, 53.4820, "dentist", None, country="GB"),
    place("gb-7", "Unsure Accountants", -2.2430, 53.4830, "accountant", "https://unsure.invalid", confidence=0.4, country="GB"),
    place("gb-8", "Closed Hotel", -2.2440, 53.4840, "hotel", "https://closedhotel.invalid", status="permanently_closed", country="GB"),
    place("gb-9", "Curry Corner", -2.2460, 53.4850, "restaurant", "https://currycorner.invalid", country="GB"),
    place("gb-10", "Social Only Marketing", -2.2470, 53.4860, "marketing", "https://www.facebook.com/socialonly", country="GB"),
    place("gb-11", "Glow Aesthetics", -2.2480, 53.4870, "aesthetic", "https://glowaesthetics.invalid", country="GB"),
    place("gb-12", "Roadside Motel", -2.2490, 53.4880, "motel", "https://roadsidemotel.invalid", country="GB"),
    # In the city box but outside the (notched) GB outline: kept only when the address names GB.
    place("gb-13", "Edge Dental", -2.0300, 53.3500, "dentist", "https://edgedental.invalid", country="GB"),
    place("gb-14", "Nowhere Dental", -2.0350, 53.3550, "dentist", "https://nowheredental.invalid"),
    # Outside the Manchester box.
    place("gb-15", "Liverpool Dental", -2.9800, 53.4100, "dentist", "https://liverpooldental.invalid", country="GB"),
]
LON = filler("lon", 400, -0.30, 0.10, 51.40, 51.60, "GB")  # London: separate row groups, must be pruned
DUB = [
    place("ie-1", "Liffey Marketing", -6.2600, 53.3500, "marketing", "https://liffeymarketing.invalid", country="IE"),
    place("ie-2", "Dublin Dental Care", -6.2550, 53.3450, "dentist", "https://dublindentalcare.invalid", country="IE"),
    place("ie-3", "Temple Hotel", -6.2650, 53.3460, "hotel", "https://templehotel.invalid", country="IE"),
]
AUS = [  # Austin 30.2672, -97.7431
    place("us-1", "Lone Star Dental", -97.7400, 30.2700, "dentist", "https://lonestardental.invalid", country="US", region="TX"),
    place("us-2", "Capitol Law Group", -97.7450, 30.2690, "law", "https://capitollawgroup.invalid", country="US", region="TX"),
    place("us-3", "Hill Country Web Co", -97.7500, 30.2650, "web", "https://hillcountryweb.invalid", country="US", region="TX"),
    place("us-4", "Austin Growth Agency", -97.7350, 30.2750, "marketing", "https://austingrowth.invalid", country="US", region="TX"),
    place("us-5", "Bluebonnet Realty", -97.7300, 30.2600, "realestate", "https://bluebonnetrealty.invalid", country="US", region="TX"),
]
HOU = filler("hou", 300, -95.50, -95.20, 29.70, 29.90, "US")
BNE = [  # Brisbane -27.4698, 153.0251
    place("au-1", "River City Dental", 153.0250, -27.4700, "dentist", "https://rivercitydental.invalid", country="AU", region="QLD"),
    place("au-2", "Brisbane Ledger Co", 153.0300, -27.4650, "accountant", "https://ledgerco.invalid", country="AU", region="QLD"),
    place("au-3", "Moveright Physio", 153.0200, -27.4750, "physio", "https://moverightphysio.invalid", country="AU", region="QLD"),
]
SYD = filler("syd", 200, 151.10, 151.30, -33.95, -33.80, "AU")


def write_places(path, rows):
    rows = sorted(rows, key=lambda r: (r["bbox"]["xmin"], r["bbox"]["ymin"]))  # spatial-ish order, like Overture
    table = pa.Table.from_pylist(rows, schema=PLACE_SCHEMA)
    geo = {"version": "1.1.0", "primary_column": "geometry",
           "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["Point"]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo).encode()})
    pq.write_table(table, path, row_group_size=40, compression="zstd", write_statistics=True)
    return table.num_rows


# ---------------------------------------------------------------------------- divisions

def ring(coords):
    return coords + [coords[0]]


def polygon_wkb(rings):
    out = struct.pack("<BII", 1, 3, len(rings))
    for r in rings:
        out += struct.pack("<I", len(r))
        for x, y in r:
            out += struct.pack("<dd", x, y)
    return out


def multipolygon_wkb(polys):
    out = struct.pack("<BII", 1, 6, len(polys))
    for p in polys:
        out += polygon_wkb(p)
    return out


def bbox_of(rings):
    xs = [x for r in rings for x, _ in r]
    ys = [y for r in rings for _, y in r]
    return {"xmin": min(xs), "xmax": max(xs), "ymin": min(ys), "ymax": max(ys)}


# GB territorial outline: a box around Great Britain with a slot cut out (x > -2.05, 53.30 < y < 53.37),
# reaching into the Manchester city box from the east. Places in the slot are "outside the outline".
GB_TERR = ring([(-8.0, 49.9), (1.8, 49.9), (1.8, 53.30), (-2.05, 53.30), (-2.05, 53.37), (1.8, 53.37),
                (1.8, 60.9), (-8.0, 60.9)])
GB_LAND = ring([(-6.0, 50.0), (1.7, 50.0), (1.7, 58.6), (-6.0, 58.6)])
GB_ISLAND = ring([(-7.0, 57.0), (-6.5, 57.0), (-6.5, 57.3), (-7.0, 57.3)])
IE_TERR = ring([(-10.6, 51.4), (-6.0, 51.4), (-6.0, 55.4), (-10.6, 55.4)])
TX = ring([(-106.6, 25.8), (-93.5, 25.8), (-93.5, 36.5), (-106.6, 36.5)])
OK = ring([(-103.0, 33.6), (-94.4, 33.6), (-94.4, 37.0), (-103.0, 37.0)])
QLD = ring([(138.0, -29.2), (153.6, -29.2), (153.6, -10.0), (138.0, -10.0)])

DIV_SCHEMA = pa.schema([
    ("id", pa.string()), ("geometry", pa.binary()), ("bbox", BBOX), ("subtype", pa.string()), ("class", pa.string()),
    ("names", pa.struct([("primary", pa.string())])), ("country", pa.string()), ("region", pa.string()),
    ("is_land", pa.bool_()), ("is_territorial", pa.bool_()),
])


def division(did, subtype, country, region, name, geom_wkb, rings, land, terr):
    return {"id": did, "geometry": geom_wkb, "bbox": bbox_of(rings), "subtype": subtype, "class": "land",
            "names": {"primary": name}, "country": country, "region": region, "is_land": land, "is_territorial": terr}


def write_divisions(path):
    rows = [
        division("d-gb-land", "country", "GB", None, "United Kingdom", multipolygon_wkb([[GB_LAND], [GB_ISLAND]]),
                 [GB_LAND, GB_ISLAND], True, False),
        division("d-gb-terr", "country", "GB", None, "United Kingdom", polygon_wkb([GB_TERR]), [GB_TERR], False, True),
        division("d-ie", "country", "IE", None, "Ireland", polygon_wkb([IE_TERR]), [IE_TERR], True, True),
        division("d-tx", "region", "US", "US-TX", "Texas", polygon_wkb([TX]), [TX], True, True),
        division("d-ok", "region", "US", "US-OK", "Oklahoma", polygon_wkb([OK]), [OK], True, True),
        division("d-qld", "region", "AU", "AU-QLD", "Queensland", polygon_wkb([QLD]), [QLD], True, True),
        division("d-mcr", "locality", "GB", "GB-ENG", "Manchester", polygon_wkb([ring([(-2.3, 53.4), (-2.1, 53.4), (-2.1, 53.5), (-2.3, 53.5)])]),
                 [ring([(-2.3, 53.4), (-2.1, 53.4), (-2.1, 53.5), (-2.3, 53.5)])], True, False),
    ]
    rows.sort(key=lambda r: r["bbox"]["xmin"])
    table = pa.Table.from_pylist(rows, schema=DIV_SCHEMA)
    geo = {"version": "1.1.0", "primary_column": "geometry",
           "columns": {"geometry": {"encoding": "WKB", "geometry_types": ["Polygon", "MultiPolygon"]}}}
    table = table.replace_schema_metadata({b"geo": json.dumps(geo).encode()})
    pq.write_table(table, path, row_group_size=2, compression="zstd", write_statistics=True)


# ---------------------------------------------------------------------------- STAC

def stac(files_by_type):
    root = os.path.join(HERE, "stac")
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "catalog.json"), "w") as f:
        json.dump({"type": "Catalog", "id": "Overture Releases", "latest": RELEASE, "links": [
            {"rel": "child", "href": "{BASE}/stac/2026-08-19.0/catalog.json"},
            {"rel": "child", "href": f"{{BASE}}/stac/{RELEASE}/catalog.json", "latest": True}]}, f, indent=1)
    for (theme, typ), files in files_by_type.items():
        cdir = os.path.join(root, RELEASE, theme, typ)
        os.makedirs(cdir, exist_ok=True)
        links = []
        for i, (rel_path, bbox) in enumerate(files):
            item_id = f"{i:05d}"
            os.makedirs(os.path.join(cdir, item_id), exist_ok=True)
            size = os.path.getsize(os.path.join(HERE, rel_path))
            item = {"type": "Feature", "id": item_id, "bbox": bbox,
                    "properties": {"num_rows": pq.ParquetFile(os.path.join(HERE, rel_path)).metadata.num_rows},
                    "assets": {"aws": {"href": f"{{BASE}}/{rel_path}", "file:size": size,
                                       "alternate": {"s3": {"href": f"s3://test/{rel_path}"}}}}}
            with open(os.path.join(cdir, item_id, f"{item_id}.json"), "w") as f:
                json.dump(item, f, indent=1)
            links.append({"rel": "item", "href": f"{{BASE}}/stac/{RELEASE}/{theme}/{typ}/{item_id}/{item_id}.json"})
        with open(os.path.join(cdir, "collection.json"), "w") as f:
            json.dump({"type": "Collection", "id": typ, "links": links}, f, indent=1)


def file_bbox(rows):
    return [min(r["bbox"]["xmin"] for r in rows), min(r["bbox"]["ymin"] for r in rows),
            max(r["bbox"]["xmax"] for r in rows), max(r["bbox"]["ymax"] for r in rows)]


# ---------------------------------------------------------------------------- GeoNames

CITIES = [
    # geonameid, name, ascii, lat, lng, country, admin1, population, timezone
    (990643123, "Manchester", "Manchester", 53.48095, -2.23743, "GB", "ENG", 395515, "Europe/London"),
    (990644210, "Liverpool", "Liverpool", 53.41058, -2.97794, "GB", "ENG", 864122, "Europe/London"),
    (990643743, "London", "London", 51.50853, -0.12574, "GB", "ENG", 8961989, "Europe/London"),
    (990964574, "Dublin", "Dublin", 53.33306, -6.24889, "IE", "L", 1024027, "Europe/Dublin"),
    (990671654, "Austin", "Austin", 30.26715, -97.74306, "US", "TX", 961855, "America/Chicago"),
    (990699066, "Houston", "Houston", 29.76328, -95.36327, "US", "TX", 2304580, "America/Chicago"),
    (990544349, "Oklahoma City", "Oklahoma City", 35.46756, -97.51643, "US", "OK", 681054, "America/Chicago"),
    (990174003, "Brisbane", "Brisbane", -27.46794, 153.02809, "AU", "04", 2189878, "Australia/Brisbane"),
    (990147714, "Sydney", "Sydney", -33.86785, 151.20732, "AU", "02", 4627345, "Australia/Sydney"),
    (990950159, "Berlin", "Berlin", 52.52437, 13.41053, "DE", "16", 3426354, "Europe/Berlin"),
    (990999001, "Tiny Hamlet", "Tiny Hamlet", 53.0, -2.0, "GB", "ENG", 5100, "Europe/London"),
]
ADMIN1 = [("GB.ENG", "England", 991000001), ("GB.SCT", "Scotland", 991000002), ("IE.L", "Leinster", 991000003),
          ("US.TX", "Texas", 991000004), ("US.OK", "Oklahoma", 991000005), ("AU.04", "Queensland", 991000006),
          ("AU.02", "New South Wales", 991000007), ("DE.16", "Berlin", 991000008)]


def geonames():
    gdir = os.path.join(HERE, "geonames")
    os.makedirs(gdir, exist_ok=True)
    lines = []
    for gid, name, ascii_name, lat, lng, cc, a1, pop, tz in CITIES:
        cols = [str(gid), name, ascii_name, "", f"{lat:.5f}", f"{lng:.5f}", "P", "PPLA", cc, "", a1, "", "", "",
                str(pop), "", "10", tz, "2026-01-01"]
        lines.append("\t".join(cols))
    lines.append("\t".join(["998888001", "Some Hill", "Some Hill", "", "53.1", "-2.1", "T", "HLL", "GB", "", "ENG",
                            "", "", "", "0", "", "200", "Europe/London", "2026-01-01"]))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("cities5000.txt", "\n".join(lines) + "\n")
    with open(os.path.join(gdir, "cities5000.zip"), "wb") as f:
        f.write(buf.getvalue())
    with open(os.path.join(gdir, "admin1CodesASCII.txt"), "w") as f:
        f.write("\n".join(f"{c}\t{n}\t{n}\t{g}" for c, n, g in ADMIN1) + "\n")


def main():
    os.makedirs(os.path.join(HERE, "data", "places"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "data", "divisions"), exist_ok=True)
    europe = MCR + LON + DUB
    america = AUS + HOU
    australia = BNE + SYD
    files = {("places", "place"): [], ("divisions", "division_area"): []}
    for i, rows in enumerate([america, europe, australia]):
        rel = f"data/places/part-0000{i}.zstd.parquet"
        n = write_places(os.path.join(HERE, rel), rows)
        files[("places", "place")].append((rel, file_bbox(rows)))
        print(rel, n, "rows")
    write_divisions(os.path.join(HERE, "data/divisions/part-00000.zstd.parquet"))
    files[("divisions", "division_area")].append(("data/divisions/part-00000.zstd.parquet", [-106.6, -29.2, 153.6, 60.9]))
    stac(files)
    geonames()


if __name__ == "__main__":
    main()
