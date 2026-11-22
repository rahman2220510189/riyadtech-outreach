import { describe, expect, it } from "vitest";
import {
  classifyEmail,
  decodeCfEmail,
  deobfuscate,
  extractEmails,
  firstNameFor,
  isJunkEmail,
  pickPrimary,
} from "../src/crawler/emails.js";
import { lookupMx } from "../src/crawler/mx.js";
import { checkUrl, isPublicAddress } from "../src/crawler/net.js";
import { classifyUrl, findLinks, sitemapLocs } from "../src/crawler/pages.js";
import { parseRobots } from "../src/crawler/robots.js";
import { cleanCompany, computeScores, detectSignals, loadSignalRules, signalLine } from "../src/crawler/signals.js";
import type { FetchedPage } from "../src/crawler/site.js";
import { renderSpintax } from "../src/crawler/spintax.js";
import { stackWords } from "../src/crawler/analyze.js";
import type { FetchResult } from "../src/crawler/net.js";

describe("SSRF protection", () => {
  it("allows public addresses only", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "151.101.1.69", "2606:4700::6810:85e5"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("rejects non-http URLs, credentials, odd ports and private IP literals", () => {
    expect(() => checkUrl("ftp://x.com/", {})).toThrow(/http/);
    expect(() => checkUrl("file:///etc/passwd", {})).toThrow(/http/);
    expect(() => checkUrl("https://user:pw@x.com/", {})).toThrow(/user name/);
    expect(() => checkUrl("http://x.com:6379/", {})).toThrow(/port/);
    expect(() => checkUrl("http://127.0.0.1/", {})).toThrow(/private/);
    expect(() => checkUrl("http://[::1]/", {})).toThrow(/private/);
    expect(() => checkUrl("http://169.254.169.254/latest/meta-data", {})).toThrow(/private/);
    expect(checkUrl("https://example.org:443/a#b", {}).toString()).toBe("https://example.org/a");
  });
});

describe("robots.txt", () => {
  const res = (status: number, body: string | null): FetchResult => ({
    url: "https://x.com/robots.txt",
    status,
    headers: {},
    contentType: "text/plain",
    body,
    bytes: body?.length ?? 0,
    truncated: false,
    redirects: 0,
    ms: 1,
  });

  it("follows the rules for our bot, crawl-delay and sitemaps", () => {
    const r = parseRobots(
      "https://x.com/robots.txt",
      res(200, "User-agent: *\nDisallow: /private\n\nUser-agent: RiyadTechBot\nDisallow: /admin\nCrawl-delay: 4\n\nSitemap: https://x.com/sm.xml"),
    );
    expect(r.status).toBe("ok");
    expect(r.isAllowed("https://x.com/contact")).toBe(true);
    expect(r.isAllowed("https://x.com/admin/x")).toBe(false);
    expect(r.crawlDelaySeconds).toBe(4);
    expect(r.sitemaps).toEqual(["https://x.com/sm.xml"]);
  });

  it("a block for all bots also blocks us; 4xx = no rules; 5xx or no answer = do not crawl", () => {
    expect(parseRobots("https://x.com/robots.txt", res(200, "User-agent: *\nDisallow: /")).isAllowed("https://x.com/")).toBe(false);
    expect(parseRobots("https://x.com/robots.txt", res(404, "nope")).isAllowed("https://x.com/")).toBe(true);
    expect(parseRobots("https://x.com/robots.txt", res(503, "")).isAllowed("https://x.com/")).toBe(false);
    expect(parseRobots("https://x.com/robots.txt", null).status).toBe("unavailable");
    // An HTML page served as robots.txt has no rules.
    expect(parseRobots("https://x.com/robots.txt", res(200, "<!doctype html><html>Disallow: /</html>")).isAllowed("https://x.com/")).toBe(true);
  });
});

describe("page discovery", () => {
  it("classifies paths and link texts", () => {
    const u = (p: string) => new URL(`https://a.com${p}`);
    expect(classifyUrl(u("/contact-us/"))).toBe("contact");
    expect(classifyUrl(u("/get-in-touch"))).toBe("contact");
    expect(classifyUrl(u("/careers"))).toBe("careers");
    expect(classifyUrl(u("/join-the-team"))).toBe("careers");
    expect(classifyUrl(u("/about-us"))).toBe("about");
    expect(classifyUrl(u("/meet-the-team"))).toBe("team");
    expect(classifyUrl(u("/our-work/"))).toBe("work");
    expect(classifyUrl(u("/case-studies"))).toBe("work");
    expect(classifyUrl(u("/faqs"))).toBe("faq");
    expect(classifyUrl(u("/privacy-policy"))).toBe("legal");
    expect(classifyUrl(u("/karriere/"))).toBe("careers");
    expect(classifyUrl(u("/de/stellenangebote"))).toBe("careers");
    expect(classifyUrl(u("/kontakt"))).toBe("contact");
    expect(classifyUrl(u("/ueber-uns"))).toBe("about");
    expect(classifyUrl(u("/%C3%BCber-uns"))).toBe("about");
    expect(classifyUrl(u("/leistungen"))).toBe("services");
    expect(classifyUrl(u("/referenzen"))).toBe("work");
    expect(classifyUrl(u("/impressum"))).toBe("legal");
    expect(classifyUrl(u("/x"), "Karriere")).toBe("careers");
    expect(classifyUrl(u("/werken-bij"))).toBe("careers");
    expect(classifyUrl(u("/vacatures/"))).toBe("careers");
    expect(classifyUrl(u("/carri%C3%A8res"))).toBe("careers");
    expect(classifyUrl(u("/nous-rejoindre"))).toBe("careers");
    expect(classifyUrl(u("/kariera"))).toBe("careers");
    expect(classifyUrl(u("/over-ons"))).toBe("about");
    expect(classifyUrl(u("/qui-sommes-nous"))).toBe("about");
    expect(classifyUrl(u("/o-nas"))).toBe("about");
    expect(classifyUrl(u("/contactez-nous"))).toBe("contact");
    expect(classifyUrl(u("/zesp%C3%B3%C5%82"))).toBe("team");
    expect(classifyUrl(u("/mentions-legales"))).toBe("legal");
    expect(classifyUrl(u("/x"), "Carrières")).toBe("careers");
    expect(classifyUrl(u("/x"), "Werken bij")).toBe("careers");
    expect(classifyUrl(u("/page-12"), "Contact")).toBe("contact");
    expect(classifyUrl(u("/"))).toBeNull();
    expect(classifyUrl(u("/blog/how-we-work-with-clients-and-other-long-words"), "A long blog post title about things")).toBeNull();
  });

  it("finds same-site links only, the shortest per kind", () => {
    const html = `<a href="/contact">Contact</a><a href="https://www.agency.co.uk/contact/london-office">x</a>
      <a href="https://other.com/careers">Careers</a><a href="mailto:a@b.com">mail</a><a href="/brochure.pdf">About</a>
      <a href="https://jobs.agency.co.uk/">Jobs</a><a href="/about#team">About us</a>`;
    const links = findLinks(html, "https://agency.co.uk/", "agency.co.uk");
    expect(links).toEqual(
      expect.arrayContaining([
        { kind: "contact", url: "https://agency.co.uk/contact" },
        { kind: "about", url: "https://agency.co.uk/about" },
      ]),
    );
    expect(links.find((l) => l.url.includes("other.com"))).toBeUndefined();
    expect(links.find((l) => l.url.endsWith(".pdf"))).toBeUndefined();
  });

  it("reads sitemap locations", () => {
    expect(sitemapLocs("<urlset><url><loc>https://a.com/contact</loc></url><url><loc><![CDATA[https://a.com/x?a=1&amp;b=2]]></loc></url></urlset>")).toEqual({
      urls: ["https://a.com/contact", "https://a.com/x?a=1&b=2"],
      isIndex: false,
    });
    expect(sitemapLocs("<sitemapindex><sitemap><loc>https://a.com/page-sitemap.xml</loc></sitemap></sitemapindex>").isIndex).toBe(true);
  });
});

describe("e-mail extraction", () => {
  it("decodes the usual disguises", () => {
    expect(deobfuscate("hello [at] studio (dot) co (dot) uk")).toBe("hello@studio.co.uk");
    expect(deobfuscate("info(at)smile-dental.ie")).toBe("info@smile-dental.ie");
    expect(decodeCfEmail("543c3138383b142735392438317a373b39")).toBe("hello@sample.com");
    expect(decodeCfEmail("zz")).toBeNull();
  });

  it("finds mailto, Cloudflare, JSON-LD and text addresses, drops junk", () => {
    // Cloudflare: key 0x42 XOR "hi@cf-site.com"
    const cf = "42" + [..."hi@cf-site.com"].map((c) => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, "0")).join("");
    const html = `<html><body>
      <p>Call or <a href="mailto:Hello@Studio.co.uk?subject=Hi">email us</a></p>
      <span class="__cf_email__" data-cfemail="${cf}">[email protected]</span>
      <script type="application/ld+json">{"@type":"Organization","contactPoint":{"email":"mailto:sales@studio.co.uk"}}</script>
      <p>Sarah Jones, Founder - sarah [at] studio [dot] co [dot] uk</p>
      <img src="logo@2x.png"> <p>noreply@studio.co.uk you@example.com 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c@sentry.io</p>
      </body></html>`;
    const text = "Call or email us [email protected] Sarah Jones, Founder - sarah [at] studio [dot] co [dot] uk noreply@studio.co.uk you@example.com";
    const found = extractEmails(html, text, "https://studio.co.uk/contact").map((e) => e.email).sort();
    expect(found).toEqual(["hello@studio.co.uk", "hi@cf-site.com", "sales@studio.co.uk", "sarah@studio.co.uk"]);
  });

  it("knows junk", () => {
    for (const e of ["logo@2x.png", "a@example.com", "x@sentry.io", "no-reply@a.com", "donotreply@a.com", "your@email.com", "user@domain.com"]) {
      expect(isJunkEmail(e), e).toBe(true);
    }
    for (const e of ["info@smile.ie", "jo@agency.co.uk", "smilesdental@gmail.com"]) expect(isJunkEmail(e), e).toBe(false);
  });

  it("classifies generic, named and department addresses, and own vs free mail", () => {
    const c = (email: string, context = "") => classifyEmail({ email, sourceUrl: "u", context }, "studio.co.uk");
    expect(c("info@studio.co.uk")).toMatchObject({ kind: "generic", domainMatch: "own", firstName: null });
    expect(c("hello@mail.studio.co.uk")).toMatchObject({ kind: "generic", domainMatch: "own" });
    expect(c("privacy@studio.co.uk").kind).toBe("role");
    expect(c("careers@studio.co.uk").kind).toBe("role");
    expect(c("bewerbung@studio.co.uk").kind).toBe("role");
    expect(c("kontakt@studio.co.uk").kind).toBe("generic");
    expect(c("recrutement@studio.co.uk").kind).toBe("role");
    expect(c("vacatures@studio.co.uk").kind).toBe("role");
    expect(c("rekrutacja@studio.co.uk").kind).toBe("role");
    expect(c("biuro@studio.co.uk").kind).toBe("generic");
    expect(c("john.smith@studio.co.uk")).toMatchObject({ kind: "named", firstName: "John" });
    expect(c("sjones@studio.co.uk", "Sarah Jones - Director - sjones@studio.co.uk")).toMatchObject({ kind: "named", firstName: "Sarah" });
    expect(c("xk7@studio.co.uk")).toMatchObject({ kind: "named", firstName: null });
    expect(c("studio.bookings@gmail.com").domainMatch).toBe("free");
    expect(c("office@agency-group.com").domainMatch).toBe("other");
    expect(firstNameFor("marketing", "")).toBeNull();
  });

  it("picks the primary address by segment and country rules", () => {
    const mk = (email: string, mxValid: boolean | null = true, context = "") => ({
      ...classifyEmail({ email, sourceUrl: "u", context }, "a.com"),
      mxValid,
    });
    const list = [mk("privacy@a.com"), mk("anna.lee@a.com", true, "Anna Lee, Founder"), mk("hello@a.com"), mk("info@a.com"), mk("a.shop@gmail.com")];
    expect(pickPrimary(list, "B", false)?.email).toBe("hello@a.com");
    expect(pickPrimary([mk("office@a.com"), mk("info@a.com")], "B", false)?.email).toBe("info@a.com");
    expect(pickPrimary(list, "A", false)?.email).toBe("anna.lee@a.com");
    // UK / Ireland: generic only.
    expect(pickPrimary(list, "A", true)?.email).toBe("hello@a.com");
    expect(pickPrimary([mk("anna.lee@a.com")], "A", true)).toBeNull();
    // No MX: held back. Unknown MX (DNS trouble) is still usable.
    expect(pickPrimary([mk("info@a.com", false)], "B", false)).toBeNull();
    expect(pickPrimary([mk("info@a.com", null)], "B", false)?.email).toBe("info@a.com");
    expect(pickPrimary([mk("privacy@a.com")], "B", false)).toBeNull();
  });
});

describe("MX lookup", () => {
  it("answers yes, no (missing domain, null MX) or unknown (DNS trouble)", async () => {
    const err = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));
    expect(await lookupMx("a.com", () => Promise.resolve([{ exchange: "mx2.a.com", priority: 20 }, { exchange: "MX1.a.com", priority: 10 }]))).toEqual({
      hasMx: true,
      hosts: ["mx1.a.com", "mx2.a.com"],
      error: null,
    });
    expect((await lookupMx("a.com", () => Promise.resolve([{ exchange: "", priority: 0 }]))).hasMx).toBe(false);
    expect((await lookupMx("a.com", err("ENOTFOUND"))).hasMx).toBe(false);
    expect((await lookupMx("a.com", err("ENODATA"))).hasMx).toBe(false);
    expect((await lookupMx("a.com", err("ETIMEOUT"))).hasMx).toBeNull();
  });
});

describe("spintax", () => {
  it("is the same for the same seed and fills variables", () => {
    const t = "{Hi|Hello|Hey} {company}{ team|}!";
    const a = renderSpintax(t, { company: "Acme" }, "lead-1");
    expect(renderSpintax(t, { company: "Acme" }, "lead-1")).toBe(a);
    expect(a).toMatch(/^(Hi|Hello|Hey) Acme( team)?!$/);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => renderSpintax(t, { company: "Acme" }, `lead-${i}`)));
    expect(seen.size).toBeGreaterThan(2);
  });

  it("skips options that need a missing variable, and fails when a required one is missing", () => {
    expect(renderSpintax("Seen in {city}.", { city: null }, "x")).toBeNull();
    expect(renderSpintax("{company}'s work{ in {city}|}.", { company: "Acme", city: null }, "x")).toBe("Acme's work.");
    expect(renderSpintax("{a|{b|c}} done", {}, "x")).toMatch(/^(a|b|c) done$/);
  });
});

/* --------------------------------- signals --------------------------------- */

const page = (kind: FetchedPage["kind"], text: string, html = `<html><body>${text}</body></html>`, headers = {}): FetchedPage => ({
  url: `https://a.com/${kind === "home" ? "" : kind}`,
  kind,
  html,
  text,
  headers,
});

describe("signals and scores", () => {
  it("every rule file pattern compiles and every list exists", () => {
    const rules = loadSignalRules();
    expect(rules.rules.length).toBeGreaterThan(15);
    const keys = rules.rules.map((r) => r.key);
    for (const k of ["hiring_dev", "no_ai_offer", "design_led", "small_team", "tech_stack", "case_studies", "no_chat", "has_chat", "booking", "faq", "ads_spend", "multi_location", "after_hours", "quote_requests", "manual_ops", "crm_tools"]) {
      expect(keys).toContain(k);
    }
  });

  it("Segment A: hiring a React developer, design led, no AI offer, small team, JS stack", () => {
    const pages = [
      page(
        "home",
        "We are a creative studio: web design, branding, SEO and social media marketing, content and PPC.",
        `<html><head><script src="/_next/static/chunks/main.js"></script></head><body>We are a creative studio</body></html>`,
      ),
      page("careers", "Join our team! We're hiring a Senior React Developer to work on client sites. Apply now."),
      page("team", "Meet Sarah Jones, Founder. Tom Baker, Designer. Priya Shah, SEO lead. Liam Walsh, Account manager."),
      page("work", "Our case studies"),
    ];
    const s = detectSignals(pages, { segment: "A", locationCount: 1, stackWords: stackWords() });
    const by = Object.fromEntries(s.map((x) => [x.key, x]));
    expect(by.hiring_dev?.value).toBe("Senior React Developer");
    expect(by.hiring_dev?.evidenceUrl).toBe("https://a.com/careers");
    expect(by.hiring_dev?.snippet).toMatch(/Senior React Developer/);
    expect(by.stack_match?.value).toBe("Senior React Developer");
    expect(by.no_ai_offer).toBeDefined();
    expect(by.design_led).toBeDefined();
    expect(by.small_team?.value).toBe("4");
    expect(by.case_studies).toBeDefined();
    expect(by.js_stack?.value).toBe("Next.js");
    expect(by.no_chat).toBeUndefined(); // Segment B only

    const scores = computeScores(s, { segment: "A", categoryValue: 5, readable: true, agentThreshold: 20 });
    expect(scores.need).toBe(85); // 40 + 10 + 15 + 20
    expect(scores.fit).toBe(80); // 50 + 10 + 10 + 10 + 0
    expect(scores.lead).toBe(68);
    expect(scores.bestOffer).toBeNull();
    const line = signalLine(s, { id: 7n, segment: "A", company: "Pixel Studio Ltd", city: "Manchester", categoryLabel: "Web design studio", bestOffer: null });
    expect(line).toMatch(/Pixel Studio is (hiring|looking for) a Senior React Developer/);
    expect(line).toBe(signalLine(s, { id: 7n, segment: "A", company: "Pixel Studio Ltd", city: "Manchester", categoryLabel: "Web design studio", bestOffer: null }));
  });

  it("a WordPress developer role is a need but not a stack match; an AI offer means no no_ai_offer", () => {
    const pages = [
      page("home", "We build websites and AI chatbots for our clients."),
      page("careers", "We're hiring: WordPress Developer (PHP)."),
    ];
    const keys = detectSignals(pages, { segment: "A", locationCount: 1, stackWords: stackWords() }).map((s) => s.key);
    expect(keys).toContain("hiring_dev");
    expect(keys).not.toContain("stack_match");
    expect(keys).not.toContain("no_ai_offer");
  });

  it("a staff bio is not a job advert, and the hiring phrase must be near the role outside careers pages", () => {
    const ctx = { segment: "A" as const, locationCount: 1, stackWords: stackWords() };
    const filler = " Our clients trust us with their IT.".repeat(30);
    // bcn.co.uk/our-team: a bio, plus a "Join our team" link far away in the footer
    const bio = [page("team", `Tom started his 20-year career as a software engineer and prior to BCN was Head of Delivery.${filler} Join our team`)];
    expect(detectSignals(bio, ctx).map((s) => s.key)).not.toContain("hiring_dev");
    const far = [page("about", `Our founder writes about the work of a React developer.${filler} We're hiring!`)];
    expect(detectSignals(far, ctx).map((s) => s.key)).not.toContain("hiring_dev");
    const home = [page("home", `${filler} We're hiring: Senior React Developer (remote). Apply now.`)];
    expect(detectSignals(home, ctx).find((s) => s.key === "hiring_dev")?.value).toBe("Senior React Developer");
    const careers = [page("careers", "Anna worked as a software engineer for ten years. Open roles: in your role as a Node.js Developer you build APIs.")];
    expect(detectSignals(careers, ctx).find((s) => s.key === "hiring_dev")?.value).toBe("Node.js Developer");
    const de = [page("team", `Max arbeitete zuvor als Softwareentwickler bei SAP.${filler} Karriere`)];
    expect(detectSignals(de, ctx).map((s) => s.key)).not.toContain("hiring_dev");
  });

  it("a blog post about hiring is not a job advert", () => {
    const pages = [page("home", "Blog: how to find a good React developer for your startup.")];
    expect(detectSignals(pages, { segment: "A", locationCount: 1, stackWords: stackWords() }).map((s) => s.key)).not.toContain("hiring_dev");
  });

  it("Segment B: no chat, booking, FAQ, opening hours, ads; chatbot offer", () => {
    const pages = [
      page(
        "home",
        "Welcome to Smile Dental. Book an appointment online. Opening hours: Monday - Friday 9am - 5pm.",
        `<html><body><script>gtag('config', 'AW-123456789');</script>Welcome</body></html>`,
      ),
      page("faq", "Frequently asked questions"),
    ];
    const s = detectSignals(pages, { segment: "B", locationCount: 3, stackWords: stackWords() });
    const keys = s.map((x) => x.key).sort();
    expect(keys).toEqual(["ads_spend", "after_hours", "booking", "faq", "multi_location", "no_chat"]);
    expect(s.find((x) => x.key === "ads_spend")?.value).toBe("Google Ads");
    expect(s.find((x) => x.key === "multi_location")?.snippet).toMatch(/3 places/);
    const scores = computeScores(s, { segment: "B", categoryValue: 5, readable: true, agentThreshold: 20 });
    expect(scores).toEqual({ fit: 80, need: 60, lead: 48, bestOffer: "chatbot" });
    const line = signalLine(s, { id: 3n, segment: "B", company: "Smile Dental", city: "Dublin", categoryLabel: "Dentist", bestOffer: "chatbot" });
    expect(line).toMatch(/Smile Dental/);
    expect(line).not.toMatch(/quote/);
  });

  it("Segment B: a chat widget, quote requests and a CRM make it an agent lead with an agent sentence", () => {
    const pages = [
      page(
        "home",
        "Get a free quote today. Track your order online.",
        `<html><body><script src="https://embed.tawk.to/abc/default"></script><script src="//js.hs-scripts.com/123.js"></script>Get a free quote</body></html>`,
      ),
    ];
    const s = detectSignals(pages, { segment: "B", locationCount: 1, stackWords: stackWords() });
    const keys = s.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["has_chat", "quote_requests", "manual_ops", "crm_tools"]));
    expect(keys).not.toContain("no_chat");
    expect(s.find((x) => x.key === "has_chat")?.value).toBe("tawk.to");
    expect(s.find((x) => x.key === "crm_tools")?.value).toBe("HubSpot");
    const scores = computeScores(s, { segment: "B", categoryValue: 3, readable: true, agentThreshold: 20 });
    expect(scores.bestOffer).toBe("agent");
    const line = signalLine(s, { id: 9n, segment: "B", company: "Build Co", city: null, categoryLabel: "Car dealer", bestOffer: "agent" });
    expect(line).toMatch(/quote|forms|HubSpot/);
  });

  it("Segment B: a developer job advert is found (for job applications) but adds no score", () => {
    const pages = [page("home", "Welcome to Harbour Hotel."), page("careers", "Careers: we're hiring a Full-stack Developer (remote).")];
    const s = detectSignals(pages, { segment: "B", locationCount: 1, stackWords: stackWords() });
    const job = s.find((x) => x.key === "job_opening");
    expect(job?.value).toBe("Full-stack Developer");
    expect(job?.weight).toBe(0);
    expect(s.map((x) => x.key)).not.toContain("hiring_dev");
    expect(computeScores(s, { segment: "B", categoryValue: 4, readable: true, agentThreshold: 20 }).need).toBe(30);
    expect(signalLine(s, { id: 5n, segment: "B", company: "Harbour Hotel", city: "Cork", categoryLabel: "Hotel", bestOffer: "chatbot" })).not.toMatch(
      /hiring|Developer/,
    );
  });

  it("German job adverts: role, remote, English team, fluent German; a German agency describing itself is not hiring", () => {
    const careers = page(
      "careers",
      "Karriere. Wir suchen dich! Fullstack-Entwickler (m/w/d) in Berlin. Home Office möglich, Teamsprache ist Englisch. Jetzt bewerben.",
    );
    const s = detectSignals([page("home", "Willkommen"), careers], { segment: "A", locationCount: 1, stackWords: stackWords() });
    const by = Object.fromEntries(s.map((x) => [x.key, x]));
    expect(by.hiring_dev?.value).toBe("Fullstack-Entwickler (m/w/d)");
    expect(by.stack_match).toBeDefined();
    expect(by.job_remote).toBeDefined();
    expect(by.job_english).toBeDefined();
    expect(by.job_local_lang).toBeUndefined();
    const de = detectSignals(
      [page("careers", "Stellenangebote: Softwareentwickler (w/m/d). Sehr gute Deutschkenntnisse sind Voraussetzung.")],
      { segment: "B", locationCount: 1, stackWords: stackWords() },
    );
    expect(de.find((x) => x.key === "job_opening")?.value).toBe("Softwareentwickler (w/m/d)");
    expect(de.map((x) => x.key)).toContain("job_local_lang");
    // Home page with a "Karriere" menu item and "Webentwickler" in the agency's own description: no job advert.
    const self = detectSignals([page("home", "Karriere Kontakt. Wir sind Webentwickler und Designer aus Hamburg.")], {
      segment: "A",
      locationCount: 1,
      stackWords: stackWords(),
    });
    expect(self.map((x) => x.key)).not.toContain("hiring_dev");
  });

  it("Dutch, French and Polish job adverts and flags", () => {
    const run = (text: string) =>
      Object.fromEntries(
        detectSignals([page("careers", text)], { segment: "B", locationCount: 1, stackWords: stackWords() }).map((x) => [x.key, x.value]),
      );
    const nl = run("Vacatures: wij zoeken een Full-stack ontwikkelaar (m/v/x). Thuiswerken mogelijk, de voertaal is Engels. Kennismigrant regeling.");
    expect(nl.job_opening).toBe("Full-stack ontwikkelaar");
    expect(Object.keys(nl)).toEqual(expect.arrayContaining(["job_remote", "job_english", "job_visa"]));
    const fr = run("Nous recrutons : Développeur Full-Stack (H/F). Télétravail partiel. Français courant exigé.");
    expect(fr.job_opening).toBe("Développeur Full-Stack");
    expect(Object.keys(fr)).toEqual(expect.arrayContaining(["job_remote", "job_local_lang"]));
    const pl = run("Dołącz do nas! Szukamy: Programista Python. Praca zdalna, pomoc w relokacji.");
    expect(pl.job_opening).toBe("Programista Python");
    expect(Object.keys(pl)).toEqual(expect.arrayContaining(["job_remote", "job_visa"]));
  });

  it("weights from Settings replace the file's weights; unreadable sites only get a fit score", () => {
    const pages = [page("home", "Hello")];
    const s = detectSignals(pages, { segment: "B", locationCount: 1, stackWords: stackWords(), weights: { no_chat: 50 } });
    expect(s.find((x) => x.key === "no_chat")?.weight).toBe(50);
    expect(computeScores([], { segment: "B", categoryValue: 4, readable: false, agentThreshold: 20 })).toEqual({ fit: 40, need: null, lead: null, bestOffer: null });
  });

  it("falls back to a neutral sentence and cleans company names", () => {
    expect(cleanCompany("Smith & Co Accountants Ltd")).toBe("Smith & Co Accountants");
    expect(cleanCompany("Harbour Hotels Pty Ltd")).toBe("Harbour Hotels");
    const line = signalLine([], { id: 1n, segment: "B", company: "Harbour Hotel Limited", city: "Brisbane", categoryLabel: "Hotel and boutique hotel", bestOffer: "chatbot" });
    expect(line).toMatch(/Harbour Hotel/);
    expect(line).not.toMatch(/Limited|\{/);
    const noCity = signalLine([], { id: 1n, segment: "A", company: "X", city: null, categoryLabel: "Web design studio", bestOffer: null });
    expect(noCity).not.toMatch(/\{|null|undefined/);
  });
});
