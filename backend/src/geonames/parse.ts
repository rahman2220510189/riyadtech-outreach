/**
 * GeoNames "dump" files (CC BY 4.0, https://www.geonames.org/):
 * - cities5000.txt: places with more than 5,000 people, 19 tab-separated columns
 * - admin1CodesASCII.txt: "US.TX<TAB>Texas<TAB>Texas<TAB>4736286"
 * Format: https://download.geonames.org/export/dump/readme.txt
 */

export interface RegionRecord {
  geonameId: number;
  country: string;
  admin1Code: string;
  name: string;
  asciiName: string;
  regionCode: string;
}

export interface CityRecord {
  geonameId: number;
  country: string;
  admin1Code: string | null;
  regionCode: string | null;
  name: string;
  asciiName: string;
  lat: number;
  lng: number;
  population: number;
  timezone: string | null;
}

/** ISO 3166-2 style code: the mapping from seed/countries.json, else "<country>-<admin1>". */
export function regionCodeFor(
  country: string,
  admin1: string | null | undefined,
  isoMap: Record<string, Record<string, string>>,
): string | null {
  if (!admin1 || admin1 === "00") return null;
  return isoMap[country]?.[admin1] ?? `${country}-${admin1}`;
}

function* lines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    if (line && !line.startsWith("#")) yield line;
    start = end + 1;
  }
}

export function parseAdmin1(
  text: string,
  countries: ReadonlySet<string>,
  isoMap: Record<string, Record<string, string>>,
): RegionRecord[] {
  const out: RegionRecord[] = [];
  for (const line of lines(text)) {
    const [code, name, asciiName, id] = line.split("\t");
    const [country, admin1] = (code ?? "").split(".");
    if (!country || !admin1 || !countries.has(country)) continue;
    const geonameId = Number(id);
    if (!Number.isInteger(geonameId) || !name) continue;
    out.push({
      geonameId,
      country,
      admin1Code: admin1,
      name,
      asciiName: asciiName || name,
      regionCode: regionCodeFor(country, admin1, isoMap) ?? `${country}-${admin1}`,
    });
  }
  return out;
}

export function parseCities(
  text: string,
  countries: ReadonlySet<string>,
  isoMap: Record<string, Record<string, string>>,
): CityRecord[] {
  const out: CityRecord[] = [];
  for (const line of lines(text)) {
    const c = line.split("\t");
    const country = c[8];
    if (!country || !countries.has(country) || c[6] !== "P") continue;
    const geonameId = Number(c[0]);
    const lat = Number(c[4]);
    const lng = Number(c[5]);
    if (!Number.isInteger(geonameId) || !Number.isFinite(lat) || !Number.isFinite(lng) || !c[1]) continue;
    const admin1 = c[10] || null;
    out.push({
      geonameId,
      country,
      admin1Code: admin1,
      regionCode: regionCodeFor(country, admin1, isoMap),
      name: c[1],
      asciiName: c[2] || c[1],
      lat,
      lng,
      population: Number(c[14]) || 0,
      timezone: c[17] || null,
    });
  }
  return out;
}
