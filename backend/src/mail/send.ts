import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import type { Mailbox } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { mailboxConfigs } from "../routes/mailboxes.js";
import { decryptSecret } from "./crypto.js";
import { gmailConfigured, sendGmail } from "./gmail.js";
import { type OutboxRef, queueMail } from "./outbox.js";
import { mailErrorText, newMessageId, type OutgoingMail, sendMail } from "./transport.js";

export type SendEnv = Pick<Env, "ENCRYPTION_KEY" | "MAIL_DELIVERY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "PUBLIC_BASE_URL">;

/** Is this mailbox connected to the Gmail API (and the server has the Google client)? */
export function usesGmail(m: Mailbox, env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">): boolean {
  return !!m.gmailRefreshTokenEnc && gmailConfigured(env);
}

/**
 * Hands one message to the mailbox's provider: the Gmail API when connected, otherwise SMTP.
 * Throws with a plain-words message on failure. Remembers Gmail connection problems on the mailbox.
 */
export async function transmit(db: Db, env: SendEnv, mailbox: Mailbox, mail: OutgoingMail): Promise<{ messageId: string; response: string }> {
  if (usesGmail(mailbox, env)) {
    try {
      const r = await sendGmail(env, decryptSecret(env.ENCRYPTION_KEY, mailbox.gmailRefreshTokenEnc!), mail);
      if (mailbox.gmailError) await db.mailbox.update({ where: { id: mailbox.id }, data: { gmailError: null } });
      return { messageId: mail.messageId, response: `Gmail API: accepted (id ${r.id})` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AppError && err.statusCode === 401) await db.mailbox.update({ where: { id: mailbox.id }, data: { gmailError: message.slice(0, 500) } });
      throw new MailSendError(message);
    }
  }
  const { smtp } = mailboxConfigs(mailbox, env.ENCRYPTION_KEY);
  try {
    const r = await sendMail(smtp, mail);
    if (r.rejected.length > 0 && r.accepted.length === 0) throw Object.assign(new Error(`The server refused ${r.rejected.join(", ")}: ${r.response}`), { code: "EENVELOPE" });
    return { messageId: r.messageId || mail.messageId, response: r.response };
  } catch (err) {
    throw new MailSendError(mailErrorText(err, "SMTP"));
  }
}

export class MailSendError extends Error {}

/**
 * Sends one e-mail outside campaigns (test or application) and writes it to mail_log.
 * A mailbox connected to Gmail sends over the Gmail API right away. Otherwise, with
 * MAIL_DELIVERY=outbox it is queued (ok, queued: true) and sent later by the outbox on my PC.
 */
export async function sendLogged(
  db: Db,
  env: SendEnv,
  input: {
    kind: "test" | "application" | "study";
    mailbox: Mailbox;
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: OutgoingMail["attachments"];
    actor: string | null;
    /** The record whose status follows a queued delivery. */
    ref?: OutboxRef;
  },
): Promise<{ ok: true; messageId: string; response: string; logId: bigint; queued?: boolean } | { ok: false; error: string; logId: bigint }> {
  if (!input.mailbox.active) throw new AppError(400, "MAILBOX_OFF", `The mailbox ${input.mailbox.fromEmail} is switched off`);
  const messageId = newMessageId(input.mailbox.fromEmail);
  const mail: OutgoingMail = {
    from: { name: input.mailbox.fromName, address: input.mailbox.fromEmail },
    to: input.to,
    replyTo: input.mailbox.replyTo ?? undefined,
    subject: input.subject,
    text: input.text,
    html: input.html,
    headers: input.headers,
    attachments: input.attachments,
    messageId,
  };
  if (env.MAIL_DELIVERY === "outbox" && !usesGmail(input.mailbox, env)) {
    const response = "Queued: it goes out when the outbox runs on your PC (npm run mail:outbox).";
    const log = await db.mailLog.create({
      data: { kind: input.kind, mailboxId: input.mailbox.id, toEmail: input.to, subject: input.subject, messageId, status: "queued", smtpResponse: response, createdBy: input.actor },
    });
    await queueMail(db, log.id, input.mailbox.id, mail, input.ref);
    return { ok: true, queued: true, messageId, response, logId: log.id };
  }
  // Missing passwords and similar setup problems throw (AppError) before anything is logged.
  if (!usesGmail(input.mailbox, env)) mailboxConfigs(input.mailbox, env.ENCRYPTION_KEY);
  try {
    const r = await transmit(db, env, input.mailbox, mail);
    const log = await db.mailLog.create({
      data: { kind: input.kind, mailboxId: input.mailbox.id, toEmail: input.to, subject: input.subject, messageId: r.messageId, status: "sent", smtpResponse: r.response.slice(0, 500), createdBy: input.actor },
    });
    return { ok: true, messageId: r.messageId, response: r.response, logId: log.id };
  } catch (err) {
    if (!(err instanceof MailSendError)) throw err;
    const error = err.message;
    const log = await db.mailLog.create({
      data: { kind: input.kind, mailboxId: input.mailbox.id, toEmail: input.to, subject: input.subject, status: "failed", error: error.slice(0, 1000), createdBy: input.actor },
    });
    return { ok: false, error, logId: log.id };
  }
}

/** Addresses "send test to myself" may use: the login, every mailbox's own addresses, and Settings → test addresses. */
export async function ownAddresses(db: Db, adminEmail: string | null | undefined, testAddresses: string[]): Promise<string[]> {
  const boxes = await db.mailbox.findMany({ select: { fromEmail: true, smtpUser: true, replyTo: true } });
  const all = [adminEmail, ...testAddresses, ...boxes.flatMap((b) => [b.fromEmail, b.smtpUser, b.replyTo])]
    .filter((x): x is string => !!x && x.includes("@"))
    .map((x) => x.trim().toLowerCase());
  return [...new Set(all)].sort();
}
