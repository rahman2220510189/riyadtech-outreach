/**
 * Job platforms ("applicant tracking systems"). Many companies, especially in Germany, do not
 * write their job adverts on their own site: the careers page links to (or loads with
 * JavaScript) a board on Personio, Greenhouse, Lever, Recruitee, Workable or SmartRecruiters.
 * These platforms publish each company's open jobs as a public feed, meant to be shown on
 * other sites. We read that feed once per company, politely, like any other page.
 */

export type AtsProvider = "personio" | "greenhouse" | "lever" | "recruitee" | "workable" | "smartrecruiters";

export interface JobBoard {
  provider: AtsProvider;
  slug: string;
  /** The board people open in a browser. */
  boardUrl: string;
  /** The public feed we read. */
  feedUrl: string;
}

export interface JobPosting {
  title: string;
  url: string;
  location: string | null;
  remote: boolean;
  /** Plain text of the advert when the feed has it (Personio, Lever, Recruitee). */
  text: string;
}

export const ATS_LABELS: Record<AtsProvider, string> = {
  personio: "Personio",
  greenhouse: "Greenhouse",
  lever: "Lever",
  recruitee: "Recruitee",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
};

const SLUG = "([a-z0-9][a-z0-9_-]{1,60})";
const DETECT: { provider: AtsProvider; re: RegExp }[] = [
  { provider: "personio", re: new RegExp(`\\b${SLUG}\\.jobs\\.personio\\.(de|com)`, "i") },
  { provider: "greenhouse", re: new RegExp(`(?:job-)?boards(?:-api)?\\.greenhouse\\.io/(?:embed/job_board(?:/js)?\\?for=|v1/boards/)?${SLUG}`, "i") },
  { provider: "lever", re: new RegExp(`jobs\\.(?:eu\\.)?lever\\.co/${SLUG}`, "i") },
  { provider: "recruitee", re: new RegExp(`\\b${SLUG}\\.recruitee\\.com`, "i") },
  { provider: "workable", re: new RegExp(`apply\\.workable\\.com/${SLUG}`, "i") },
  { provider: "smartrecruiters", re: new RegExp(`(?:jobs|careers)\\.smartrecruiters\\.com/${SLUG}`, "i") },
];

/** Words that look like a slug but are parts of the platforms' own paths. */
const NOT_SLUGS = new Set(["embed", "api", "v1", "js", "www", "jobs", "careers", "static", "assets", "widget", "j"]);

/** Where each feed lives (tests replace the base so the fake platforms run on a local server). */
export type FeedUrlFor = (board: Omit<JobBoard, "feedUrl" | "boardUrl"> & { tld?: string }) => { feedUrl: string; boardUrl: string };

export const realFeedUrl: FeedUrlFor = ({ provider, slug, tld }) => {
  switch (provider) {
    case "personio": {
      const host = `${slug}.jobs.personio.${tld === "com" ? "com" : "de"}`;
      return { feedUrl: `https://${host}/xml?language=en`, boardUrl: `https://${host}/` };
    }
    case "greenhouse":
      return { feedUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, boardUrl: `https://boards.greenhouse.io/${slug}` };
    case "lever":
      return { feedUrl: `https://api.lever.co/v0/postings/${slug}?mode=json`, boardUrl: `https://jobs.lever.co/${slug}` };
    case "recruitee":
      return { feedUrl: `https://${slug}.recruitee.com/api/offers/`, boardUrl: `https://${slug}.recruitee.com/` };
    case "workable":
      return { feedUrl: `https://apply.workable.com/api/v1/widget/accounts/${slug}`, boardUrl: `https://apply.workable.com/${slug}/` };
    case "smartrecruiters":
      return { feedUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`, boardUrl: `https://jobs.smartrecruiters.com/${slug}` };
  }
};

/** The first job platform linked or embedded in the pages (careers pages first). */
export function detectBoard(htmls: string[], feedUrlFor: FeedUrlFor = realFeedUrl): JobBoard | null {
  for (const html of htmls) {
    for (const d of DETECT) {
      const m = d.re.exec(html);
      const slug = m?.[1]?.toLowerCase();
      if (!slug || NOT_SLUGS.has(slug)) continue;
      const tld = m?.[2]?.toLowerCase();
      return { provider: d.provider, slug, ...feedUrlFor({ provider: d.provider, slug, ...(tld ? { tld } : {}) }) };
    }
  }
  return null;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** HTML or escaped HTML to plain text (descriptions in the feeds). */
export function htmlToText(s: string | null | undefined): string {
  if (!s) return "";
  return decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, "i").exec(xml);
  return m?.[1] !== undefined ? decodeEntities(m[1]).trim() : null;
}

const REMOTE_WORDS = /\b(remote|home ?office|telecommut|anywhere|hybrid)\b/i;
const MAX_TEXT = 4000;

/** Jobs from a platform's public feed. Unknown shapes give an empty list (never an error). */
export function parseJobs(board: JobBoard, body: string): JobPosting[] {
  try {
    switch (board.provider) {
      case "personio": {
        const out: JobPosting[] = [];
        for (const m of body.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
          const p = m[1]!;
          const id = tag(p, "id");
          const title = tag(p, "name");
          if (!title) continue;
          const office = tag(p, "office");
          const values = [...p.matchAll(/<value>([\s\S]*?)<\/value>/gi)].map((v) => v[1]!.replace(/<!\[CDATA\[|\]\]>/g, ""));
          const text = htmlToText(values.join(" ")).slice(0, MAX_TEXT);
          out.push({
            title,
            url: id ? new URL(`/job/${id}`, board.boardUrl).toString() : board.boardUrl,
            location: office,
            remote: REMOTE_WORDS.test(`${office ?? ""} ${tag(p, "schedule") ?? ""}`),
            text,
          });
        }
        return out;
      }
      case "greenhouse": {
        const data = JSON.parse(body) as { jobs?: { title?: string; absolute_url?: string; location?: { name?: string }; content?: string }[] };
        return (data.jobs ?? [])
          .filter((j) => j.title)
          .map((j) => ({
            title: j.title!,
            url: j.absolute_url ?? board.boardUrl,
            location: j.location?.name ?? null,
            remote: REMOTE_WORDS.test(j.location?.name ?? ""),
            text: htmlToText(j.content).slice(0, MAX_TEXT),
          }));
      }
      case "lever": {
        const data = JSON.parse(body) as {
          text?: string;
          hostedUrl?: string;
          categories?: { location?: string; commitment?: string };
          workplaceType?: string;
          descriptionPlain?: string;
          additionalPlain?: string;
        }[];
        return (Array.isArray(data) ? data : [])
          .filter((j) => j.text)
          .map((j) => ({
            title: j.text!,
            url: j.hostedUrl ?? board.boardUrl,
            location: j.categories?.location ?? null,
            remote: j.workplaceType === "remote" || REMOTE_WORDS.test(j.categories?.location ?? ""),
            text: `${j.descriptionPlain ?? ""} ${j.additionalPlain ?? ""}`.slice(0, MAX_TEXT),
          }));
      }
      case "recruitee": {
        const data = JSON.parse(body) as {
          offers?: { title?: string; careers_url?: string; location?: string; remote?: boolean; description?: string; requirements?: string }[];
        };
        return (data.offers ?? [])
          .filter((j) => j.title)
          .map((j) => ({
            title: j.title!,
            url: j.careers_url ?? board.boardUrl,
            location: j.location ?? null,
            remote: j.remote === true || REMOTE_WORDS.test(j.location ?? ""),
            text: htmlToText(`${j.description ?? ""} ${j.requirements ?? ""}`).slice(0, MAX_TEXT),
          }));
      }
      case "workable": {
        const data = JSON.parse(body) as { jobs?: { title?: string; url?: string; shortlink?: string; city?: string; country?: string; telecommuting?: boolean }[] };
        return (data.jobs ?? [])
          .filter((j) => j.title)
          .map((j) => ({
            title: j.title!,
            url: j.url ?? j.shortlink ?? board.boardUrl,
            location: [j.city, j.country].filter(Boolean).join(", ") || null,
            remote: j.telecommuting === true,
            text: "",
          }));
      }
      case "smartrecruiters": {
        const data = JSON.parse(body) as { content?: { id?: string; name?: string; location?: { city?: string; country?: string; remote?: boolean } }[] };
        return (data.content ?? [])
          .filter((j) => j.name)
          .map((j) => ({
            title: j.name!,
            url: j.id ? `${board.boardUrl.replace(/\/$/, "")}/${j.id}` : board.boardUrl,
            location: [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null,
            remote: j.location?.remote === true,
            text: "",
          }));
      }
    }
  } catch {
    return [];
  }
}

/**
 * The developer jobs as one text, read like a careers page by the signal rules (role, remote,
 * visa, English team, local language). Starts with "We're hiring:" so the job-advert check passes.
 */
export function jobsAsPageText(provider: AtsProvider, jobs: JobPosting[]): string {
  const lines = jobs.map((j) => `${j.title}${j.location ? ` (${j.location})` : ""}${j.remote ? " - remote possible" : ""}. ${j.text}`);
  return `We're hiring (${ATS_LABELS[provider]}): ${lines.join(" | ")}`.slice(0, 20_000);
}
