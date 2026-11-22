import dns from "node:dns";
import type { Db } from "../db/client.js";

export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
export const defaultMxResolver: MxResolver = (domain) => resolver.resolveMx(domain);

export interface MxResult {
  hasMx: boolean | null;
  hosts: string[];
  error: string | null;
}

/** One DNS MX lookup. "Null MX" (RFC 7505) and a missing domain mean "no mail"; DNS trouble means "unknown". */
export async function lookupMx(domain: string, resolve: MxResolver = defaultMxResolver): Promise<MxResult> {
  try {
    const records = (await resolve(domain)).sort((a, b) => a.priority - b.priority);
    const hosts = records.map((r) => r.exchange.toLowerCase()).filter((h) => h && h !== ".");
    return { hasMx: hosts.length > 0, hosts: hosts.slice(0, 5), error: hosts.length > 0 ? null : "Null MX: the domain takes no mail" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NOTFOUND" || code === "NODATA") {
      return { hasMx: false, hosts: [], error: `No MX record (${code})` };
    }
    return { hasMx: null, hosts: [], error: `DNS lookup failed (${code || (err as Error).message})` };
  }
}

const FRESH_MS = { known: 30 * 24 * 3600_000, unknown: 24 * 3600_000 };

/** MX check with a cache table (30 days for an answer, 1 day after a DNS failure). */
export async function checkMx(db: Db, domain: string, resolve?: MxResolver): Promise<MxResult> {
  const cached = await db.mxCheck.findUnique({ where: { domain } });
  if (cached) {
    const age = Date.now() - cached.checkedAt.getTime();
    if (age < (cached.hasMx === null ? FRESH_MS.unknown : FRESH_MS.known)) {
      return { hasMx: cached.hasMx, hosts: cached.hosts, error: cached.error };
    }
  }
  const r = await lookupMx(domain, resolve);
  await db.mxCheck.upsert({
    where: { domain },
    create: { domain, hasMx: r.hasMx, hosts: r.hosts, error: r.error, checkedAt: new Date() },
    update: { hasMx: r.hasMx, hosts: r.hosts, error: r.error, checkedAt: new Date() },
  });
  return r;
}
