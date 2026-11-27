import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Db } from "../db/client.js";
import type { Mailbox } from "../generated/prisma/client.js";
import { refreshSuppressed } from "../leads/suppression.js";
import { decryptSecret } from "./crypto.js";
import { bounceRefs, classifyMessage, isDaemon, messageIds, newText, type ReplyKind } from "./replies.js";

/**
 * Phase 6: reading replies and bounces from the mailbox over IMAP, read-only.
 *
 * Only the Inbox is read, and only messages newer than the last check. For each new message the
 * tool first looks at its headers (sender, In-Reply-To, References); only a message that belongs
 * to a campaign e-mail (or comes from a mail server about one) is downloaded and saved. The tool
 * never deletes, moves or marks messages (the folder is opened read-only), so the mailbox looks
 * exactly as before.
 */

export interface HeaderInfo {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  ids: string[];
}

export interface InboxReader {
  open(): Promise<{ uidValidity: string; uidNext: number }>;
  /** Headers of messages with UID >= from (ascending). */
  headersFrom(from: number, limit: number): Promise<HeaderInfo[]>;
  /** Headers of messages received since a day (ascending). */
  headersSince(since: Date, limit: number): Promise<HeaderInfo[]>;
  source(uid: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ImapLogin {
  host: string;
  port: number;
  user: string;
  password: string;
}

let readerHook: ((login: ImapLogin) => InboxReader) | null = null;
/** Tests only: a fake inbox. */
export function setInboxTestHook(h: ((login: ImapLogin) => InboxReader) | null): void {
  readerHook = h;
}

function headerIds(buf: Buffer | undefined): string[] {
  return messageIds(buf?.toString("utf8") ?? "");
}

export function imapReader(login: ImapLogin): InboxReader {
  if (readerHook) return readerHook(login);
  const client = new ImapFlow({
    host: login.host,
    port: login.port,
    secure: login.port !== 143,
    auth: { user: login.user, pass: login.password },
    logger: false,
    tls: { minVersion: "TLSv1.2" },
  });
  const collect = async (range: string, limit: number): Promise<HeaderInfo[]> => {
    const out: HeaderInfo[] = [];
    for await (const m of client.fetch(range, { uid: true, envelope: true, headers: ["in-reply-to", "references"] }, { uid: true })) {
      out.push({
        uid: m.uid,
        from: (m.envelope?.from?.[0]?.address ?? "").toLowerCase(),
        subject: m.envelope?.subject ?? "",
        date: m.envelope?.date ? new Date(m.envelope.date) : new Date(),
        ids: headerIds(m.headers),
      });
    }
    return out.sort((a, b) => a.uid - b.uid).slice(0, limit);
  };
  return {
    async open() {
      await client.connect();
      const mb = await client.mailboxOpen("INBOX", { readOnly: true });
      return { uidValidity: String(mb.uidValidity), uidNext: mb.uidNext };
    },
    async headersFrom(from, limit) {
      return (await collect(`${from}:*`, limit + 1)).filter((h) => h.uid >= from).slice(0, limit);
    },
    async headersSince(since, limit) {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return [];
      return collect(uids.sort((a, b) => a - b).slice(0, limit).join(","), limit);
    },
    async source(uid) {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return m && m.source ? m.source : Buffer.alloc(0);
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

export function imapLogin(m: Mailbox, key: string | undefined): ImapLogin | null {
  const enc = m.imapSameAsSmtp ? m.smtpPasswordEnc : m.imapPasswordEnc;
  if (!enc) return null;
  return { host: m.imapHost, port: m.imapPort, user: m.imapUser, password: decryptSecret(key, enc) };
}

export interface InboxResult {
  checked: number;
  saved: number;
  byKind: Record<ReplyKind, number>;
  error: string | null;
}

const BATCH = 300;

export function imapErrorText(err: unknown): string {
  const e = err as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string };
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(`${e.responseText ?? ""} ${e.message ?? ""}`)) {
    return "IMAP login failed. In Gmail: Settings → Forwarding and POP/IMAP → Enable IMAP, and use an App Password (not your normal password) on the Mailboxes page.";
  }
  if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT") return `Could not reach the IMAP server (${e.code}).`;
  return `IMAP: ${(e.responseText ?? e.message ?? String(err)).slice(0, 300)}`;
}

/** Reads new messages of one mailbox and handles those that belong to a campaign. */
export async function checkInbox(db: Db, key: string | undefined, mailbox: Mailbox, now = new Date()): Promise<InboxResult> {
  const result: InboxResult = { checked: 0, saved: 0, byKind: { reply: 0, auto_reply: 0, unsubscribe: 0, bounce: 0 }, error: null };
  const login = imapLogin(mailbox, key);
  if (!login) {
    result.error = "No App Password saved for this mailbox: add it on the Mailboxes page so replies can be read.";
    await db.mailbox.update({ where: { id: mailbox.id }, data: { imapError: result.error, imapCheckedAt: now } });
    return result;
  }
  const firstSend = await db.campaignSend.findFirst({ where: { mailboxId: mailbox.id, status: "sent" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (!firstSend) return result; // nothing sent from this mailbox yet: nothing can come back

  const reader = imapReader(login);
  try {
    const box = await reader.open();
    const sameBox = mailbox.imapUidValidity === box.uidValidity && mailbox.imapLastUid !== null;
    const headers = sameBox
      ? await reader.headersFrom(mailbox.imapLastUid! + 1, BATCH)
      : await reader.headersSince(new Date(firstSend.createdAt.getTime() - 24 * 3600_000), BATCH);
    result.checked = headers.length;

    // Which of these belong to a campaign: answers to our Message-IDs, mail from a lead we wrote to, or mail servers.
    const ids = [...new Set(headers.flatMap((h) => h.ids))];
    const sends = ids.length
      ? await db.campaignSend.findMany({ where: { mailboxId: mailbox.id, messageId: { in: ids } }, select: { messageId: true, campaignLeadId: true } })
      : [];
    const bySendId = new Map(sends.map((s) => [s.messageId, s.campaignLeadId]));
    const froms = [...new Set(headers.map((h) => h.from).filter(Boolean))];
    const leads = froms.length
      ? await db.campaignLead.findMany({ where: { email: { in: froms }, step: { gt: 0 }, campaign: { mailboxId: mailbox.id } }, orderBy: { updatedAt: "desc" }, select: { id: true, email: true } })
      : [];
    const byFrom = new Map<string, bigint>();
    for (const l of leads) if (!byFrom.has(l.email)) byFrom.set(l.email, l.id);

    for (const h of headers) {
      let leadId = h.ids.map((id) => bySendId.get(id)).find((x) => x !== undefined) ?? byFrom.get(h.from) ?? null;
      const daemon = isDaemon(h.from);
      if (leadId === null && !daemon) continue;

      const parsed = await simpleParser(await reader.source(h.uid));
      const headerMap = new Map<string, string>();
      for (const [k, v] of parsed.headers) headerMap.set(k.toLowerCase(), typeof v === "string" ? v : JSON.stringify(v));
      const text = parsed.text ?? "";
      const kind = classifyMessage({
        from: h.from,
        subject: parsed.subject ?? h.subject,
        headers: headerMap,
        text,
        contentType: String((parsed.headers.get("content-type") as { value?: string } | undefined)?.value ?? ""),
      });

      if (kind === "bounce" && leadId === null) {
        // A bounce names the bounced e-mail inside its body (and attached headers).
        const refs = bounceRefs(`${text}\n${parsed.attachments.map((a) => a.content.toString("utf8")).join("\n")}`);
        const hit = refs.messageIds.length
          ? await db.campaignSend.findFirst({ where: { mailboxId: mailbox.id, messageId: { in: refs.messageIds } }, select: { campaignLeadId: true } })
          : null;
        const byRecipient = !hit && refs.recipients.length
          ? await db.campaignSend.findFirst({ where: { mailboxId: mailbox.id, toEmail: { in: refs.recipients } }, orderBy: { id: "desc" }, select: { campaignLeadId: true } })
          : null;
        leadId = hit?.campaignLeadId ?? byRecipient?.campaignLeadId ?? null;
      }
      if (leadId === null) continue; // not about a campaign e-mail: not saved

      // The message's own Message-ID is the key (the same message is never handled twice, even if the
      // mailbox's UIDs change); without one, its place in the mailbox.
      const key = parsed.messageId ? parsed.messageId.slice(0, 300) : `${box.uidValidity}:${h.uid}`;
      const saved = await saveReply(db, mailbox.id, leadId, key, {
        fromEmail: h.from,
        subject: (parsed.subject ?? h.subject).slice(0, 300),
        snippet: kind === "bounce" ? text.trim().slice(0, 600) : newText(text),
        kind,
        receivedAt: parsed.date ?? h.date,
      });
      if (saved) {
        result.saved++;
        result.byKind[kind]++;
      }
    }

    const last = headers.at(-1)?.uid ?? (sameBox ? mailbox.imapLastUid! : box.uidNext - 1);
    await db.mailbox.update({ where: { id: mailbox.id }, data: { imapUidValidity: box.uidValidity, imapLastUid: Math.max(last, mailbox.imapLastUid ?? 0, 0), imapCheckedAt: now, imapError: null } });
  } catch (err) {
    result.error = imapErrorText(err);
    await db.mailbox.update({ where: { id: mailbox.id }, data: { imapError: result.error, imapCheckedAt: now } });
  } finally {
    await reader.close().catch(() => undefined);
  }
  return result;
}

/**
 * Saves the message once and acts on it:
 * - reply: no more follow-ups to this lead
 * - unsubscribe ("no", "remove me"): suppression list + no more follow-ups
 * - bounce: suppression list (bounced) + the lead is marked bounced
 * - auto_reply: the next follow-up waits at least 7 days
 */
export async function saveReply(
  db: Db,
  mailboxId: bigint,
  leadId: bigint,
  imapKey: string,
  r: { fromEmail: string; subject: string; snippet: string; kind: ReplyKind; receivedAt: Date },
): Promise<boolean> {
  const lead = await db.campaignLead.findUnique({ where: { id: leadId } });
  if (!lead) return false;
  try {
    await db.reply.create({ data: { mailboxId, campaignLeadId: leadId, imapKey, ...r, done: r.kind === "auto_reply" || r.kind === "bounce" } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // already handled
    throw err;
  }
  if (r.kind === "reply") {
    await db.campaignLead.update({ where: { id: leadId }, data: { status: "replied", reason: "They replied", nextAt: null } });
  } else if (r.kind === "unsubscribe" || r.kind === "bounce") {
    const reason = r.kind === "bounce" ? "bounced" : "replied_no";
    await db.suppression.upsert({
      where: { kind_value: { kind: "email", value: lead.email } },
      create: { kind: "email", value: lead.email, reason, source: "imap", note: r.subject.slice(0, 200) },
      update: {},
    });
    await db.campaignLead.update({
      where: { id: leadId },
      data: { status: r.kind === "bounce" ? "bounced" : "stopped", reason: r.kind === "bounce" ? "The address bounced" : "They asked not to be e-mailed", nextAt: null },
    });
    await refreshSuppressed(db, [lead.placeId]);
  } else if (lead.status === "queued") {
    const later = new Date(r.receivedAt.getTime() + 7 * 24 * 3600_000);
    if (!lead.nextAt || lead.nextAt < later) await db.campaignLead.update({ where: { id: leadId }, data: { nextAt: later, reason: "Out of office: next e-mail waits a week" } });
  }
  return true;
}

/** Every mailbox that sent campaign e-mails is checked (the worker runs this every 5 minutes). */
export async function checkAllInboxes(db: Db, key: string | undefined, now = new Date()): Promise<InboxResult[]> {
  const boxes = await db.mailbox.findMany({ where: { active: true, campaigns: { some: {} } }, orderBy: { id: "asc" } });
  const out: InboxResult[] = [];
  for (const m of boxes) out.push(await checkInbox(db, key, m, now));
  return out;
}
