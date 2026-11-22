/**
 * Job adverts from the job APIs: developer titles, flags, stack, company names,
 * and the two sources read from fixtures shaped like the real answers (no network).
 */
import { describe, expect, it } from "vitest";
import { companyKey, flagsOf, htmlToText, isDevTitle, roleOf, stackMatch, writtenInEnglish } from "../src/jobads/detect.js";
import { ApiStatusError, baAdvert, fetchArbeitnow, fetchBa, findAdArray, type SourceDeps } from "../src/jobads/sources.js";

describe("job advert detection", () => {
  it("recognises developer titles in German and English, and not business or hardware developers", () => {
    for (const t of [
      "Softwareentwickler (m/w/d)",
      "Senior React Developer (all genders)",
      "Fullstack-Entwickler (m/w/d) TypeScript",
      "Java Developer",
      "Fachinformatiker für Anwendungsentwicklung (m/w/d)",
      "Webentwickler/in",
      "Backend Engineer – Node.js",
      ".NET Entwickler (w/m/d)",
    ]) {
      expect(isDevTitle(t), t).toBe(true);
    }
    for (const t of ["Business Developer (m/w/d)", "Elektronikentwickler (m/w/d)", "Projektentwickler Immobilien", "Verkäufer (m/w/d)", "Personalentwickler"]) {
      expect(isDevTitle(t), t).toBe(false);
    }
    expect(roleOf("Senior React Developer (m/w/d)")).toBe("Senior React Developer");
    expect(roleOf("Softwareentwickler (w/m/d) – Berlin")).toBe("Softwareentwickler – Berlin");
  });

  it("flags remote, visa, English and German requirements, and our stack", () => {
    const en = "We are looking for a developer. You will work with our team on our product, and you are fluent in English. This is a remote first company with visa sponsorship and relocation support for the right person in the team.";
    expect(writtenInEnglish(en)).toBe(true);
    expect(flagsOf(en)).toEqual(expect.arrayContaining(["remote", "visa", "ad_english"]));
    const de = "Wir suchen dich als Entwickler. Du hast sehr gute Deutschkenntnisse und arbeitest mit unserem Team in Berlin. Home Office ist möglich.";
    expect(flagsOf(de)).toEqual(expect.arrayContaining(["local_lang", "remote"]));
    expect(flagsOf(de)).not.toContain("ad_english");
    expect(flagsOf("Developer", true)).toContain("remote");
    expect(flagsOf("Fließende Deutschkenntnisse in Wort und Schrift")).toContain("local_lang");
    expect(flagsOf("Deutschkenntnisse auf C1-Niveau")).toContain("local_lang");
    expect(stackMatch("Senior Engineer: React, TypeScript, Node.js")).toBe(true);
    expect(stackMatch("Java and Spring Boot")).toBe(false);
  });

  it("compares company names without legal forms", () => {
    expect(companyKey("ACME Software GmbH & Co. KG")).toBe("acme software");
    expect(companyKey("Müller Digital AG")).toBe("muller digital");
    expect(companyKey("Pixel Studio Ltd.")).toBe("pixel studio");
    expect(htmlToText("<p>Hello&nbsp;<b>you</b></p><ul><li>One</li></ul>")).toBe("Hello you\n• One");
  });
});

function fakeDeps(answers: Record<string, unknown>, seen: { url: string; headers: Record<string, string> }[]): SourceDeps {
  return {
    getJson: (url, headers = {}) => {
      seen.push({ url, headers });
      const key = Object.keys(answers).find((k) => url.includes(k));
      if (!key) return Promise.reject(new Error(`no fixture for ${url}`));
      return Promise.resolve(answers[key]);
    },
    sleep: () => Promise.resolve(),
    delayMs: 1000,
    baBase: "https://ba.test",
    arbeitnowBase: "https://an.test/api",
  };
}

describe("job API sources (fixtures)", () => {
  it("Bundesagentur: searches each word with the public key, pages, reads the text of new developer adverts", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const deps = fakeDeps(
      {
        "was=React": {
          maxErgebnisse: 2,
          stellenangebote: [
            {
              refnr: "10000-1-S",
              titel: "React Developer (m/w/d)",
              beruf: "Softwareentwickler/in",
              arbeitgeber: "Pixel Studio GmbH",
              arbeitsort: { plz: "10115", ort: "Berlin", land: "Deutschland", koordinaten: { lat: 52.5, lon: 13.4 } },
              aktuelleVeroeffentlichungsdatum: "2026-10-10",
              externeUrl: "https://pixel.invalid/jobs/react",
            },
            { refnr: "10000-2-S", titel: "Lagerhelfer (m/w/d)", arbeitgeber: "Logistik AG", arbeitsort: { ort: "Hamburg" } },
          ],
        },
        "was=Node.js": { maxErgebnisse: 1, stellenangebote: [{ refnr: "10000-1-S", titel: "React Developer (m/w/d)", arbeitgeber: "Pixel Studio GmbH" }] },
        [`jobdetails/${Buffer.from("10000-1-S").toString("base64")}`]: {
          stellenangebotsTitel: "React Developer (m/w/d)",
          stellenangebotsBeschreibung:
            "<p>We are an English speaking team in Berlin. You will build our product with React, TypeScript and Node.js and you will work remotely if you like. Visa sponsorship is possible for the right person and we help you relocate to the city.</p>",
        },
      },
      seen,
    );
    const out = await fetchBa({ keywords: ["React", "Node.js"], where: "Berlin", radiusKm: 25, days: 14, maxPages: 3, details: 10 }, deps, () => Promise.resolve(new Set()));
    expect(out.ads).toHaveLength(2);
    const react = out.ads.find((a) => a.externalId === "10000-1-S")!;
    expect(react).toMatchObject({
      isDev: true,
      role: "React Developer",
      company: "Pixel Studio GmbH",
      companyKey: "pixel studio",
      city: "Berlin",
      country: "DE",
      url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1-S",
      externalUrl: "https://pixel.invalid/jobs/react",
      stackMatch: true,
    });
    expect(react.flags).toEqual(expect.arrayContaining(["visa", "english_team", "ad_english"]));
    expect(react.postedAt?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(out.ads.find((a) => a.externalId === "10000-2-S")?.isDev).toBe(false);
    expect(seen[0]!.headers["X-API-Key"]).toBe("jobboerse-jobsuche");
    expect(seen[0]!.url).toContain("wo=Berlin");
    expect(seen[0]!.url).toContain("umkreis=25");
    expect(seen[0]!.url).toContain("veroeffentlichtseit=14");
    expect(seen).toHaveLength(3); // two searches (one page each), one advert text
  });

  it("Bundesagentur: when a search path is refused (403), tries the next one and keeps it; says so", async () => {
    const urls: string[] = [];
    const deps: SourceDeps = {
      getJson: (u) => {
        urls.push(u);
        if (u.includes("/pc/v6/jobs")) return Promise.reject(new ApiStatusError(403, 'ba.test answered HTTP 403: "Access denied"'));
        return Promise.resolve({ maxErgebnisse: 1, stellenangebote: [{ referenznummer: "R-1", titel: "Webentwickler (m/w/d)", arbeitgeber: "Web AG" }] });
      },
      sleep: () => Promise.resolve(),
      delayMs: 1000,
      baBase: "https://ba.test",
    };
    const out = await fetchBa({ keywords: ["Web", "React"], radiusKm: 0, days: 7, maxPages: 1, details: 0 }, deps, () => Promise.resolve(new Set()));
    expect(out.ads.map((a) => a.externalId)).toEqual(["R-1"]);
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/pc/v6/jobs", "/pc/v4/app/jobs", "/pc/v4/app/jobs"]);
    expect(out.notes[0]).toMatch(/v4\/app\/jobs used .*Access denied/);

    // Every path refused: one clear error naming all of them.
    const none: SourceDeps = { ...deps, getJson: (u) => Promise.reject(new ApiStatusError(403, `${new URL(u).pathname} answered HTTP 403`)) };
    await expect(fetchBa({ keywords: ["Web"], radiusKm: 0, days: 7, maxPages: 1, details: 0 }, none, () => Promise.resolve(new Set()))).rejects.toThrow(
      /pc\/v4\/jobs answered HTTP 403 \(also tried \/pc\/v6\/jobs.*\/pc\/v4\/app\/jobs/,
    );
  });

  it("finds the advert list under any name (v6 answers differ from the documentation), and stops asking for refused texts", async () => {
    const ad = { refnr: "A-1", titel: "React Developer (m/w/d)", arbeitgeber: "X GmbH", arbeitsorte: [{ plz: 10115, ort: "Berlin" }] };
    expect(findAdArray({ maxErgebnisse: "1", ergebnisliste: [ad], facetten: [{ x: 1 }] })).toMatchObject({ key: "ergebnisliste", items: [ad] });
    expect(findAdArray({ ergebnis: { stellenangebote: [ad] } }).key).toBe("ergebnis.stellenangebote");
    expect(findAdArray({ maxErgebnisse: "0" }).items).toEqual([]);

    let detailCalls = 0;
    const deps: SourceDeps = {
      getJson: (u) => {
        if (u.includes("jobdetails")) {
          detailCalls++;
          return Promise.reject(new ApiStatusError(403, "HTTP 403"));
        }
        return Promise.resolve({ maxErgebnisse: "2", ergebnisliste: [ad, { ...ad, refnr: "A-2" }] });
      },
      sleep: () => Promise.resolve(),
      delayMs: 1000,
    };
    const out = await fetchBa({ keywords: ["React"], radiusKm: 0, days: 7, maxPages: 1, details: 50 }, deps, () => Promise.resolve(new Set()));
    expect(out.ads.map((a) => [a.externalId, a.city, a.postcode, a.company])).toEqual([
      ["A-1", "Berlin", "10115", "X GmbH"],
      ["A-2", "Berlin", "10115", "X GmbH"],
    ]);
    expect(detailCalls).toBe(2); // v4, then v3; then no more texts
    expect(out.notes.join(" ")).toMatch(/Advert texts are not available/);
  });

  it("reads the v6 search fields (firma, stellenlokationen, homeofficemoeglich, externeURL)", () => {
    const ad = baAdvert({
      stellenangebotsart: "ARBEIT",
      stellenangebotsTitel: "Frontend Developer React (m/w/d)",
      hauptberuf: "Softwareentwickler/in",
      alleBerufe: ["Softwareentwickler/in", "Webentwickler/in"],
      firma: "Web Werk GmbH",
      referenznummer: "12345-678-S",
      stellenlokationen: [{ adresse: { plz: "10115", ort: "Berlin", region: "Berlin", land: "Deutschland" }, breite: 52.53, laenge: 13.38 }],
      homeofficemoeglich: true,
      arbeitszeitVollzeit: true,
      veroeffentlichungszeitraum: { von: "2026-10-12" },
      datumErsteVeroeffentlichung: "2026-10-01",
      externeURL: "https://webwerk.invalid/karriere/frontend",
    })!;
    expect(ad).toMatchObject({
      externalId: "12345-678-S",
      title: "Frontend Developer React (m/w/d)",
      company: "Web Werk GmbH",
      location: "10115 Berlin",
      country: "DE",
      lat: 52.53,
      lng: 13.38,
      externalUrl: "https://webwerk.invalid/karriere/frontend",
      isDev: true,
      stackMatch: true,
      tags: ["Softwareentwickler/in", "Webentwickler/in"],
      jobTypes: ["Full time"],
    });
    expect(ad.flags).toContain("remote");
    expect(ad.postedAt?.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(baAdvert({ firma: "X" })).toBeNull();
  });

  it("Arbeitnow: reads pages until the last, marks the visa-sponsorship list, keeps remote from the API", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const ad = (slug: string, title: string, extra: object = {}) => ({
      slug,
      company_name: "Remote Co GmbH",
      title,
      description: "<p>Wir suchen Verstärkung für unser Team.</p>",
      remote: false,
      url: `https://www.arbeitnow.com/jobs/companies/remote-co/${slug}`,
      tags: ["IT"],
      job_types: ["Full Time"],
      location: "München",
      created_at: 1792049481,
      ...extra,
    });
    const deps = fakeDeps(
      {
        "api?page=1&visa_sponsorship=true": { data: [ad("ts-dev-1", "TypeScript Developer")], links: { next: null } },
        "api?page=1": { data: [ad("ts-dev-1", "TypeScript Developer", { remote: true }), ad("sales-2", "Sales Manager")], links: { next: "https://an.test/api?page=2" } },
        "api?page=2": { data: [], links: { next: null } },
      },
      seen,
    );
    const out = await fetchArbeitnow({ maxPages: 5, visaPass: true }, deps);
    expect(out.ads.map((a) => a.externalId).sort()).toEqual(["sales-2", "ts-dev-1"]);
    const ts = out.ads.find((a) => a.externalId === "ts-dev-1")!;
    expect(ts).toMatchObject({ isDev: true, stackMatch: true, city: "München" });
    expect(ts.flags).toEqual(expect.arrayContaining(["remote", "visa"]));
    expect(ts.postedAt?.getTime()).toBe(1792049481000);
    expect(seen.map((s) => s.url)).toEqual(["https://an.test/api?page=1", "https://an.test/api?page=2", "https://an.test/api?page=1&visa_sponsorship=true"]);
  });
});
