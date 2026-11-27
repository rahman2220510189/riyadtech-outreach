import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import { errors } from "../lib/errors.js";
import { checkAllInboxes } from "../mail/inbox.js";

export interface RepliesRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY">;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Replies to campaign e-mails (Phase 6): the list, "handled", and "check now". */
export const repliesRoutes: FastifyPluginCallback<RepliesRoutesOptions> = (app, { db, env }, done) => {
  app.addHook("preHandler", app.authenticate);

  const status = async () => {
    const boxes = await db.mailbox.findMany({ where: { campaigns: { some: {} } }, select: { id: true, fromEmail: true, imapCheckedAt: true, imapError: true }, orderBy: { id: "asc" } });
    const open = await db.reply.count({ where: { done: false } });
    return { open, mailboxes: boxes.map((b) => ({ id: Number(b.id), fromEmail: b.fromEmail, checkedAt: b.imapCheckedAt, error: b.imapError })) };
  };

  app.get("/", async (request) => {
    const q = z.object({ show: z.enum(["open", "all"]).default("open") }).parse(request.query);
    const rows = await db.reply.findMany({
      where: q.show === "open" ? { done: false } : {},
      orderBy: { receivedAt: "desc" },
      take: 200,
      include: { lead: { include: { place: { select: { name: true, websiteDomain: true } }, campaign: { select: { id: true, name: true } } } } },
    });
    return {
      ...(await status()),
      items: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        fromEmail: r.fromEmail,
        subject: r.subject,
        snippet: r.snippet,
        receivedAt: r.receivedAt,
        done: r.done,
        company: r.lead?.place.name ?? null,
        website: r.lead?.place.websiteDomain ?? null,
        campaignId: r.lead ? Number(r.lead.campaign.id) : null,
        campaign: r.lead?.campaign.name ?? null,
      })),
    };
  });

  app.post("/:id/done", async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ done: z.boolean().default(true) }).strict().parse(request.body ?? {});
    const r = await db.reply.findUnique({ where: { id: BigInt(id) } });
    if (!r) throw errors.notFound("Reply not found");
    await db.reply.update({ where: { id: r.id }, data: { done: b.done } });
    return { id, done: b.done };
  });

  app.post("/check", async () => {
    const results = await checkAllInboxes(db, env.ENCRYPTION_KEY);
    return { results, ...(await status()) };
  });

  done();
};
