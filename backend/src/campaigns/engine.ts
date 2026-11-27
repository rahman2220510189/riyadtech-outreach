import type { Env } from "../config/env.js";
import { createCrawlJob } from "../crawler/tasks.js";
import type { Db } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { JobStore } from "../jobs/store.js";
import { AppError } from "../lib/errors.js";
import { suppressedSet } from "../leads/suppression.js";
import { readyWhere } from "../leads/ready.js";
import { composeMail, placeRecipient } from "../mail/compose.js";
import { MailSendError, transmit, usesGmail } from "../mail/send.js";
import { newMessageId } from "../mail/transport.js";
import { warmupAllowance } from "../mail/warmup.js";
import type { Settings } from "../settings/definitions.js";

/**
 * Phase 5: the campaign engine.
 *
 * A campaign takes "Ready now" leads of one segment and one country (never one already contacted in
 * the last `recontactDays`, never two addresses of one company), crawls the ones not crawled yet
 * (the opening line comes from the website), then sends step 1 and two follow-ups in the same
 * thread. Every send waits for the recipient's office hours (weekdays 09:00-17:00 in their time
 * zone), a random 2-6 minute gap per mailbox, the mailbox's warm-up allowance and the daily caps.
 * A send is claimed by a unique (lead, step) row before anything leaves, so a crash or a second
 * worker can never send a step twice. With SENDING_ENABLED=false nothing leaves: the e-mail is
 * written as a "preview" at the time it would have gone out.
 */

export type CampaignEnv = Pick<Env, "SENDING_ENABLED" | "ENCRYPTION_KEY" | "MAIL_DELIVERY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "PUBLIC_BASE_URL">;

const HIRING_KEYS = ["hiring_dev", "job_opening"];
/** The first real campaign ever sends at most this many e-mails, then waits for me. */
export const FIRST_CAMPAIGN_LIMIT = 5;

export interface CampaignInput {
  name: string;
  segment: "A" | "B";
  country: string;
  categoryKeys: string[];
  mailboxId: bigint;
  size: number;
}

/* --------------------------------------------------------------------------------------------- */
/* Choosing leads                                                                                 */
/* --------------------------------------------------------------------------------------------- */

async function readyContext(db: Db, settings: Settings) {
  return {
    outreachCountries: (await db.country.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code),
    minLeadScore: settings.scores.readyMinLeadScore,
  };
}

/** Leads a new campaign may take, best first. */
export async function candidateLeads(db: Db, input: Omit<CampaignInput, "name" | "mailboxId">, settings: Settings, now = new Date()) {
  const since = new Date(now.getTime() - settings.sending.recontactDays * 24 * 3600_000);
  // Domains already in a campaign recently (contacted, or waiting to be).
  const busy = await db.campaignLead.findMany({
    where: { OR: [{ status: { in: ["waiting_crawl", "queued"] } }, { sends: { some: { createdAt: { gte: since }, status: { in: ["sent", "sending"] } } } }] },
    select: { domain: true },
  });
  const busyDomains = [...new Set(busy.map((b) => b.domain))];
  const rows = await db.place.findMany({
    where: {
      AND: [
        readyWhere(await readyContext(db, settings)),
        { segment: input.segment, country: input.country },
        input.categoryKeys.length ? { categoryKey: { in: input.categoryKeys } } : {},
        busyDomains.length ? { websiteDomain: { notIn: busyDomains } } : {},
        // A crawled site we could not read gives no opening line: skip it.
        { OR: [{ crawlStatus: null }, { signalLine: { not: null } }] },
      ],
    },
    orderBy: [{ leadScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: input.size * 3,
    select: { id: true, primaryEmail: true, websiteDomain: true, crawlStatus: true, bestOffer: true },
  });
  const out: typeof rows = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const domain = r.primaryEmail!.split("@")[1] ?? r.websiteDomain;
    if (seen.has(r.websiteDomain) || seen.has(domain)) continue;
    seen.add(r.websiteDomain);
    seen.add(domain);
    out.push(r);
    if (out.length >= input.size) break;
  }
  return out;
}

export async function createCampaign(db: Db, input: CampaignInput, settings: Settings) {
  const mailbox = await db.mailbox.findUnique({ where: { id: input.mailboxId } });
  if (!mailbox || !mailbox.active) throw new AppError(400, "MAILBOX", "Choose an active mailbox.");
  const country = await db.country.findUnique({ where: { code: input.country } });
  if (!country?.enabled) throw new AppError(400, "COUNTRY_OFF", "Outreach is switched off for this country (Settings → Countries).");
  const leads = await candidateLeads(db, input, settings);
  if (leads.length === 0) throw new AppError(400, "NO_LEADS", "No ready leads match: find more leads, or choose another country or kind of business.");
  return db.campaign.create({
    data: {
      name: input.name,
      segment: input.segment,
      country: input.country,
      categoryKeys: input.categoryKeys,
      mailboxId: input.mailboxId,
      leads: {
        create: leads.map((l) => ({
          placeId: l.id,
          email: l.primaryEmail!,
          domain: l.websiteDomain,
          offer: input.segment === "B" ? (l.bestOffer ?? "chatbot") : null,
          status: l.crawlStatus === null ? "waiting_crawl" : "queued",
        })),
      },
    },
    include: { leads: true },
  });
}

/* --------------------------------------------------------------------------------------------- */
/* Rendering                                                                                      */
/* --------------------------------------------------------------------------------------------- */

export async function templateFor(db: Db, segment: string, offer: string | null, step: number) {
  const list = await db.template.findMany({
    where: { kind: "outreach", step, OR: [{ segment }, { segment: null }] },
    orderBy: [{ id: "asc" }],
  });
  return list.find((t) => t.segment === segment && t.offer === offer) ?? list.find((t) => t.segment === segment && !t.offer) ?? list.find((t) => !t.segment) ?? null;
}

type LeadWithPlace = Prisma.CampaignLeadGetPayload<{ include: { place: { include: { signals: true } } } }>;

export interface RenderedStep {
  subject: string;
  text: string;
  headers: Record<string, string>;
  missing: string[];
  templateName: string;
}

/** The e-mail a lead gets at a step, exactly as it would leave (spintax fixed per lead). */
export async function renderStep(
  db: Db,
  env: CampaignEnv,
  settings: Settings,
  campaign: { segment: string; mailbox: { fromName: string; fromEmail: string; replyTo: string | null } },
  lead: LeadWithPlace,
  step: number,
): Promise<RenderedStep | null> {
  const t = await templateFor(db, campaign.segment, lead.offer, step);
  if (!t) return null;
  const recipient = placeRecipient({ ...lead.place, primaryEmail: lead.email, signals: lead.place.signals.filter((s) => HIRING_KEYS.includes(s.key)) });
  const c = composeMail({
    kind: "outreach",
    subject: t.subject,
    body: t.body,
    templateKey: `campaign-step-${step}`,
    recipient,
    to: lead.email,
    mailbox: campaign.mailbox,
    company: settings.company,
    env,
  });
  const subject = step > 1 && !t.subject.trim() ? `Re: ${lead.firstSubject ?? c.subject}` : c.subject;
  return { subject, text: c.text, headers: c.headers, missing: [...c.missing, ...c.unknown], templateName: t.name };
}

/* --------------------------------------------------------------------------------------------- */
/* Launching                                                                                      */
/* --------------------------------------------------------------------------------------------- */

export async function launchCampaign(db: Db, jobs: JobStore, env: CampaignEnv, settings: Settings, id: bigint) {
  const campaign = await db.campaign.findUnique({ where: { id }, include: { mailbox: true } });
  if (!campaign) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  if (campaign.status !== "draft" && campaign.status !== "paused") throw new AppError(409, "CONFLICT", `The campaign is ${campaign.status}.`);
  if (!settings.company.postalAddress.trim()) {
    throw new AppError(400, "POSTAL_ADDRESS", "Add your postal address in Settings → Company first: the law (CAN-SPAM) requires it in every e-mail.");
  }
  if (env.SENDING_ENABLED && env.MAIL_DELIVERY === "outbox" && !usesGmail(campaign.mailbox, env)) {
    throw new AppError(400, "MAILBOX_GMAIL", "This mailbox cannot send from the hosted site: connect it to Gmail on the Mailboxes page first.");
  }
  let sendLimit = campaign.sendLimit;
  let note = campaign.note;
  if (campaign.status === "draft" && env.SENDING_ENABLED) {
    const realSends = await db.campaignSend.count({ where: { status: "sent" } });
    if (realSends === 0) {
      sendLimit = FIRST_CAMPAIGN_LIMIT;
      note = `First real campaign: it stops after ${FIRST_CAMPAIGN_LIMIT} e-mails so you can check them.`;
    }
  }
  if (campaign.status === "paused" && sendLimit !== null) {
    // Resuming after the first 5: no limit any more.
    const sent = await db.campaignSend.count({ where: { lead: { campaignId: id }, status: { in: ["sent", "preview"] } } });
    if (sent >= sendLimit) {
      sendLimit = null;
      note = null;
    }
  }
  let crawlJobId = campaign.crawlJobId;
  const waiting = await db.campaignLead.findMany({ where: { campaignId: id, status: "waiting_crawl" }, select: { placeId: true } });
  if (waiting.length > 0 && !crawlJobId) {
    crawlJobId = await createCrawlJob(jobs, { placeIds: waiting.map((w) => Number(w.placeId)), onlyNew: false, limit: Math.min(5000, waiting.length) }, `Campaign "${campaign.name}": websites first`);
  }
  await db.campaignLead.updateMany({ where: { campaignId: id, status: "queued", nextAt: null }, data: { nextAt: new Date() } });
  return db.campaign.update({ where: { id }, data: { status: "running", startedAt: campaign.startedAt ?? new Date(), sendLimit, note, crawlJobId } });
}

/* --------------------------------------------------------------------------------------------- */
/* The clock: office hours, gaps, caps                                                            */
/* --------------------------------------------------------------------------------------------- */

/** Weekday (1 = Monday … 7 = Sunday) and minutes since midnight in a time zone. */
export function localClock(now: Date, timeZone: string): { weekday: number; minutes: number } {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

/** Inside the recipient's sending window (weekdays 09:00-17:00 by default)? */
export function inWindow(now: Date, timeZone: string, s: Settings["sending"]): boolean {
  const c = localClock(now, timeZone);
  if (s.weekdaysOnly && c.weekday >= 6) return false;
  return c.minutes >= toMinutes(s.windowStart) && c.minutes < toMinutes(s.windowEnd);
}

/** The random gap after a send, fixed by the send's id (so every worker computes the same). */
export function gapAfter(sendId: bigint, s: Settings["sending"]): number {
  const min = Math.min(s.minGapMinutes, s.maxGapMinutes);
  const max = Math.max(s.minGapMinutes, s.maxGapMinutes);
  const x = Number((sendId * 2654435761n) % 1000n) / 1000;
  return Math.round((min + (max - min) * x) * 60_000);
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/* --------------------------------------------------------------------------------------------- */
/* The tick                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export interface TickResult {
  promoted: number;
  skipped: number;
  sent: number;
  previews: number;
  failed: number;
  stopped: number;
}

/** Leads whose website was crawled: ready to queue, or skipped with the reason. */
async function promoteCrawled(db: Db, settings: Settings, r: TickResult, now: Date): Promise<void> {
  const waiting = await db.campaignLead.findMany({
    where: { status: "waiting_crawl", campaign: { status: "running" }, place: { crawlStatus: { not: null } } },
    include: { place: true },
    take: 500,
  });
  const ctx = await readyContext(db, settings);
  for (const l of waiting) {
    const p = l.place;
    let reason: string | null = null;
    if (!p.primaryEmail || p.suppressed) reason = "No usable address after the crawl";
    else if (!ctx.outreachCountries.includes(p.country)) reason = "Outreach switched off for the country";
    else if (!p.signalLine) reason = "The website could not be read (no opening line)";
    if (reason) {
      await db.campaignLead.update({ where: { id: l.id }, data: { status: "skipped", reason } });
      r.skipped++;
    } else {
      await db.campaignLead.update({ where: { id: l.id }, data: { status: "queued", email: p.primaryEmail!, offer: l.offer === null ? null : (p.bestOffer ?? l.offer), nextAt: now } });
      r.promoted++;
    }
  }
}

/**
 * One run of the sender (the worker calls it every minute). Per mailbox at most one e-mail per run;
 * the gap, caps and office hours decide whether that one goes now.
 */
export async function campaignTick(db: Db, env: CampaignEnv, settings: Settings, now = new Date()): Promise<TickResult> {
  const r: TickResult = { promoted: 0, skipped: 0, sent: 0, previews: 0, failed: 0, stopped: 0 };
  await promoteCrawled(db, settings, r, now);

  const s = settings.sending;
  const today = startOfUtcDay(now);
  const globalToday = await db.campaignSend.count({ where: { createdAt: { gte: today }, status: { in: ["sent", "preview", "sending"] } } });
  let globalLeft = s.globalDailyCap - globalToday;
  if (globalLeft <= 0) return r;

  const campaigns = await db.campaign.findMany({ where: { status: "running" }, include: { mailbox: true }, orderBy: { id: "asc" } });
  const usedMailboxes = new Set<bigint>();
  for (const campaign of campaigns) {
    if (globalLeft <= 0) break;
    const mailbox = campaign.mailbox;
    if (usedMailboxes.has(mailbox.id) || !mailbox.active) continue;

    // Warm-up allowance and the gap since this mailbox's last e-mail.
    const sentToday = await db.campaignSend.count({ where: { mailboxId: mailbox.id, createdAt: { gte: today }, status: { in: ["sent", "preview", "sending"] } } });
    if (sentToday >= warmupAllowance(mailbox, s, now)) continue;
    const last = await db.campaignSend.findFirst({ where: { mailboxId: mailbox.id }, orderBy: { id: "desc" }, select: { id: true, createdAt: true } });
    if (last && last.createdAt.getTime() + gapAfter(last.id, s) > now.getTime()) continue;

    // The campaign's own limit (the first real campaign: 5 e-mails).
    if (campaign.sendLimit !== null) {
      const done = await db.campaignSend.count({ where: { lead: { campaignId: campaign.id }, status: { in: ["sent", "preview", "sending"] } } });
      if (done >= campaign.sendLimit) {
        await db.campaign.update({ where: { id: campaign.id }, data: { status: "paused", note: `Paused after ${done} e-mails. Check them in your Sent folder, then press Resume.` } });
        continue;
      }
    }

    // Due leads: follow-ups first, then new first e-mails by score; the first one inside its office hours goes.
    const due = await db.campaignLead.findMany({
      where: { campaignId: campaign.id, status: "queued", nextAt: { lte: now } },
      include: { place: { include: { signals: true } } },
      orderBy: [{ step: "desc" }, { nextAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    const tzFallback = (await db.country.findUnique({ where: { code: campaign.country }, select: { timezones: true } }))?.timezones[0] ?? "UTC";
    const lead = due.find((l) => inWindow(now, l.place.timezone ?? tzFallback, s));
    if (!lead) continue;
    usedMailboxes.add(mailbox.id);
    const outcome = await sendStep(db, env, settings, campaign, lead, now);
    if (outcome === "sent") r.sent++;
    else if (outcome === "preview") r.previews++;
    else if (outcome === "failed") r.failed++;
    else if (outcome === "stopped") r.stopped++;
    if (outcome === "sent" || outcome === "preview") globalLeft--;
  }

  // Campaigns with nothing left to do are done.
  for (const c of campaigns) {
    const open = await db.campaignLead.count({ where: { campaignId: c.id, status: { in: ["queued", "waiting_crawl"] } } });
    if (open === 0) await db.campaign.update({ where: { id: c.id }, data: { status: "done" } });
  }
  return r;
}

type Outcome = "sent" | "preview" | "failed" | "stopped" | "skipped";

async function stopLead(db: Db, id: bigint, status: string, reason: string): Promise<"stopped"> {
  await db.campaignLead.update({ where: { id }, data: { status, reason, nextAt: null } });
  return "stopped";
}

/** Checks, claims, renders and sends (or writes the preview of) the lead's next step. */
async function sendStep(
  db: Db,
  env: CampaignEnv,
  settings: Settings,
  campaign: Prisma.CampaignGetPayload<{ include: { mailbox: true } }>,
  lead: LeadWithPlace,
  now: Date,
): Promise<Outcome> {
  const step = lead.step + 1;
  const place = lead.place;

  // Checked again right before sending: suppression, outreach switch, address still the lead's.
  const sup = await suppressedSet(db, [lead.email], [lead.domain, lead.email.split("@")[1] ?? ""]);
  if (place.suppressed || sup.emails.size > 0 || sup.domains.size > 0) return stopLead(db, lead.id, "stopped", "On the suppression list");
  const country = await db.country.findUnique({ where: { code: place.country }, select: { enabled: true } });
  if (!country?.enabled) return stopLead(db, lead.id, "stopped", "Outreach switched off for the country");
  if (step === 1 && place.primaryEmail && place.primaryEmail !== lead.email) {
    await db.campaignLead.update({ where: { id: lead.id }, data: { email: place.primaryEmail } });
    lead.email = place.primaryEmail;
  }
  if (step === 1 && !place.primaryEmail) return stopLead(db, lead.id, "skipped", "The lead has no usable address any more");

  const rendered = await renderStep(db, env, settings, campaign, lead, step);
  if (!rendered) {
    await db.campaignLead.update({ where: { id: lead.id }, data: { status: "done", nextAt: null, reason: step > 1 ? null : "No template" } });
    return "skipped";
  }
  if (rendered.missing.length > 0) return stopLead(db, lead.id, "skipped", `Missing in the template: ${rendered.missing.join(", ")}`);

  const messageId = newMessageId(campaign.mailbox.fromEmail);
  const headers = { ...rendered.headers };
  if (step > 1 && lead.lastMessageId) {
    headers["In-Reply-To"] = lead.lastMessageId;
    headers.References = [lead.firstMessageId, lead.lastMessageId].filter((x, i, a): x is string => !!x && a.indexOf(x) === i).join(" ");
  }

  // The claim: one row per (lead, step). A second worker or a restart cannot send the step again.
  let claim;
  try {
    claim = await db.campaignSend.create({
      data: { campaignLeadId: lead.id, step, mailboxId: campaign.mailbox.id, toEmail: lead.email, subject: rendered.subject, body: rendered.text, messageId, status: "sending", createdAt: now },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "skipped";
    throw err;
  }

  const days = step === 1 ? settings.sending.followUp1Days : settings.sending.followUp2Days;
  const advance = (status: string) => ({
    step,
    status: step >= 3 ? "done" : "queued",
    nextAt: step >= 3 ? null : new Date(now.getTime() + days * 24 * 3600_000),
    lastMessageId: messageId,
    ...(step === 1 ? { firstSubject: rendered.subject, firstMessageId: messageId } : {}),
    reason: status === "preview" ? "Preview only (sending is switched off)" : null,
  });

  if (!env.SENDING_ENABLED) {
    await db.$transaction([
      db.campaignSend.update({ where: { id: claim.id }, data: { status: "preview", response: "Not sent: SENDING_ENABLED=false (preview)" } }),
      db.campaignLead.update({ where: { id: lead.id }, data: advance("preview") }),
    ]);
    return "preview";
  }

  try {
    const res = await transmit(db, env, campaign.mailbox, {
      from: { name: campaign.mailbox.fromName, address: campaign.mailbox.fromEmail },
      to: lead.email,
      replyTo: campaign.mailbox.replyTo ?? undefined,
      subject: rendered.subject,
      text: rendered.text,
      headers,
      messageId,
    });
    await db.$transaction([
      db.campaignSend.update({ where: { id: claim.id }, data: { status: "sent", response: res.response.slice(0, 500) } }),
      db.campaignLead.update({ where: { id: lead.id }, data: advance("sent") }),
      db.mailLog.create({ data: { kind: "outreach", mailboxId: campaign.mailbox.id, toEmail: lead.email, subject: rendered.subject, messageId, status: "sent", smtpResponse: res.response.slice(0, 500), createdBy: "campaign" } }),
    ]);
    return "sent";
  } catch (err) {
    if (!(err instanceof MailSendError)) throw err;
    const error = err.message.slice(0, 1000);
    await db.$transaction([
      db.campaignSend.update({ where: { id: claim.id }, data: { status: "failed", error } }),
      db.campaignLead.update({ where: { id: lead.id }, data: { status: "failed", reason: error, nextAt: null } }),
      db.mailLog.create({ data: { kind: "outreach", mailboxId: campaign.mailbox.id, toEmail: lead.email, subject: rendered.subject, status: "failed", error, createdBy: "campaign" } }),
    ]);
    // A mailbox problem (login, Gmail connection) would fail every e-mail: pause and say why.
    if (/login|auth|password|Gmail|reconnect|scope/i.test(error)) {
      await db.campaign.update({ where: { id: campaign.id }, data: { status: "paused", note: `Paused: the mailbox could not send (${error.slice(0, 200)})` } });
    }
    return "failed";
  }
}

/** Sends left "sending" by a crash: never re-sent automatically (the e-mail may have gone out). */
export async function recoverStaleSends(db: Db, now = new Date()): Promise<number> {
  const stale = await db.campaignSend.findMany({ where: { status: "sending", createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } }, select: { id: true, campaignLeadId: true } });
  for (const s of stale) {
    await db.$transaction([
      db.campaignSend.update({ where: { id: s.id }, data: { status: "failed", error: "Interrupted while sending: check the Sent folder before sending it again." } }),
      db.campaignLead.update({ where: { id: s.campaignLeadId }, data: { status: "failed", reason: "Interrupted while sending", nextAt: null } }),
    ]);
  }
  return stale.length;
}
