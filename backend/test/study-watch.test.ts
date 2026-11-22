import { describe, expect, it } from "vitest";
import { countryName, parseHipo, parseRorPage, parseWikidata, siteDomain, skipReason, wikidataQuery } from "../src/study/directory.js";
import { extractFacts, factSignature, findDates, mergeFacts } from "../src/study/extract.js";
import { candidateLinks, htmlText } from "../src/study/reader.js";

const today = new Date("2026-11-13T00:00:00Z");

describe("study directory: sources", () => {
  it("normalises website domains and refuses non-sites", () => {
    expect(siteDomain("https://www.u-szeged.hu/en/")).toBe("u-szeged.hu");
    expect(siteDomain("unideb.hu")).toBe("unideb.hu");
    expect(siteDomain("http://WWW2.Example.AC.UK")).toBe("example.ac.uk");
    expect(siteDomain("https://www.facebook.com/someuni")).toBeNull();
    expect(siteDomain("ftp://files.example.com")).toBeNull();
    expect(siteDomain("not a url")).toBeNull();
  });

  it("GitHub list: Europe only (Germany included), first web page", () => {
    const rows = parseHipo([
      { name: "Universität A", alpha_two_code: "DE", web_pages: ["https://www.uni-a.de/"], domains: ["uni-a.de"] },
      { name: "Dhaka College", alpha_two_code: "BD", web_pages: ["https://dc.edu.bd"], domains: ["dc.edu.bd"] },
      { name: "No Page Uni", alpha_two_code: "PL", web_pages: [], domains: ["npu.pl"] },
      { name: 42, alpha_two_code: "PL" },
    ]);
    expect(rows.map((r) => [r.name, r.countryCode, r.domain, r.website])).toEqual([
      ["Universität A", "DE", "uni-a.de", "https://www.uni-a.de/"],
      ["No Page Uni", "PL", "npu.pl", "https://npu.pl/"],
    ]);
    expect(() => parseHipo({})).toThrow(/array/);
  });

  it("ROR v2: display name, website, country; inactive and site-less records left out", () => {
    const r = parseRorPage({
      number_of_results: 3,
      items: [
        { id: "https://ror.org/1", status: "active", names: [{ value: "Debreceni Egyetem", types: ["label"], lang: "hu" }, { value: "University of Debrecen", types: ["ror_display", "label"] }], links: [{ type: "wikipedia", value: "https://en.wikipedia.org/wiki/X" }, { type: "website", value: "https://unideb.hu" }], locations: [{ geonames_details: { country_code: "HU" } }] },
        { id: "https://ror.org/2", status: "withdrawn", names: [{ value: "Old", types: ["ror_display"] }], links: [{ type: "website", value: "https://old.hu" }], locations: [{ geonames_details: { country_code: "HU" } }] },
        { id: "https://ror.org/3", status: "active", names: [{ value: "No Site", types: ["ror_display"] }], links: [], locations: [{ geonames_details: { country_code: "HU" } }] },
      ],
    });
    expect(r).toMatchObject({ total: 3, count: 3 });
    expect(r.entries).toEqual([{ name: "University of Debrecen", countryCode: "HU", website: "https://unideb.hu/", domain: "unideb.hu", source: "ror", rorId: "https://ror.org/1" }]);
  });

  it("Wikidata: SPARQL results; unlabelled items skipped; the query asks by ISO code", () => {
    expect(wikidataQuery("PL")).toContain('wdt:P297 "PL"');
    const r = parseWikidata(
      { results: { bindings: [{ item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Jagiellonian University" }, website: { value: "https://www.uj.edu.pl/" } }, { item: { value: "x/Q2" }, itemLabel: { value: "Q2" }, website: { value: "https://q2.pl" } }] } },
      "PL",
    );
    expect(r).toEqual([{ name: "Jagiellonian University", countryCode: "PL", website: "https://www.uj.edu.pl/", domain: "uj.edu.pl", source: "wikidata", wikidataId: "Q1" }]);
  });

  it("South Korea and Malaysia are in the default countries; others only when chosen", () => {
    const rows = parseHipo([
      { name: "Korea University", alpha_two_code: "KR", web_pages: ["https://www.korea.ac.kr/"], domains: ["korea.ac.kr"] },
      { name: "Universiti Malaya", alpha_two_code: "MY", web_pages: ["https://www.um.edu.my/"], domains: ["um.edu.my"] },
      { name: "Brazil Uni", alpha_two_code: "BR", web_pages: ["https://br.example.br/"], domains: ["br.example.br"] },
    ]);
    expect(rows.map((r) => r.countryCode)).toEqual(["KR", "MY"]);
    expect(countryName("KR")).toBe("South Korea");
    expect(parseHipo([{ name: "Brazil Uni", alpha_two_code: "BR", web_pages: ["https://br.example.br/"], domains: ["br.example.br"] }], new Set(["BR"])).map((r) => r.countryCode)).toEqual(["BR"]);
  });

  it("country names match the programme names; northern Cyprus is flagged", () => {
    expect([countryName("CZ"), countryName("TR"), countryName("DE"), countryName("GB")]).toEqual(["Czech Republic", "Türkiye", "Germany", "United Kingdom"]);
    expect(skipReason({ countryCode: "CY", domain: "neu.edu.tr" })).toMatch(/Northern Cyprus/);
    expect(skipReason({ countryCode: "CY", domain: "ucy.ac.cy" })).toBeNull();
  });
});

describe("study pages: what is read from the text", () => {
  it("dates in common European and English forms", () => {
    const d = findDates("by 15 January 2027, January 31st, 2027, 2027-02-28, 01.03.2027, 15/04/2027, 31.02.2027 and 3 Smarch 2027").map((x) => x.date);
    expect(d).toEqual(["2027-01-15", "2027-01-31", "2027-02-28", "2027-03-01", "2027-04-15"]);
  });

  it("IELTS, English-medium sentences, deadlines and admission addresses, each with its sentence", () => {
    const f = extractFacts(
      `Admission\nMinimum IELTS score: 6.5 (no band below 5.5). Other tests accepted.\nApplicants who completed their bachelor's degree taught in English can be exempted from the English language test.\nApplication deadline for international applicants: 1 March 2027.\nThe semester starts on 1 September 2027.\nAll programmes are taught in English. Write to international.admissions@uni.example or to the rector@uni.example.`,
      today,
    );
    expect(f.ielts).toEqual([{ score: 6.5, snippet: "Minimum IELTS score: 6.5 (no band below 5.5)." }]);
    expect(f.moi[0]).toMatch(/^Applicants who completed their bachelor's degree taught in English/);
    expect(f.deadlines).toEqual([{ date: "2027-03-01", label: "Application deadline for international applicants", snippet: "Application deadline for international applicants: 1 March 2027." }]);
    expect(f.emails).toEqual(["international.admissions@uni.example"]);
    expect(f.englishTaught).toBe(true);
  });

  it("ignores past dates, far-away dates, dates without an application word, and years after IELTS", () => {
    const f = extractFacts("IELTS 2024 results were published on 3 May 2024. The application deadline was 15 January 2025. Founded on 1 June 1950. Our open day: 5 December 2026. Apply by 1 January 2031.", today);
    expect(f.ielts).toEqual([]);
    expect(f.deadlines).toEqual([]);
  });

  it("signatures change only when the facts change, not with other text", () => {
    const a = extractFacts("Some news today. IELTS 6.0 needed. Application deadline: 15 January 2027.", today);
    const b = extractFacts("Other news this week! IELTS 6.0 needed. Application deadline: 15 January 2027.", today);
    const c = extractFacts("IELTS 6.0 needed. Application deadline: 20 January 2027.", today);
    expect(factSignature(a)).toBe(factSignature(b));
    expect(factSignature(a)).not.toBe(factSignature(c));
    expect(mergeFacts([a, c]).deadlines.map((d) => d.date)).toEqual(["2027-01-15", "2027-01-20"]);
  });

  it("application links: \"Apply now\" and application portals, not jobs or PDFs", async () => {
    const { applyLinks } = await import("../src/study/reader.js");
    const html = `<body>
      <a href="/en/news">News</a><a href="/careers/apply">Apply</a><a href="/files/form.pdf">Apply online</a>
      <a href="https://uni.dreamapply.com/">Application portal</a><a href="/en/admission/apply-now">Apply now</a>
      <a href="https://www.facebook.com/uni">Apply</a></body>`;
    expect(applyLinks(html, "https://www.uni.example/en/admission")).toEqual(["https://uni.dreamapply.com/", "https://www.uni.example/en/admission/apply-now"]);
  });

  it("links: the English version and admission pages first; news and files left out", () => {
    const html = `<html><head><link rel="alternate" hreflang="en" href="/en/"></head><body>
      <a href="/hirek/2026">Hírek</a><a href="/en/news/x">News</a><a href="/files/guide.pdf">Guide</a>
      <a href="/en/admission/entry-requirements">Entry requirements</a><a href="/en/apply">Apply now</a>
      <a href="https://other.example/admission">Other site</a><a href="/en/english-language-requirements">English language requirements</a></body></html>`;
    const links = candidateLinks(html, "https://www.uni.example/", "uni.example").map((l) => new URL(l.url).pathname);
    expect(links[0]).toBe("/en/");
    expect(links).toContain("/en/english-language-requirements");
    expect(links).toContain("/en/admission/entry-requirements");
    expect(links.some((l) => l.includes("news") || l.endsWith(".pdf") || l.includes("hirek"))).toBe(false);
    expect(htmlText("<html><body><nav>Menu</nav><p>One.</p><p>Two</p><script>x()</script></body></html>")).toBe("One.\nTwo");
  });
});

describe("study directory: a source that is down", () => {
  it("stops after three failed countries instead of trying all of Europe", async () => {
    const { fetchDirectory } = await import("../src/study/sources.js");
    let calls = 0;
    const r = await fetchDirectory("wikidata", {
      getJson: () => {
        calls++;
        return Promise.reject(new Error("Domain not found (ENOTFOUND)"));
      },
      sleep: () => Promise.resolve(),
      hipoUrl: "",
      rorBase: "http://ror",
      wikidataBase: "http://wd",
    });
    expect(calls).toBe(3);
    expect(r.entries).toEqual([]);
    expect(r.problems.at(-1)).toMatch(/stopped/);
  });
});

describe("study: AI scholarship search (parsing and checks)", () => {
  it("reads the answer lines, drops aggregators, citation marks and duplicates", async () => {
    const { parseCandidates } = await import("../src/study/discover.js");
    const list = parseCandidates(`Here you go:
1. **Global Korea Scholarship (GKS)** | https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do【3†source】 | 2027-02-24 | none | Full tuition, monthly allowance, flight
- KAIST International Scholarship | https://admission.kaist.ac.kr/intl-graduate | unknown | test | Tuition and stipend
- Some list | https://www.scholarshipsads.com/korea | 2027-01-01 | moi | blog
- Global Korea Scholarship (GKS) | https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do | 2027-02-24 | none | duplicate
NAME | OFFICIAL_URL | DEADLINE | ENGLISH | FUNDING`);
    expect(list.map((c) => [c.name, c.deadline, c.english])).toEqual([
      ["Global Korea Scholarship (GKS)", "2027-02-24", "none"],
      ["KAIST International Scholarship", null, "test"],
    ]);
    expect(list[0]!.url).toBe("https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do");
  });

  it("home pages are not a scholarship's own page; look-alike dashes in links are repaired", async () => {
    const { isHomePage, parseCandidates } = await import("../src/study/discover.js");
    expect(["https://www.postech.ac.kr/eng/", "https://www.studyinkorea.go.kr", "https://uni.example/en/index.html"].map(isHomePage)).toEqual([true, true, true]);
    expect(isHomePage("https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do")).toBe(false);
    expect(parseCandidates("KAIST Graduate Scholarship | https://www.kaist.ac.kr/en/academics/graduate\u2011school | unknown | test | Tuition")[0]!.url).toBe(
      "https://www.kaist.ac.kr/en/academics/graduate-school",
    );
  });

  it("a page passes only when it talks about a scholarship with that name", async () => {
    const { pageMatches } = await import("../src/study/discover.js");
    expect(pageMatches("Global Korea Scholarship (GKS)", "The Global Korea Scholarship invites graduate students. Scholarship benefits: tuition.").ok).toBe(true);
    expect(pageMatches("Global Korea Scholarship (GKS)", "Welcome to our campus news page about sports.").ok).toBe(false);
    expect(pageMatches("Stipendium Hungaricum", "Erasmus scholarship information for exchange students.").ok).toBe(false);
  });

  it("the chosen countries take turns, a few a day", async () => {
    const { aiCountriesFor } = await import("../src/study/watch.js");
    const { defaultSettings } = await import("../src/settings/definitions.js");
    const s = defaultSettings();
    const set = { ...s, study: { ...s.study, countries: ["AT", "DE", "HU", "KR", "MY"], aiCountriesPerDay: 2 } };
    const day = (n: number) => new Date(n * 86_400_000 + 3_600_000);
    expect([aiCountriesFor(set, day(0)), aiCountriesFor(set, day(1)), aiCountriesFor(set, day(2))]).toEqual([
      ["AT", "DE"],
      ["HU", "KR"],
      ["MY", "AT"],
    ]);
  });
});

describe("study: official catalogues", () => {
  it("Erasmus Mundus page: programme titles with their own websites; site links, pagination and EU links left out", async () => {
    const { parseErasmusPage, matchesSubjects } = await import("../src/study/catalogues.js");
    const html = `<html><body><header><a href="https://www.eacea.ec.europa.eu/">European Education and Culture Executive Agency</a></header>
      <main><a href="https://www.quanteem.eu/">Quantum Technologies and Engineering Erasmus Mundus Master Plus</a>
      <a href="https://microscom.eu/">Erasmus Mundus Joint Master Degree in Advanced Microscopy with Artificial Intelligence</a>
      <a href="https://erasmus-plus.ec.europa.eu/projects/eplus-project-details/#project/1">Project overview</a>
      <a href="?page=1">Go to next page of results</a></main><footer><a href="https://twitter.com/eacea">Follow us on Twitter now</a></footer></body></html>`;
    const list = parseErasmusPage(html, "https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en?page=0");
    expect(list.map((e) => e.website)).toEqual(["https://www.quanteem.eu/", "https://microscom.eu/"]);
    expect(matchesSubjects("Joint Master in Marine Biological Resources", ["Computer Science"])).toBe(false);
    expect(matchesSubjects("Erasmus Mundus Joint Master in Cybersecurity", ["Computer Science"])).toBe(true);
    expect(matchesSubjects("Master in Sustainable Tourism", ["Tourism Management"])).toBe(true);
  });
});
