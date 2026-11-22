import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileCategories, matchCategory, placeNodes } from "../src/finder/categories.js";
import { isPlatformDomain, pickOwnWebsite, websiteDomain } from "../src/finder/domain.js";
import {
  NearestCity,
  OutlineIndex,
  boxAround,
  bboxIntersection,
  radiusForPopulation,
  simplifyGeometry,
} from "../src/finder/geo.js";
import { groupConsecutive } from "../src/finder/overture/parquet.js";
import { areaKey } from "../src/finder/params.js";
import { parseAdmin1, parseCities, regionCodeFor } from "../src/geonames/parse.js";
import { loadSeedData } from "../src/seed/files.js";

const seed = loadSeedData();
const rules = compileCategories(seed.categories);

describe("seed files", () => {
  it("every category node exists in the Overture taxonomy (release 2026-09-23)", () => {
    const nodes = new Set(
      readFileSync(new URL("./fixtures/taxonomy-nodes-2026-09-23.txt", import.meta.url), "utf8").split("\n").filter(Boolean),
    );
    const missing = seed.categories.flatMap((c) => [...c.nodes, ...c.exclude].filter((n) => !nodes.has(n)));
    expect(missing).toEqual([]);
  });

  it("lists all of Europe, starts with only the prompt's four markets, verified rules only for them", () => {
    const codes = seed.countries.map((c) => c.code);
    for (const c of ["FR", "ES", "IT", "NL", "PL", "SE", "NO", "CH", "IS", "PT", "GR", "RO", "UA"]) expect(codes).toContain(c);
    expect(codes).not.toContain("RU");
    expect(codes).not.toContain("BY");
    expect(seed.countries.filter((c) => c.enabled).map((c) => c.code)).toEqual(["GB", "IE", "US", "AU"]);
    expect(seed.countries.filter((c) => c.outreachRules.verified).map((c) => c.code)).toEqual(["GB", "IE", "US", "AU"]);
    expect(seed.countries.filter((c) => c.regionImports).map((c) => c.code)).toEqual(["US", "AU"]);
    for (const c of seed.countries) {
      const [w, s, e, n] = c.bbox;
      expect(w < e && s < n, c.code).toBe(true);
      for (const tz of c.timezones) expect(() => new Intl.DateTimeFormat("en", { timeZone: tz }), `${c.code} ${tz}`).not.toThrow();
    }
  });

  it("covers both segments and blocks Germany and Austria", () => {
    expect(seed.categories.some((c) => c.segment === "A")).toBe(true);
    expect(seed.categories.some((c) => c.segment === "B")).toBe(true);
    const blocked = seed.countries.filter((c) => c.blocked).map((c) => c.code).sort();
    expect(blocked).toEqual(["AT", "DE"]);
    expect(seed.countries.filter((c) => c.blocked).every((c) => !c.enabled)).toBe(true);
    expect(seed.countries.find((c) => c.code === "US")?.allowWholeCountry).toBe(false);
  });
});

describe("category matching", () => {
  const match = (hierarchy: string[], keys?: string[]) =>
    matchCategory(rules, placeNodes({ primary: hierarchy.at(-1)!, hierarchy }), keys ? new Set(keys) : undefined)?.key ?? null;

  it("maps real taxonomy paths to our categories", () => {
    expect(match(["health_care", "outpatient_care_facility", "dental_clinic", "orthodontics"])).toBe("dentist");
    expect(match(["services_and_business", "design_service", "web_designer"])).toBe("web_design");
    expect(match(["services_and_business", "legal_service", "attorney_or_law_firm", "tax_law"])).toBe("law_firm");
    expect(match(["services_and_business", "professional_service", "internet_marketing_service"])).toBe("seo_agency");
    expect(match(["shopping", "vehicle_dealer", "auto_dealer", "used_auto_dealer"])).toBe("car_dealer");
  });

  it("aesthetic clinics win over the general clinic rule, and excluded nodes never match", () => {
    const aesthetic = ["health_care", "outpatient_care_facility", "specialized_health_care", "medical_skin_care", "aesthetic_medicine"];
    expect(match(aesthetic)).toBe("aesthetic_clinic");
    expect(match(aesthetic, ["medical_clinic"])).toBeNull();
    expect(match(["lodging", "hotel", "motel"])).toBeNull();
    expect(match(["lodging", "hotel"])).toBe("hotel");
  });

  it("does not map unrelated places, and uses basic_category when taxonomy is missing", () => {
    expect(match(["food_and_drink", "restaurant"])).toBeNull();
    expect(matchCategory(rules, placeNodes(null, "dental_clinic"))?.key).toBe("dentist");
    expect(matchCategory(rules, placeNodes(null, null))).toBeNull();
  });
});

describe("website domains", () => {
  it("normalises domains", () => {
    expect(websiteDomain("https://www.Smile-Dental.co.uk/contact?x=1")).toBe("smile-dental.co.uk");
    expect(websiteDomain("pixelandpine.studio/contact")).toBe("pixelandpine.studio");
    expect(websiteDomain("http://www2.example.com")).toBe("example.com");
    expect(websiteDomain("http://192.168.1.1/")).toBeNull();
    expect(websiteDomain("mailto:a@b.com")).toBeNull();
    expect(websiteDomain("tel:+441610000000")).toBeNull();
    expect(websiteDomain("https://user:pw@evil.com")).toBeNull();
    expect(websiteDomain("example.com:8080/x")).toBe("example.com");
    expect(websiteDomain("localhost:3000")).toBeNull();
    expect(websiteDomain("")).toBeNull();
  });

  it("skips platforms and subdomains of platforms", () => {
    expect(isPlatformDomain("facebook.com", seed.platformDomains)).toBe(true);
    expect(isPlatformDomain("m.facebook.com", seed.platformDomains)).toBe(true);
    expect(isPlatformDomain("myfacebook.com", seed.platformDomains)).toBe(false);
    expect(
      pickOwnWebsite(["https://www.facebook.com/x", "https://linktr.ee/x", "https://www.realsite.ie/"], seed.platformDomains),
    ).toEqual({ website: "https://www.realsite.ie/", domain: "realsite.ie" });
    expect(pickOwnWebsite(["https://instagram.com/x"], seed.platformDomains)).toBeNull();
  });
});

describe("geo", () => {
  it("builds a city box and a population-based radius", () => {
    const b = boxAround(53.48, -2.24, 10);
    expect(b[3] - b[1]).toBeCloseTo((2 * 10) / 111.32, 3);
    expect(radiusForPopulation(0)).toBe(5);
    expect(radiusForPopulation(400_000)).toBeCloseTo(16.6, 1);
    expect(radiusForPopulation(50_000_000)).toBe(30);
    expect(bboxIntersection([0, 0, 2, 2], [1, 1, 3, 3])).toEqual([1, 1, 2, 2]);
    expect(bboxIntersection([0, 0, 1, 1], [2, 2, 3, 3])).toBeNull();
  });

  it("tests points against a polygon with a hole and a notch", () => {
    const outline = new OutlineIndex({
      type: "MultiPolygon",
      coordinates: [
        [
          [[0, 0], [10, 0], [10, 4], [5, 4], [5, 6], [10, 6], [10, 10], [0, 10], [0, 0]],
          [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
        ],
        [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]],
      ],
    });
    expect(outline.contains(3, 3)).toBe(true);
    expect(outline.contains(1.5, 1.5)).toBe(false); // hole
    expect(outline.contains(7, 5)).toBe(false); // notch
    expect(outline.contains(20.5, 20.5)).toBe(true); // second polygon
    expect(outline.contains(15, 15)).toBe(false);
  });

  it("simplifies long rings and drops collapsed ones", () => {
    const wiggly = Array.from({ length: 1001 }, (_, i) => [i / 100, i % 2 === 0 ? 0 : 0.00001]);
    const ring = [...wiggly, [10, 5], [0, 5], [0, 0]];
    const tiny = [[50, 50], [50.00001, 50], [50.00001, 50.00001], [50, 50]];
    const { geometry, points } = simplifyGeometry({ type: "MultiPolygon", coordinates: [[ring], [tiny]] }, 0.001);
    expect(points).toBeLessThan(10);
    expect((geometry.coordinates as number[][][][]).length).toBe(1);
  });

  it("finds the nearest city", () => {
    const n = new NearestCity([
      { name: "Manchester", lat: 53.48, lng: -2.24, timezone: "Europe/London", regionCode: "GB-ENG" },
      { name: "Liverpool", lat: 53.41, lng: -2.98, timezone: "Europe/London", regionCode: "GB-ENG" },
    ]);
    expect(n.nearest(53.45, -2.3)?.name).toBe("Manchester");
    expect(n.nearest(53.4, -2.9)?.name).toBe("Liverpool");
    expect(new NearestCity([]).nearest(0, 0)).toBeNull();
  });
});

describe("row group units", () => {
  it("groups consecutive row groups up to the size", () => {
    const g = (index: number) => ({ index, rowStart: index * 10, rowEnd: index * 10 + 10, bbox: null });
    const units = groupConsecutive([g(0), g(1), g(2), g(5), g(6), g(9)], 2).map((u) => u.map((x) => x.index));
    expect(units).toEqual([[0, 1], [2], [5, 6], [9]]);
  });
});

describe("GeoNames parsing", () => {
  const iso = { AU: { "04": "AU-QLD" } };
  it("maps admin1 codes to ISO-style region codes", () => {
    expect(regionCodeFor("US", "TX", iso)).toBe("US-TX");
    expect(regionCodeFor("AU", "04", iso)).toBe("AU-QLD");
    expect(regionCodeFor("GB", "00", iso)).toBeNull();
  });
  it("keeps populated places of the wanted countries only", () => {
    const text = [
      ["1", "Austin", "Austin", "", "30.26", "-97.74", "P", "PPLA", "US", "", "TX", "", "", "", "961855", "", "", "America/Chicago", "x"],
      ["2", "A Hill", "A Hill", "", "30", "-97", "T", "HLL", "US", "", "TX", "", "", "", "0", "", "", "America/Chicago", "x"],
      ["3", "Berlin", "Berlin", "", "52.5", "13.4", "P", "PPLC", "DE", "", "16", "", "", "", "3426354", "", "", "Europe/Berlin", "x"],
    ]
      .map((r) => r.join("\t"))
      .join("\r\n");
    const cities = parseCities(text, new Set(["US"]), iso);
    expect(cities).toEqual([
      expect.objectContaining({ geonameId: 1, name: "Austin", regionCode: "US-TX", population: 961855, timezone: "America/Chicago" }),
    ]);
    const regions = parseAdmin1("US.TX\tTexas\tTexas\t4736286\nAU.04\tQueensland\tQueensland\t2152274\n", new Set(["US", "AU"]), iso);
    expect(regions.map((r) => r.regionCode)).toEqual(["US-TX", "AU-QLD"]);
  });
});

describe("areaKey", () => {
  it("ignores order of segments and categories", () => {
    const a = areaKey({ country: "GB", cityGeonameId: 1, segments: ["B", "A"] }, ["b", "a"]);
    const b = areaKey({ country: "GB", cityGeonameId: 1, segments: ["A", "B"] }, ["a", "b"]);
    expect(a).toBe(b);
  });
});

describe("WKB fallback", () => {
  const le = (parts: (["u8", number] | ["u32", number] | ["f64", number])[]) => {
    const size = parts.reduce((n, [t]) => n + (t === "u8" ? 1 : t === "u32" ? 4 : 8), 0);
    const view = new DataView(new ArrayBuffer(size));
    let p = 0;
    for (const [t, v] of parts) {
      if (t === "u8") {
        view.setUint8(p, v);
        p += 1;
      } else if (t === "u32") {
        view.setUint32(p, v, true);
        p += 4;
      } else {
        view.setFloat64(p, v, true);
        p += 8;
      }
    }
    return new Uint8Array(view.buffer);
  };
  const square: (["u8", number] | ["u32", number] | ["f64", number])[] = [
    ["u32", 1],
    ["u32", 5],
    ...[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]].flatMap(([x, y]) => [["f64", x!], ["f64", y!]] as ["f64", number][]),
  ];

  it("reads Polygon and MultiPolygon", async () => {
    const { polygonFromWkb } = await import("../src/finder/overture/wkb.js");
    expect(polygonFromWkb(le([["u8", 1], ["u32", 3], ...square]))).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    });
    const multi = polygonFromWkb(le([["u8", 1], ["u32", 6], ["u32", 2], ["u8", 1], ["u32", 3], ...square, ["u8", 1], ["u32", 3], ...square]));
    expect(multi?.type).toBe("MultiPolygon");
    expect((multi?.coordinates as number[][][][]).length).toBe(2);
    expect(polygonFromWkb(le([["u8", 1], ["u32", 1], ["f64", 1], ["f64", 2]]))).toBeNull(); // a point
    expect(polygonFromWkb(new Uint8Array([1, 3, 0]))).toBeNull(); // truncated
  });
});

describe("place filter without outlines (address check)", async () => {
  const { filterPlace } = await import("../src/finder/overture/places.js");
  const ctx = {
    box: [-100, 25, -90, 35] as [number, number, number, number],
    outline: null,
    outlineKind: null,
    country: "US",
    regionCode: "US-TX",
    minConfidence: 0.6,
    rules,
    allowedKeys: new Set(seed.categories.map((c) => c.key)),
    platforms: seed.platformDomains,
    nearest: null,
    addressCheck: true,
  };
  const row = (addresses: object[] | null) => ({
    id: "x",
    bbox: { xmin: -97.7, xmax: -97.7, ymin: 30.3, ymax: 30.3 },
    names: { primary: "Test Dental" },
    taxonomy: { primary: "dental_clinic", hierarchy: ["health_care", "outpatient_care_facility", "dental_clinic"] },
    confidence: 0.9,
    websites: ["https://testdental.example"],
    addresses,
  });
  const reason = (addresses: object[] | null) => {
    const r = filterPlace(row(addresses), ctx);
    return "kept" in r ? "kept" : r.skipped;
  };

  it("keeps places whose address names the country and state, or has no country", () => {
    expect(reason([{ country: "US", region: "TX" }])).toBe("kept");
    expect(reason([{ country: "us", region: "tx" }])).toBe("kept");
    expect(reason([{ country: "US", region: "US-TX" }])).toBe("kept");
    expect(reason([{ country: "US" }])).toBe("kept");
    expect(reason([{ locality: "Austin" }])).toBe("kept");
    expect(reason(null)).toBe("kept");
  });

  it("drops places whose address names another country or another state", () => {
    expect(reason([{ country: "MX" }])).toBe("outside_outline");
    expect(reason([{ country: "US", region: "OK" }])).toBe("outside_outline");
    expect(filterPlace(row([{ country: "US", region: "OK" }]), { ...ctx, regionCode: null })).toHaveProperty("kept");
  });
});
