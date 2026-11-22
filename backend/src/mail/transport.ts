import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

/**
 * Talking to mail servers: SMTP (send, verify login) through nodemailer, IMAP (verify login)
 * through imapflow. Both are pure JavaScript. Tests replace them with fakes (setMailTestHooks).
 */

export interface SmtpConfig {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  user: string;
  password: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface OutgoingMail {
  from: { name: string; address: string };
  to: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  headers?: Record<string, string> | undefined;
  attachments?: { filename: string; content: Buffer; contentType: string }[] | undefined;
  /** Our own Message-ID (kept for threading follow-ups and matching replies later). */
  messageId: string;
}

export interface SendResult {
  messageId: string;
  response: string;
  accepted: string[];
  rejected: string[];
}

export interface MailHooks {
  verifySmtp?: (c: SmtpConfig) => Promise<void>;
  verifyImap?: (c: ImapConfig) => Promise<void>;
  send?: (c: SmtpConfig, m: OutgoingMail) => Promise<SendResult>;
}
let hooks: MailHooks = {};
/** Tests only: accept the self-signed certificate of a local fake SMTP server. */
let acceptSelfSignedForTests = false;
export function setMailTestHooks(h: MailHooks, opts: { acceptSelfSigned?: boolean } = {}): void {
  hooks = h;
  acceptSelfSignedForTests = opts.acceptSelfSigned ?? false;
}

function smtpOptions(c: SmtpConfig): SMTPTransport.Options {
  return {
    host: c.host,
    port: c.port,
    secure: c.security === "ssl",
    requireTLS: c.security === "starttls",
    auth: { user: c.user, pass: c.password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    tls: { minVersion: "TLSv1.2", ...(acceptSelfSignedForTests ? { rejectUnauthorized: false } : {}) },
  };
}

/** Plain words for the usual SMTP/IMAP failures. */
export function mailErrorText(err: unknown, what: "SMTP" | "IMAP"): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string; authenticationFailed?: boolean };
  const raw = (e.response ?? e.message ?? String(err)).replace(/\s+/g, " ").slice(0, 200);
  if (e.code === "EAUTH" || e.authenticationFailed || e.responseCode === 535 || /AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted/i.test(raw)) {
    return `${what} login failed: wrong user name or password. Gmail needs a 16-character App Password here, not your normal password. (${raw})`;
  }
  if (e.code === "ENOTFOUND" || e.code === "EDNS") return `${what} server not found: check the host name. (${raw})`;
  if (e.code === "ECONNREFUSED") return `${what} server refused the connection: check the port. (${raw})`;
  if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || /timeout/i.test(raw)) return `${what} server did not answer in time: check host, port and security. (${raw})`;
  if (e.code === "ESOCKET" || /wrong version number|ssl|tls/i.test(raw)) return `${what} encryption problem: try SSL with port 465 or STARTTLS with port 587. (${raw})`;
  return `${what}: ${raw}`;
}

export async function verifySmtp(c: SmtpConfig): Promise<void> {
  if (hooks.verifySmtp) return hooks.verifySmtp(c);
  const t = nodemailer.createTransport(smtpOptions(c));
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

export async function verifyImap(c: ImapConfig): Promise<void> {
  if (hooks.verifyImap) return hooks.verifyImap(c);
  const client = new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.port !== 143,
    auth: { user: c.user, pass: c.password },
    logger: false,
    verifyOnly: true,
    tls: { minVersion: "TLSv1.2" },
  });
  await client.connect();
  try {
    await client.logout();
  } catch {
    /* verifyOnly may already have closed the connection */
  }
}

export async function sendMail(c: SmtpConfig, m: OutgoingMail): Promise<SendResult> {
  if (hooks.send) return hooks.send(c, m);
  const t = nodemailer.createTransport(smtpOptions(c));
  try {
    const info = await t.sendMail({
      from: m.from,
      to: m.to,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      subject: m.subject,
      text: m.text,
      headers: m.headers ?? {},
      messageId: m.messageId,
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return {
      messageId: info.messageId,
      response: String(info.response ?? ""),
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } finally {
    t.close();
  }
}

/** A Message-ID on the sending domain ("<random@riyadtech.xyz>"). */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  return `<${Date.now().toString(36)}.${crypto.randomUUID()}@${domain}>`;
}
