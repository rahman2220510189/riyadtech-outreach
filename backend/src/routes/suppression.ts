import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AppError, errors } from "../lib/errors.js";
import { parseSuppressionList, refreshSuppressed, SUPPRESSION_REASONS, suppressionTarget } from "../leads/suppression.js";

export interface SuppressionRoutesOptions {
  db: Db;
}

const reason = z.enum(SUPPRESSION_REASONS);
const listQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  reason: reason.optional(),
  kind: z.enum(["email", "domain"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
const addBody = z.object({ value: z.string().trim().min(3).max(320), reason, note: z.string().trim().max(500).optional() });
const importBody = z.object({ text: z.string().min(1).max(2_000_000), reason, note: z.string().trim().max(500).optional() });

/**
 * The suppression list: addresses and whole domains that are never contacted.
 * Every change is audited and immediately applied to the leads and imported lists.
 */
export const suppressionRoutes: FastifyPluginCallback<SuppressionRoutesOptions> = (app, { db }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const q = listQuery.parse(request.query);
    const where = {
      ...(q.q ? { value: { contains: q.q.toLowerCase() } } : {}),
      ...(q.reason ? { reason: q.reason } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    };
    const [total, rows, byReason] = await Promise.all([
      db.suppression.count({ where }),
      db.suppression.findMany({ where, orderBy: { id: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.suppression.groupBy({ by: ["reason"], _count: { _all: true } }),
    ]);
    return {
      items: rows.map((r) => ({ ...r, id: Number(r.id) })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      byReason: Object.fromEntries(byReason.map((r) => [r.reason, r._count._all])),
    };
  });

  app.post("/", async (request, reply) => {
    const body = addBody.parse(request.body);
    const target = suppressionTarget(body.value);
    if (!target) throw errors.badRequest("Enter an e-mail address or a domain (acme.com)");
    const existing = await db.suppression.findUnique({ where: { kind_value: target } });
    if (existing) throw new AppError(409, "ALREADY_SUPPRESSED", `${target.value} is already on the list (${existing.reason})`);
    const actor = request.admin?.email ?? null;
    const row = await db.$transaction(async (tx) => {
      const r = await tx.suppression.create({ data: { ...target, reason: body.reason, source: "manual", note: body.note ?? null, createdBy: actor } });
      await tx.auditLog.create({
        data: { actor, action: "suppression.add", entity: "suppression", entityId: String(r.id), details: { ...target, reason: body.reason }, ip: request.ip },
      });
      return r;
    });
    const affected = await refreshSuppressed(db);
    void reply.status(201);
    return { item: { ...row, id: Number(row.id) }, affected };
  });

  app.post("/import", { bodyLimit: 3 * 1024 * 1024 }, async (request) => {
    const body = importBody.parse(request.body);
    const { targets, invalid } = parseSuppressionList(body.text);
    if (targets.length === 0) throw errors.badRequest("No e-mail address or domain found in the text", { invalid });
    const actor = request.admin?.email ?? null;
    let added = 0;
    for (let i = 0; i < targets.length; i += 1000) {
      const res = await db.suppression.createMany({
        data: targets.slice(i, i + 1000).map((t) => ({ ...t, reason: body.reason, source: "import", note: body.note ?? null, createdBy: actor })),
        skipDuplicates: true,
      });
      added += res.count;
    }
    await db.auditLog.create({
      data: {
        actor,
        action: "suppression.import",
        entity: "suppression",
        details: { found: targets.length, added, alreadyListed: targets.length - added, invalid: invalid.length, reason: body.reason },
        ip: request.ip,
      },
    });
    const affected = await refreshSuppressed(db);
    return { found: targets.length, added, alreadyListed: targets.length - added, invalid, affected };
  });

  app.delete("/:id", async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const row = await db.suppression.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw errors.notFound("Not on the list");
    await db.$transaction([
      db.suppression.delete({ where: { id: row.id } }),
      db.auditLog.create({
        data: {
          actor: request.admin?.email ?? null,
          action: "suppression.remove",
          entity: "suppression",
          entityId: String(row.id),
          details: { kind: row.kind, value: row.value, reason: row.reason },
          ip: request.ip,
        },
      }),
    ]);
    const affected = await refreshSuppressed(db);
    return { removed: row.value, affected };
  });

  done();
};
