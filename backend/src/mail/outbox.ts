import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { mailboxConfigs } from "../routes/mailboxes.js";
import { mailErrorText, type OutgoingMail, sendMail } from "./transport.js";

/**
 * The outbox: on a host whose free plan blocks SMTP (Render), e-mails are not sent by the server
 * but wait here; `npm run mail:outbox` on my PC (same database, same ENCRYPTION_KEY) sends them
 * through the mailbox's own SMTP server and writes back what happened. Nothing is sent twice:
 * a row is claimed (queued → sending) before the SMTP call, and a row left "sending" by a stopped
 * PC is marked failed, never sent again automatically (the message may have gone out).
 */

export type OutboxRef = { kind: "study_email" | "application"; id: bigint };

interface StoredAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

export async function queueMail(db: Db, logId: bigint, mailboxId: bigint, mail: OutgoingMail, ref?: OutboxRef): Promise<void> {
  const { attachments, ...message } = mail;
  const stored: StoredAttachment[] = (attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, base64: a.content.toString("base64") }));
  await db.mailOutbox.create({
    data: {
      mailLogId: logId,
      mailboxId,
      message: message,
      attachments: stored as unknown as Prisma.InputJsonValue,
      refKind: ref?.kind ?? null,
      refId: ref?.id ?? null,
    },
  });
}

/** Message-IDs (of the given ones) still waiting in the outbox. */
export async function waitingMessageIds(db: Db, ids: (string | null)[]): Promise<Set<string>> {
  const list = ids.filter((x): x is string => !!x);
  if (list.length === 0) return new Set();
  const rows = await db.mailLog.findMany({ where: { messageId: { in: list }, status: "queued" }, select: { messageId: true } });
  return new Set(rows.map((r) => r.messageId!));
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  interrupted: number;
  lines: string[];
}

const STALE_MS = 15 * 60_000;

async function fail(db: Db, row: { id: bigint; mailLogId: bigint; refKind: string | null; refId: bigint | null }, error: string): Promise<void> {
  const e = error.slice(0, 1000);
  await db.$transaction([
    db.mailOutbox.update({ where: { id: row.id }, data: { status: "failed", error: e } }),
    db.mailLog.update({ where: { id: row.mailLogId }, data: { status: "failed", error: e } }),
    ...(row.refKind === "study_email" && row.refId ? [db.studyEmail.updateMany({ where: { id: row.refId }, data: { status: "failed", sentAt: null, error: e } })] : []),
    ...(row.refKind === "application" && row.refId ? [db.application.updateMany({ where: { id: row.refId }, data: { status: "failed", sentAt: null, error: e } })] : []),
  ]);
}

/** Sends what waits in the outbox (oldest first), at most `limit` per call. */
export async function deliverOutbox(db: Db, env: Pick<Env, "ENCRYPTION_KEY">, opts: { limit?: number; now?: Date } = {}): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const out: DeliveryResult = { sent: 0, failed: 0, interrupted: 0, lines: [] };

  // A row left "sending" by a PC that stopped mid-way: the e-mail may have gone out, so it is not retried.
  const stale = await db.mailOutbox.findMany({ where: { status: "sending", claimedAt: { lt: new Date(now.getTime() - STALE_MS) } }, select: { id: true, mailLogId: true, refKind: true, refId: true } });
  for (const row of stale) {
    await fail(db, row, "Interrupted while sending (the PC stopped). Check the mailbox's Sent folder; if it is not there, send it again.");
    out.interrupted++;
  }

  const claimed = await db.$queryRaw<{ id: bigint }[]>`
    UPDATE mail_outbox SET status = 'sending', claimed_at = ${now}, attempts = attempts + 1
    WHERE id IN (SELECT id FROM mail_outbox WHERE status = 'queued' ORDER BY id LIMIT ${opts.limit ?? 20} FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  for (const { id } of claimed.sort((a, b) => Number(a.id - b.id))) {
    const row = await db.mailOutbox.findUniqueOrThrow({ where: { id }, include: { mailbox: true } });
    const msg = row.message as unknown as Omit<OutgoingMail, "attachments">;
    try {
      if (!row.mailbox.active) throw new Error(`The mailbox ${row.mailbox.fromEmail} is switched off`);
      const { smtp } = mailboxConfigs(row.mailbox, env.ENCRYPTION_KEY);
      const attachments = (row.attachments as unknown as StoredAttachment[]).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.base64, "base64") }));
      const r = await sendMail(smtp, { ...msg, attachments });
      if (r.rejected.length > 0 && r.accepted.length === 0) throw Object.assign(new Error(`The server refused ${r.rejected.join(", ")}: ${r.response}`), { code: "EENVELOPE" });
      const response = r.response.slice(0, 500);
      await db.$transaction([
        db.mailOutbox.update({ where: { id }, data: { status: "sent", sentAt: new Date(), error: null, attachments: [] } }),
        db.mailLog.update({ where: { id: row.mailLogId }, data: { status: "sent", smtpResponse: response, error: null } }),
        ...(row.refKind === "application" && row.refId ? [db.application.updateMany({ where: { id: row.refId }, data: { smtpResponse: response } })] : []),
      ]);
      out.sent++;
      out.lines.push(`sent    ${msg.subject} → ${msg.to}`);
    } catch (err) {
      const error = err instanceof Error && /switched off/.test(err.message) ? err.message : mailErrorText(err, "SMTP");
      await fail(db, row, error);
      out.failed++;
      out.lines.push(`FAILED  ${msg.subject} → ${msg.to}: ${error}`);
    }
  }
  return out;
}
