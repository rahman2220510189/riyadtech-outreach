import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import type { Mailbox, Prisma } from "../generated/prisma/client.js";
import { AppError, errors } from "../lib/errors.js";
import { decryptSecret, encryptSecret } from "../mail/crypto.js";
import { authUrl, checkGmail, exchangeCode, gmailConfigured, makeState, readState, redirectUri, revokeGmail } from "../mail/gmail.js";
import { checkSendingDomain } from "../mail/dns-check.js";
import { type ImapConfig, mailErrorText, type SmtpConfig, verifyImap, verifySmtp } from "../mail/transport.js";
import { warmupAllowance } from "../mail/warmup.js";
import { resolveSettings } from "../settings/loader.js";

export interface MailboxesRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY" | "SENDING_ENABLED" | "MAIL_DELIVERY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "PUBLIC_BASE_URL" | "JWT_SECRET">;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const host = z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "a host name like smtp.gmail.com");
const email = z.email().transform((e) => e.trim().toLowerCase());

const fields = {
  label: z.string().trim().min(1).max(80),
  fromName: z.string().trim().min(1).max(80),
  fromEmail: email,
  replyTo: email.nullable().optional(),
  smtpHost: host,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: z.enum(["ssl", "starttls"]),
  smtpUser: z.string().trim().min(1).max(200),
  imapHost: host,
  imapPort: z.number().int().min(1).max(65535),
  imapUser: z.string().trim().min(1).max(200),
  imapSameAsSmtp: z.boolean(),
  dailyCap: z.number().int().min(1).max(500),
  dkimSelector: z.string().trim().regex(/^[a-z0-9._-]{1,63}$/i).nullable().optional(),
  active: z.boolean(),
  /** Only sent to set or change it; never returned. Empty string = keep the saved one. */
  smtpPassword: z.string().max(500).optional(),
  imapPassword: z.string().max(500).optional(),
};
const createSchema = z.object(fields).partial({ replyTo: true, dkimSelector: true, active: true, dailyCap: true, smtpPassword: true, imapPassword: true }).strict();
const updateSchema = z.object(fields).partial().strict();

/** The mailbox as the API shows it: passwords only as "set / not set". */
export function publicMailbox(m: Mailbox, sending: Parameters<typeof warmupAllowance>[1]) {
  return {
    id: Number(m.id),
    label: m.label,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    replyTo: m.replyTo,
    smtpHost: m.smtpHost,
    smtpPort: m.smtpPort,
    smtpSecurity: m.smtpSecurity,
    smtpUser: m.smtpUser,
    smtpPasswordSet: !!m.smtpPasswordEnc,
    imapHost: m.imapHost,
    imapPort: m.imapPort,
    imapUser: m.imapUser,
    imapSameAsSmtp: m.imapSameAsSmtp,
    imapPasswordSet: m.imapSameAsSmtp ? !!m.smtpPasswordEnc : !!m.imapPasswordEnc,
    dailyCap: m.dailyCap,
    warmupStartedOn: m.warmupStartedOn.toISOString().slice(0, 10),
    allowedToday: warmupAllowance(m, sending),
    dkimSelector: m.dkimSelector,
    active: m.active,
    lastTestAt: m.lastTestAt,
    lastTest: m.lastTest,
    lastDnsAt: m.lastDnsAt,
    lastDns: m.lastDns,
    gmailConnected: !!m.gmailRefreshTokenEnc,
    gmailConnectedAt: m.gmailConnectedAt,
    gmailError: m.gmailError,
    createdAt: m.createdAt,
  };
}

/** SMTP/IMAP settings with the decrypted passwords (server side only). */
export function mailboxConfigs(m: Mailbox, key: string | undefined): { smtp: SmtpConfig; imap: ImapConfig } {
  if (!m.smtpPasswordEnc) throw new AppError(400, "NO_PASSWORD", `Enter the SMTP password (Gmail: an App Password) for ${m.fromEmail} first`);
  const smtpPassword = decryptSecret(key, m.smtpPasswordEnc);
  const imapPassword = m.imapSameAsSmtp ? smtpPassword : m.imapPasswordEnc ? decryptSecret(key, m.imapPasswordEnc) : "";
  return {
    smtp: { host: m.smtpHost, port: m.smtpPort, security: m.smtpSecurity as "ssl" | "starttls", user: m.smtpUser, password: smtpPassword },
    imap: { host: m.imapHost, port: m.imapPort, user: m.imapUser, password: imapPassword },
  };
}

/** Mailboxes: add/edit (passwords encrypted), test login (no e-mail sent), DNS check of the sending domain. */
export const mailboxesRoutes: FastifyPluginCallback<MailboxesRoutesOptions> = (app, { db, env }, done) => {
  app.addHook("preHandler", app.authenticate);
  const sending = async () => resolveSettings(await db.setting.findMany()).settings.sending;
  const audit = (request: { admin?: { email: string } | null; ip: string }, action: string, id: bigint, details: Prisma.InputJsonObject) =>
    db.auditLog.create({ data: { actor: request.admin?.email ?? null, action, entity: "mailbox", entityId: String(id), details, ip: request.ip } });
  const find = async (id: number) => {
    const m = await db.mailbox.findUnique({ where: { id: BigInt(id) } });
    if (!m) throw errors.notFound("Mailbox not found");
    return m;
  };

  app.get("/", async () => {
    const s = await sending();
    const rows = await db.mailbox.findMany({ orderBy: { id: "asc" } });
    return {
      items: rows.map((m) => publicMailbox(m, s)),
      sendingEnabled: env.SENDING_ENABLED,
      encryptionKeySet: !!env.ENCRYPTION_KEY,
      mailDelivery: env.MAIL_DELIVERY,
      gmail: { available: gmailConfigured(env), redirectUri: redirectUri(env) },
    };
  });

  app.post("/", async (request, reply) => {
    const b = createSchema.parse(request.body);
    if (await db.mailbox.findUnique({ where: { fromEmail: b.fromEmail } })) throw errors.conflict(`A mailbox for ${b.fromEmail} exists already`);
    const { smtpPassword, imapPassword, ...rest } = b;
    const m = await db.mailbox.create({
      data: {
        ...rest,
        replyTo: rest.replyTo ?? null,
        dkimSelector: rest.dkimSelector ?? null,
        smtpPasswordEnc: smtpPassword ? encryptSecret(env.ENCRYPTION_KEY, smtpPassword) : null,
        imapPasswordEnc: !b.imapSameAsSmtp && imapPassword ? encryptSecret(env.ENCRYPTION_KEY, imapPassword) : null,
      },
    });
    await audit(request, "mailbox.create", m.id, { fromEmail: m.fromEmail, smtpHost: m.smtpHost, passwordSet: !!smtpPassword });
    void reply.status(201);
    return publicMailbox(m, await sending());
  });

  app.patch("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const before = await find(id);
    const b = updateSchema.parse(request.body);
    const { smtpPassword, imapPassword, ...rest } = b;
    if (rest.fromEmail && rest.fromEmail !== before.fromEmail && (await db.mailbox.findUnique({ where: { fromEmail: rest.fromEmail } }))) {
      throw errors.conflict(`A mailbox for ${rest.fromEmail} exists already`);
    }
    const data: Prisma.MailboxUpdateInput = { ...rest };
    if (smtpPassword) data.smtpPasswordEnc = encryptSecret(env.ENCRYPTION_KEY, smtpPassword);
    if (imapPassword) data.imapPasswordEnc = encryptSecret(env.ENCRYPTION_KEY, imapPassword);
    if (rest.imapSameAsSmtp === true) data.imapPasswordEnc = null;
    const m = await db.mailbox.update({ where: { id: before.id }, data });
    const changed = Object.keys(b).filter((k) => !k.endsWith("Password"));
    await audit(request, "mailbox.update", m.id, { changed, ...(smtpPassword ? { smtpPassword: "changed" } : {}), ...(imapPassword ? { imapPassword: "changed" } : {}) });
    return publicMailbox(m, await sending());
  });

  app.delete("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const m = await find(id);
    await db.mailbox.delete({ where: { id: m.id } });
    await audit(request, "mailbox.delete", m.id, { fromEmail: m.fromEmail });
    return { deleted: id };
  });

  /** Logs in to SMTP and IMAP; sends nothing. */
  app.post("/:id/test", async (request) => {
    const { id } = idParam.parse(request.params);
    const m = await find(id);
    const { smtp, imap } = mailboxConfigs(m, env.ENCRYPTION_KEY);
    const check = async (what: "SMTP" | "IMAP" | "Gmail API", fn: () => Promise<void>) => {
      const started = Date.now();
      try {
        await fn();
        return { ok: true, message: `${what} login worked (${Date.now() - started} ms)` };
      } catch (err) {
        return { ok: false, message: what === "Gmail API" ? (err instanceof Error ? err.message : String(err)) : mailErrorText(err, what) };
      }
    };
    const result = {
      ...(m.gmailRefreshTokenEnc && gmailConfigured(env)
        ? {
            gmail: await check("Gmail API", async () => {
              await checkGmail(env, decryptSecret(env.ENCRYPTION_KEY, m.gmailRefreshTokenEnc!));
            }),
          }
        : {}),
      // On a host that blocks SMTP the check would always time out; the outbox on my PC sends instead.
      smtp:
        env.MAIL_DELIVERY === "outbox"
          ? { ok: true, message: "SMTP is not checked here: this server sends through the outbox on your PC (npm run mail:outbox). Test the mailbox there, or send a test e-mail." }
          : await check("SMTP", () => verifySmtp(smtp)),
      imap: imap.password ? await check("IMAP", () => verifyImap(imap)) : { ok: false, message: "IMAP password not set" },
      at: new Date().toISOString(),
    };
    await db.mailbox.update({ where: { id: m.id }, data: { lastTestAt: new Date(), lastTest: result } });
    return result;
  });

  /* ------------------------- Gmail API (send over HTTPS) ------------------------- */

  /** The Google sign-in address for this mailbox (the browser goes there). */
  app.post("/:id/gmail/start", async (request) => {
    const { id } = idParam.parse(request.params);
    const m = await find(id);
    if (!gmailConfigured(env)) throw new AppError(400, "GMAIL_NOT_SET", "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on the server yet");
    return { url: authUrl(env, makeState(env.JWT_SECRET, m.id), m.fromEmail) };
  });

  /** Google sends the browser back here; the result is shown on the Mailboxes page. */
  app.get("/gmail/callback", async (request, reply) => {
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(300).default(""), error: z.string().max(200).optional() }).parse(request.query);
    const back = (params: Record<string, string>) => reply.redirect(`${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/mailboxes?${new URLSearchParams(params).toString()}`);
    const mailboxId = readState(env.JWT_SECRET, q.state);
    if (!mailboxId) return back({ gmail: "error", reason: "The sign-in link expired or is not valid. Press “Connect Gmail” again." });
    if (q.error || !q.code) return back({ gmail: "error", reason: q.error === "access_denied" ? "Access was not granted on Google's page (or your organisation's admin blocks this app)." : `Google: ${q.error ?? "no code"}` });
    const m = await db.mailbox.findUnique({ where: { id: mailboxId } });
    if (!m) return back({ gmail: "error", reason: "The mailbox no longer exists." });
    try {
      const t = await exchangeCode(env, q.code);
      if (t.email && t.email !== m.fromEmail.toLowerCase()) {
        await revokeGmail(t.refreshToken);
        return back({ gmail: "error", reason: `You signed in as ${t.email}, but this mailbox sends as ${m.fromEmail}. Choose that account on Google's page.` });
      }
      await db.mailbox.update({ where: { id: m.id }, data: { gmailRefreshTokenEnc: encryptSecret(env.ENCRYPTION_KEY, t.refreshToken), gmailConnectedAt: new Date(), gmailError: null } });
      await audit(request, "mailbox.gmail_connected", m.id, { fromEmail: m.fromEmail });
      return back({ gmail: "connected", mailbox: m.fromEmail });
    } catch (err) {
      return back({ gmail: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/:id/gmail/disconnect", async (request) => {
    const { id } = idParam.parse(request.params);
    const m = await find(id);
    if (m.gmailRefreshTokenEnc) await revokeGmail(decryptSecret(env.ENCRYPTION_KEY, m.gmailRefreshTokenEnc));
    const u = await db.mailbox.update({ where: { id: m.id }, data: { gmailRefreshTokenEnc: null, gmailConnectedAt: null, gmailError: null } });
    await audit(request, "mailbox.gmail_disconnected", m.id, { fromEmail: m.fromEmail });
    return publicMailbox(u, await sending());
  });

  app.post("/:id/dns", async (request) => {
    const { id } = idParam.parse(request.params);
    const m = await find(id);
    const result = await checkSendingDomain({ fromEmail: m.fromEmail, smtpHost: m.smtpHost, dkimSelector: m.dkimSelector });
    await db.mailbox.update({ where: { id: m.id }, data: { lastDnsAt: new Date(), lastDns: result as unknown as Prisma.InputJsonObject } });
    return result;
  });

  done();
};
