/**
 * The crawler against fake websites on a local server (no internet): robots.txt,
 * polite pauses, bot blocks, redirects, SSRF, size limits, sitemap and guessed pages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectEmails, stackWords } from "../src/crawler/analyze.js";
import { detectSignals } from "../src/crawler/signals.js";
import { BOT_USER_AGENT } from "../src/crawler/net.js";
import { CrawlInterrupted, type CrawlSettings, crawlSite } from "../src/crawler/site.js";
import { failFlakyDns, fakeResolve, type SiteServer, startSiteServer } from "./helpers/site-server.js";

const SETTINGS: CrawlSettings = {
  maxPagesPerDomain: 8,
  minDelayMs: 1500,
  timeoutMs: 3000,
  maxBytes: 200_000,
  maxRedirects: 3,
  maxCrawlDelaySeconds: 30,
  siteTimeLimitMs: 60_000,
};

const AGENCY_HOME = `<!doctype html><html><head><title>Pixel Studio</title></head><body>
  <nav><a href="/about-us">About us</a><a href="/services">Services</a><a href="/our-work">Work</a>
  <a href="/team">Team</a><a href="/careers">Careers</a><a href="/contact">Contact</a>
  <a href="https://twitter.com/pixel">Twitter</a><a href="/blog/how-we-work-with-clients-in-2026">Blog</a></nav>
  <h1>Web design, branding and SEO for growing brands</h1></body></html>`;

describe("crawlSite (fake websites)", () => {
  let srv: SiteServer;
  const sleeps: number[] = [];
  const deps = () => ({
    feedUrlFor: ({ provider, slug }: { provider: string; slug: string }) =>
      provider === "personio"
        ? { feedUrl: `${srv.origin(`${slug}.jobs.personio.de`)}/xml?language=en`, boardUrl: `${srv.origin(`${slug}.jobs.personio.de`)}/` }
        : { feedUrl: "http://unused.invalid/", boardUrl: "http://unused.invalid/" },
    net: { resolve: fakeResolve, allowAddresses: ["127.0.0.1"] },
    platforms: ["facebook.com", "instagram.com"],
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const site = (host: string, segment: "A" | "B" = "A") => ({ website: `${srv.origin(host)}/some/deep/link`, domain: host, segment });

  beforeAll(async () => {
    srv = await startSiteServer({
      "pixel.test": {
        "/robots.txt": { body: "User-agent: *\nDisallow: /wp-admin/\n", type: "text/plain" },
        "/": AGENCY_HOME,
        "/about-us": "<html><body>We are a small studio in Manchester.</body></html>",
        "/services": "<html><body>Web design, branding, SEO, social media, content and PPC.</body></html>",
        "/our-work": "<html><body>Case studies</body></html>",
        "/team": "<html><body>Sarah Jones - Founder. Tom Baker - Designer.</body></html>",
        "/careers": { body: "<html><body>We're hiring a Senior React Developer. Apply now.</body></html>", gzip: true },
        "/contact": `<html><body><a href="mailto:hello@pixel.test">hello@pixel.test</a>
          <p>Sarah Jones, Founder: sarah [at] pixel [dot] test</p></body></html>`,
      },
      "blocked-robots.test": {
        "/robots.txt": { body: "User-agent: RiyadTechBot\nDisallow: /\n", type: "text/plain" },
        "/": AGENCY_HOME,
      },
      "robots-down.test": { "/robots.txt": { status: 503, body: "" }, "/": AGENCY_HOME },
      "slow.test": { "/robots.txt": { body: "User-agent: *\nCrawl-delay: 5\n", type: "text/plain" }, "/": AGENCY_HOME, "/contact": "<html><body>x</body></html>" },
      "very-slow.test": { "/robots.txt": { body: "User-agent: *\nCrawl-delay: 120\n", type: "text/plain" }, "/": AGENCY_HOME },
      "forbidden.test": { "/": { status: 403, body: "Forbidden" } },
      "busy.test": { "/robots.txt": { status: 429, body: "" } },
      "cf.test": { "/": { status: 503, body: "Just a moment...", headers: { server: "cloudflare", "cf-mitigated": "challenge" } } },
      "partway.test": {
        "/": AGENCY_HOME,
        "/about-us": "<html><body>About <a href='mailto:info@partway.test'>info@partway.test</a></body></html>",
        "/services": { status: 403, body: "no" },
      },
      "to-metadata.test": { "/": { location: "http://metadata.test/latest/meta-data" } },
      "loop.test": { "/": { location: "/a" }, "/a": { location: "/b" }, "/b": { location: "/c" }, "/c": { location: "/d" }, "/d": "<html>end</html>" },
      "huge.test": { "/": `<html><body>${"x".repeat(400_000)}</body></html>` },
      "pdf.test": { "/": { body: "%PDF-1.4", type: "application/pdf" } },
      "to-facebook.test": { "/": { location: "" } },
      "facebook.com": { "/pixelpage": "<html>fb</html>" },
      "sitemap.test": {
        "/robots.txt": { body: "Sitemap: http://sitemap.test:PORT/sitemap_index.xml", type: "text/plain" },
        "/": "<html><body><a href='/services'>Services</a></body></html>",
        "/sitemap_index.xml": { type: "application/xml", body: "<sitemapindex><sitemap><loc>http://sitemap.test:PORT/page-sitemap.xml</loc></sitemap></sitemapindex>" },
        "/page-sitemap.xml": { type: "application/xml", body: "<urlset><url><loc>http://sitemap.test:PORT/get-in-touch/</loc></url></urlset>" },
        "/get-in-touch/": "<html><body>Write to studio@sitemap.test</body></html>",
        "/services": "<html><body>Services</body></html>",
      },
      "ats-agency.test": {
        "/": '<!doctype html><html lang="de"><body><a href="/karriere">Karriere</a><a href="/kontakt">Kontakt</a></body></html>',
        "/karriere": '<html><body><div id="personio"></div><script src="https://ats-agency.jobs.personio.de/embed.js"></script></body></html>',
        "/kontakt": "<html><body>info@ats-agency.test</body></html>",
      },
      "ats-agency.jobs.personio.de": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/xml": {
          type: "text/xml",
          body: `<workzag-jobs><position><id>7</id><office>Berlin</office><name>Fullstack Developer (m/w/d)</name>
            <jobDescriptions><jobDescription><value><![CDATA[<p>Company language is English. Remote work possible.</p>]]></value></jobDescription></jobDescriptions></position>
            <position><id>8</id><office>Berlin</office><name>Buchhaltung (m/w/d)</name></position></workzag-jobs>`,
        },
      },
      "dutch.test": {
        "/": '<!doctype html><html lang="nl"><body>Welkom</body></html>',
        "/vacatures": "<html><body>Vacatures</body></html>",
        "/contact": "<html><body>info@dutch.test</body></html>",
      },
      "flaky.test": { "/": "<html><body>hello@flaky.test</body></html>" },
      "guess.test": { "/": "<html><body>Welcome</body></html>", "/contact-us": "<html><body>info@guess.test</body></html>" },
      "www.moved.test": { "/robots.txt": { body: "User-agent: *\nDisallow: /secret\n", type: "text/plain" }, "/": "<html><body><a href='/secret'>Contact</a></body></html>" },
      "moved.test": { "/": { location: "http://www.moved.test:PORT/" } },
      "private-link.test": { "/": "<html><body><a href='http://intranet.test/contact'>Contact</a></body></html>" },
    });
    // Fill in the server's port where the fake pages need absolute URLs.
    for (const pages of Object.values(srv.sites)) {
      for (const [path, a] of Object.entries(pages)) {
        if (typeof a === "object") {
          if (typeof a.body === "string") a.body = a.body.replaceAll("PORT", String(srv.port));
          if (a.location) a.location = a.location.replaceAll("PORT", String(srv.port));
        }
        pages[path] = a;
      }
    }
    srv.sites["to-facebook.test"]!["/"] = { location: `${srv.origin("facebook.com")}/pixelpage` };
    srv.sites["moved.test"]!["/"] = { location: `${srv.origin("www.moved.test")}/` };
  });

  afterAll(async () => {
    await srv.close();
  });

  it("reads robots.txt first, then the home page and the useful pages, politely, as RiyadTechBot", async () => {
    sleeps.length = 0;
    srv.requests.length = 0;
    const o = await crawlSite(site("pixel.test"), SETTINGS, deps());
    expect(o.status).toBe("ok");
    const paths = srv.requests.filter((r) => r.host === "pixel.test").map((r) => r.path);
    expect(paths[0]).toBe("/robots.txt");
    expect(paths[1]).toBe("/"); // the root, not the deep link
    expect(paths).toEqual(expect.arrayContaining(["/contact", "/careers", "/about-us", "/team", "/services", "/our-work"]));
    expect(paths).not.toContain("/blog/how-we-work-with-clients-in-2026");
    expect(paths.length).toBeLessThanOrEqual(1 + SETTINGS.maxPagesPerDomain);
    expect(new Set(srv.requests.map((r) => r.ua))).toEqual(new Set([BOT_USER_AGENT]));
    // Every request after the first waited (the fake sleep got the remaining part of 1.5 s).
    expect(sleeps.length).toBe(paths.length - 1);
    expect(sleeps.every((ms) => ms > 1000 && ms <= 1500)).toBe(true);
    expect(o.fetched.find((p) => p.kind === "careers")?.text).toMatch(/Senior React Developer/); // gzip decoded
    const emails = collectEmails(o, "pixel.test").map((e) => `${e.email} ${e.kind} ${e.firstName ?? "-"}`);
    expect(emails.sort()).toEqual(["hello@pixel.test generic -", "sarah@pixel.test named Sarah"]);
    expect(o.robots.status).toBe("ok");
  });

  it("stops when robots.txt says no, is unavailable, or asks for a very long delay", async () => {
    srv.requests.length = 0;
    const blocked = await crawlSite(site("blocked-robots.test"), SETTINGS, deps());
    expect(blocked.status).toBe("robots_blocked");
    expect(srv.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
    expect((await crawlSite(site("robots-down.test"), SETTINGS, deps())).status).toBe("robots_blocked");
    const vs = await crawlSite(site("very-slow.test"), SETTINGS, deps());
    expect(vs.status).toBe("robots_blocked");
    expect(vs.error).toMatch(/120 s/);
  });

  it("stops within one request when the job is paused, without a result to save", async () => {
    let asked = 0;
    const run = crawlSite(site("pixel.test"), SETTINGS, { ...deps(), shouldStop: () => ++asked > 3 });
    await expect(run).rejects.toBeInstanceOf(CrawlInterrupted);
    expect(asked).toBe(4); // robots.txt, home, one page, then stop
  });

  it("waits as long as Crawl-delay asks", async () => {
    sleeps.length = 0;
    const o = await crawlSite(site("slow.test"), SETTINGS, deps());
    expect(o.status).toBe("ok");
    expect(Math.max(...sleeps)).toBeGreaterThan(4000);
  });

  it("stops at a bot block (403, 429, Cloudflare challenge) and keeps what it read before", async () => {
    expect((await crawlSite(site("forbidden.test"), SETTINGS, deps())).status).toBe("bot_blocked");
    expect((await crawlSite(site("busy.test"), SETTINGS, deps())).status).toBe("bot_blocked");
    expect((await crawlSite(site("cf.test"), SETTINGS, deps())).status).toBe("bot_blocked");
    srv.requests.length = 0;
    const p = await crawlSite(site("partway.test"), SETTINGS, deps());
    expect(p.status).toBe("partial");
    expect(collectEmails(p, "partway.test").map((e) => e.email)).toEqual(["info@partway.test"]);
    const after403 = srv.requests.filter((r) => r.host === "partway.test").map((r) => r.path);
    expect(after403[after403.length - 1]).toBe("/services"); // nothing after the block
  });

  it("never follows a redirect or link to a private address", async () => {
    srv.requests.length = 0;
    const o = await crawlSite(site("to-metadata.test"), SETTINGS, deps());
    expect(o.status).toBe("error");
    expect(o.error).toMatch(/private or local/);
    expect(srv.requests.some((r) => r.host === "metadata.test")).toBe(false);
    const link = await crawlSite(site("private-link.test"), SETTINGS, deps());
    expect(link.pages.find((p) => p.url.includes("intranet"))).toBeUndefined(); // other host: not followed at all
  });

  it("limits redirects and page size, and skips non-HTML home pages and platforms", async () => {
    const loop = await crawlSite(site("loop.test"), SETTINGS, deps());
    expect(loop.status).toBe("unreachable");
    expect(loop.error).toMatch(/redirects/);
    const huge = await crawlSite(site("huge.test"), SETTINGS, deps());
    expect(huge.pages.find((p) => p.kind === "home")?.note).toMatch(/Cut at/);
    expect((await crawlSite(site("pdf.test"), SETTINGS, deps())).status).toBe("not_html");
    const fb = await crawlSite(site("to-facebook.test"), SETTINGS, deps());
    expect(fb.status).toBe("platform");
    const missing = await crawlSite(site("missing.test"), SETTINGS, deps());
    expect(missing.status).toBe("unreachable");
    expect(missing.error).toMatch(/not found/i);
  });

  it("reads the job platform a careers page embeds (Personio) and keeps the developer jobs", async () => {
    srv.requests.length = 0;
    const o = await crawlSite(site("ats-agency.test"), SETTINGS, deps());
    expect(o.status).toBe("ok");
    expect(o.jobBoard).toMatchObject({ provider: "Personio", jobs: 2, developerJobs: 1 });
    expect(srv.requests.filter((r) => r.host === "ats-agency.jobs.personio.de").map((r) => r.path)).toEqual(["/robots.txt", "/xml"]);
    const s = detectSignals(o.fetched, { segment: "A", locationCount: 1, stackWords: stackWords() });
    const by = Object.fromEntries(s.map((x) => [x.key, x]));
    expect(by.hiring_dev?.value).toBe("Fullstack Developer");
    expect(by.hiring_dev?.evidenceUrl).toMatch(/\/job\/7$/);
    expect(by.job_remote).toBeDefined();
    expect(by.job_english).toBeDefined();
    expect(o.robots.status).not.toBe("not_read");
    expect(o.pages.find((p) => p.kind === "jobs")?.note).toBe("Personio: 2 open job(s), 1 for developers");
  });

  it("guesses the careers page in the site's language (Dutch: /vacatures)", async () => {
    srv.requests.length = 0;
    const o = await crawlSite(site("dutch.test", "B"), SETTINGS, deps());
    expect(o.fetched.find((p) => p.kind === "careers")?.url).toMatch(/\/vacatures$/);
    expect(srv.requests.some((r) => r.host === "dutch.test" && r.path === "/careers")).toBe(false);
  });

  it("retries a temporary DNS failure (EAI_AGAIN), and reports it when it does not go away", async () => {
    failFlakyDns(2);
    const ok = await crawlSite(site("flaky.test"), SETTINGS, deps());
    expect(ok.status).toBe("ok");
    failFlakyDns(10);
    const bad = await crawlSite(site("flaky.test"), SETTINGS, deps());
    expect(bad.status).toBe("unreachable");
    expect(bad.error).toMatch(/for now \(EAI_AGAIN\)/);
    failFlakyDns(0);
  });

  it("finds the contact page through the sitemap, or by trying /contact-us", async () => {
    const sm = await crawlSite(site("sitemap.test"), SETTINGS, deps());
    expect(sm.fetched.find((p) => p.kind === "contact")?.url).toMatch(/get-in-touch/);
    expect(collectEmails(sm, "sitemap.test").map((e) => e.email)).toEqual(["studio@sitemap.test"]);
    const g = await crawlSite(site("guess.test", "B"), SETTINGS, deps());
    expect(g.pages.map((p) => new URL(p.url).pathname)).toEqual(expect.arrayContaining(["/contact", "/contact-us"]));
    expect(collectEmails(g, "guess.test").map((e) => e.email)).toEqual(["info@guess.test"]);
  });

  it("after a redirect to www., that host's robots.txt counts too", async () => {
    srv.requests.length = 0;
    const o = await crawlSite(site("moved.test"), SETTINGS, deps());
    expect(o.status).toBe("ok");
    expect(srv.requests.some((r) => r.host === "www.moved.test" && r.path === "/robots.txt")).toBe(true);
    expect(o.pages.find((p) => p.url.includes("/secret"))?.note).toBe("Disallowed by robots.txt");
    expect(srv.requests.some((r) => r.path === "/secret")).toBe(false);
  });
});
