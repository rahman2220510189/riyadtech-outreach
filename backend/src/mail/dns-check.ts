import { Resolver } from "node:dns/promises";

/**
 * DNS check of a sending domain, explained in plain words: where its mail goes (MX), whether
 * SPF allows the sending service, the DMARC policy, and DKIM for a known selector.
 * It reads public DNS only; whether a real e-mail passes is best seen in a received test
 * e-mail ("Show original" in Gmail).
 */

export type CheckStatus = "ok" | "warn" | "bad" | "info";
export interface DnsCheckItem {
  key: "mx" | "spf" | "dmarc" | "dkim" | "alignment";
  status: CheckStatus;
  title: string;
  detail: string;
  records: string[];
}
export interface DnsCheckResult {
  domain: string;
  provider: string;
  items: DnsCheckItem[];
  checkedAt: string;
}

export interface DnsLookups {
  mx: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  txt: (name: string) => Promise<string[][]>;
}

function realLookups(): DnsLookups {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  return { mx: (d) => r.resolveMx(d), txt: (n) => r.resolveTxt(n) };
}
let testLookups: DnsLookups | null = null;
export function setDnsTestLookups(l: DnsLookups | null): void {
  testLookups = l;
}

interface Provider {
  name: string;
  hosts: RegExp;
  spf: RegExp;
  spfText: string;
  dkimSelectors: string[];
  /** Messages are signed with the provider's own domain, not yours (Gmail "Send mail as" from a gmail.com account). */
  signsAsProvider?: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "Gmail / Google",
    hosts: /(^|\.)(smtp\.gmail\.com|smtp-relay\.gmail\.com)$/i,
    spf: /include:_spf\.google\.com/i,
    spfText: "include:_spf.google.com",
    dkimSelectors: ["google"],
    signsAsProvider: "gmail.com",
  },
  { name: "Zoho Mail", hosts: /(^|\.)smtp(pro)?\.zoho\.(com|eu|in|com\.au)$/i, spf: /include:zoho(mail)?\.(com|eu|in)|include:one\.zoho/i, spfText: "include:zohomail.eu (or zoho.com)", dkimSelectors: ["zmail", "zoho"] },
  { name: "Microsoft 365", hosts: /(^|\.)smtp\.office365\.com$/i, spf: /include:spf\.protection\.outlook\.com/i, spfText: "include:spf.protection.outlook.com", dkimSelectors: ["selector1", "selector2"] },
  { name: "Hostinger", hosts: /(^|\.)smtp\.hostinger\.com$/i, spf: /include:_spf\.mail\.hostinger\.com/i, spfText: "include:_spf.mail.hostinger.com", dkimSelectors: ["hostingermail1", "hostingermail2"] },
];

function providerFor(smtpHost: string): Provider | null {
  return PROVIDERS.find((p) => p.hosts.test(smtpHost.trim())) ?? null;
}

async function txt(l: DnsLookups, name: string): Promise<string[] | null> {
  try {
    return (await l.txt(name)).map((parts) => parts.join(""));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    return null; // lookup failed (timeout, server error)
  }
}

export async function checkSendingDomain(input: { fromEmail: string; smtpHost: string; dkimSelector?: string | null }): Promise<DnsCheckResult> {
  const l = testLookups ?? realLookups();
  const domain = (input.fromEmail.split("@")[1] ?? "").toLowerCase();
  const provider = providerFor(input.smtpHost);
  const items: DnsCheckItem[] = [];
  const isGmailAccount = /@(gmail|googlemail)\.com$/i.test(input.fromEmail);

  // MX: where replies go.
  const mx = await l.mx(domain).then(
    (r) => r.sort((a, b) => a.priority - b.priority),
    () => [] as { exchange: string; priority: number }[],
  );
  const mxHosts = mx.map((m) => m.exchange.toLowerCase());
  if (mxHosts.length === 0) {
    items.push({ key: "mx", status: "bad", title: "No MX record", detail: `Nobody receives mail for ${domain}: replies to your e-mails would bounce. Add MX records at your DNS provider.`, records: [] });
  } else {
    const via = mxHosts.some((h) => h.endsWith(".mx.cloudflare.net"))
      ? "Cloudflare Email Routing (forwarding to your inbox)"
      : mxHosts.some((h) => /google(mail)?\.com$|\.google\.com$/.test(h))
        ? "Google"
        : mxHosts.some((h) => /zoho/.test(h))
          ? "Zoho"
          : mxHosts.some((h) => /outlook\.com$/.test(h))
            ? "Microsoft 365"
            : mxHosts[0]!;
    items.push({ key: "mx", status: "ok", title: "Replies arrive", detail: `Mail for ${domain} is received by ${via}.`, records: mx.map((m) => `${m.priority} ${m.exchange}`) });
  }

  // SPF: who may send for the domain.
  const root = await txt(l, domain);
  const spf = (root ?? []).filter((t) => /^v=spf1\b/i.test(t.trim()));
  if (root === null) {
    items.push({ key: "spf", status: "warn", title: "SPF could not be checked", detail: "The DNS lookup failed; try again in a minute.", records: [] });
  } else if (spf.length === 0) {
    items.push({
      key: "spf",
      status: "bad",
      title: "No SPF record",
      detail: `${domain} does not say which services may send its mail; many receivers will treat your e-mails as suspicious. Add one TXT record: v=spf1 ${provider ? `${provider.spfText} ` : ""}${mxHosts.some((h) => h.endsWith(".mx.cloudflare.net")) ? "include:_spf.mx.cloudflare.net " : ""}~all`,
      records: [],
    });
  } else if (spf.length > 1) {
    items.push({ key: "spf", status: "bad", title: "Two SPF records", detail: "A domain may have only one SPF record; with two, SPF fails everywhere. Merge them into one.", records: spf });
  } else {
    const record = spf[0]!;
    const covers = provider ? provider.spf.test(record) : null;
    const strict = /[-~]all\b/.test(record) ? (record.includes("-all") ? "-all (others are rejected)" : "~all (others are suspicious)") : /\?all|\+all/.test(record) ? "?all/+all (anybody may send: too open)" : "no all-rule";
    items.push({
      key: "spf",
      status: covers === false ? "bad" : covers === null ? "info" : /\+all/.test(record) ? "warn" : "ok",
      title: covers === false ? `SPF does not include ${provider!.name}` : covers ? `SPF allows ${provider!.name}` : "SPF record found",
      detail:
        covers === false
          ? `Your SMTP server is ${provider!.name}, but the SPF record does not list it. Add ${provider!.spfText} to the record (before the "all" part). Ending: ${strict}.`
          : covers
            ? `${provider!.name} may send for ${domain}. Ending: ${strict}.`
            : `The SMTP server ${input.smtpHost} is not one we recognise; check that the record includes it. Ending: ${strict}.`,
      records: spf,
    });
  }

  // DMARC: what receivers do when SPF/DKIM do not match the From domain.
  const dm = await txt(l, `_dmarc.${domain}`);
  const dmarc = (dm ?? []).filter((t) => /^v=DMARC1\b/i.test(t.trim()));
  if (dm === null) {
    items.push({ key: "dmarc", status: "warn", title: "DMARC could not be checked", detail: "The DNS lookup failed; try again in a minute.", records: [] });
  } else if (dmarc.length === 0) {
    items.push({
      key: "dmarc",
      status: "warn",
      title: "No DMARC record",
      detail: `Gmail and Yahoo expect senders to have one. Start with a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:you@${domain} (p=none only collects reports and changes nothing for delivery).`,
      records: [],
    });
  } else {
    const p = /\bp=(none|quarantine|reject)/i.exec(dmarc[0]!)?.[1]?.toLowerCase() ?? "?";
    const words: Record<string, string> = {
      none: "p=none: receivers only report; e-mails that fail the checks are still delivered normally.",
      quarantine: "p=quarantine: e-mails that fail the checks go to spam. SPF or DKIM must match your domain.",
      reject: "p=reject: e-mails that fail the checks are refused. SPF or DKIM must match your domain.",
    };
    items.push({ key: "dmarc", status: "ok", title: `DMARC policy ${p}`, detail: words[p] ?? "DMARC record found.", records: dmarc });
  }

  // DKIM: a selector we know or the one saved for the mailbox.
  const selectors = [...new Set([input.dkimSelector?.trim(), ...(provider?.dkimSelectors ?? [])].filter((s): s is string => !!s))];
  let dkimFound: string | null = null;
  const dkimRecords: string[] = [];
  for (const sel of selectors) {
    const r = await txt(l, `${sel}._domainkey.${domain}`);
    const key = (r ?? []).find((t) => /\bp=[A-Za-z0-9+/]/.test(t));
    if (key) {
      dkimFound = sel;
      dkimRecords.push(`${sel}._domainkey: ${key.slice(0, 80)}…`);
      break;
    }
  }
  const p = dmarc.length ? (/\bp=(none|quarantine|reject)/i.exec(dmarc[0]!)?.[1]?.toLowerCase() ?? "none") : null;
  if (dkimFound) {
    items.push({ key: "dkim", status: "ok", title: `DKIM key found (selector ${dkimFound})`, detail: "Your domain publishes a signing key. The sending service must also sign with it (check a received test e-mail).", records: dkimRecords });
  } else {
    items.push({
      key: "dkim",
      status: "info",
      title: "No DKIM key found for a known selector",
      detail: selectors.length
        ? `Looked for ${selectors.map((s) => `${s}._domainkey`).join(", ")}. If your provider gave you a different selector, enter it in the mailbox and check again.`
        : "Enter the DKIM selector your mail provider gave you (if any) and check again.",
      records: [],
    });
  }

  // Alignment for Gmail "Send mail as" from a gmail.com account.
  if (provider?.signsAsProvider && !isGmailAccount && !dkimFound) {
    items.push({
      key: "alignment",
      status: p === "quarantine" || p === "reject" ? "bad" : "warn",
      title: "Gmail signs your e-mails as gmail.com",
      detail:
        `When a personal Gmail account sends as ${input.fromEmail}, Google usually signs the e-mail with gmail.com, not ${domain}. ` +
        `SPF passes for Google but does not match ${domain}, so DMARC does not pass. ` +
        (p === "quarantine" || p === "reject"
          ? `With your policy p=${p} these e-mails may land in spam or be refused. Use p=none for now, or a provider that signs with ${domain} (Google Workspace, Zoho Mail).`
          : `With p=none (or no DMARC) they are still delivered; some receivers show "via gmail.com". For better delivery later: Google Workspace or Zoho Mail, which sign with ${domain}.`) +
        ` Check the real result in a received test e-mail: Gmail → ⋮ → "Show original" lists SPF, DKIM and DMARC.`,
      records: [],
    });
  }

  return { domain, provider: provider?.name ?? "Other", items, checkedAt: new Date().toISOString() };
}
