import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import { refreshSuppressed } from "../leads/suppression.js";
import { errors } from "../lib/errors.js";
import { readUnsubscribeToken } from "../mail/crypto.js";

export interface UnsubscribeRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY">;
}

const tokenParam = z.object({ token: z.string().min(10).max(600) });

/** "s***@acme.com": enough to recognise the address, not to read it off a shared screen. */
function mask(email: string): string {
  const [local, domain] = email.split("@");
  return `${local!.slice(0, 1)}***@${domain}`;
}

/**
 * Public unsubscribe (no login): GET tells the page which address the link is for,
 * POST adds it to the suppression list at once. POST also serves the one-click
 * List-Unsubscribe-Post of mail programs (RFC 8058), which sends a form body.
 */
export const unsubscribeRoutes: FastifyPluginCallback<UnsubscribeRoutesOptions> = (app, { db, env }, done) => {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, next) => next(null, body));

  const read = (token: string) => {
    const email = readUnsubscribeToken(env.ENCRYPTION_KEY, token);
    if (!email) throw errors.notFound("This unsubscribe link is not valid. Reply to the e-mail with “unsubscribe” instead.");
    return email;
  };

  app.get("/:token", async (request) => {
    const email = read(tokenParam.parse(request.params).token);
    const done = await db.suppression.findUnique({ where: { kind_value: { kind: "email", value: email } } });
    return { email: mask(email), unsubscribed: !!done };
  });

  app.post("/:token", async (request) => {
    const email = read(tokenParam.parse(request.params).token);
    const existing = await db.suppression.findUnique({ where: { kind_value: { kind: "email", value: email } } });
    if (!existing) {
      await db.suppression.create({ data: { kind: "email", value: email, reason: "unsubscribed", source: "unsubscribe_link", createdBy: null } });
      await db.auditLog.create({ data: { actor: null, action: "suppression.unsubscribe", entity: "suppression", entityId: email, details: { via: "link" }, ip: request.ip } });
      await refreshSuppressed(db);
    }
    return { email: mask(email), unsubscribed: true };
  });

  done();
};
