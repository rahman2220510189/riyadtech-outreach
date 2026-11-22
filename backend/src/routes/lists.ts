import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { errors } from "../lib/errors.js";
import { csvLine, MAX_IMPORT_ROWS, parseCsv, suggestMapping } from "../leads/csv.js";
import { importList, importSchema } from "../leads/lists.js";

export interface ListsRoutesOptions {
  db: Db;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const rowsQuery = z.object({
  status: z.enum(["ok", "suppressed", "duplicate"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Uploaded CSV files: preview (columns, first rows, suggested mapping), import, browse, export, delete. */
export const listsRoutes: FastifyPluginCallback<ListsRoutesOptions> = (app, { db }, done) => {
  app.addHook("preHandler", app.authenticate);

  const big = { bodyLimit: 7 * 1024 * 1024 };

  app.post("/preview", big, (request) => {
    const { text } = z.object({ text: z.string().min(1).max(6_000_000) }).parse(request.body);
    let csv;
    try {
      csv = parseCsv(text);
    } catch (err) {
      throw errors.badRequest((err as Error).message);
    }
    return {
      delimiter: csv.delimiter,
      headers: csv.headers,
      sample: csv.rows.slice(0, 10),
      rows: csv.rows.length,
      truncated: csv.truncated,
      maxRows: MAX_IMPORT_ROWS,
      suggested: suggestMapping(csv.headers, csv.rows),
    };
  });

  app.post("/", big, async (request, reply) => {
    const input = importSchema.parse(request.body);
    try {
      const out = await importList(db, input, request.admin?.email ?? null);
      void reply.status(201);
      return out;
    } catch (err) {
      if (err instanceof Error && /column|file|CSV/i.test(err.message)) throw errors.badRequest(err.message);
      throw err;
    }
  });

  app.get("/", async () => {
    const lists = await db.leadList.findMany({ orderBy: { id: "desc" }, take: 200 });
    return {
      items: lists.map((l) => ({
        id: Number(l.id),
        name: l.name,
        fileName: l.fileName,
        rowsTotal: l.rowsTotal,
        counts: l.counts,
        mapping: l.mapping,
        createdAt: l.createdAt,
      })),
    };
  });

  app.get("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const q = rowsQuery.parse(request.query);
    const list = await db.leadList.findUnique({ where: { id: BigInt(id) } });
    if (!list) throw errors.notFound("List not found");
    const where = {
      listId: list.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q.toLowerCase() } }, { company: { contains: q.q, mode: "insensitive" as const } }] } : {}),
    };
    const [total, rows, byStatus] = await Promise.all([
      db.listLead.count({ where }),
      db.listLead.findMany({ where, orderBy: { rowNumber: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.listLead.groupBy({ by: ["status"], where: { listId: list.id }, _count: { _all: true } }),
    ]);
    return {
      id: Number(list.id),
      name: list.name,
      fileName: list.fileName,
      rowsTotal: list.rowsTotal,
      counts: list.counts,
      mapping: list.mapping,
      createdAt: list.createdAt,
      now: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      items: rows.map((r) => ({ ...r, id: Number(r.id), listId: Number(r.listId), placeId: r.placeId ? Number(r.placeId) : null })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  /** The usable rows (status ok) as CSV, e.g. to check them in a spreadsheet. */
  app.get("/:id/export.csv", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const list = await db.leadList.findUnique({ where: { id: BigInt(id) } });
    if (!list) throw errors.notFound("List not found");
    const rows = await db.listLead.findMany({ where: { listId: list.id, status: "ok" }, orderBy: { rowNumber: "asc" } });
    const customKeys = [...new Set(rows.flatMap((r) => Object.keys((r.custom ?? {}) as Record<string, unknown>)))];
    const lines = [csvLine(["email", "first_name", "company", "website", "country", "city", ...customKeys])];
    for (const r of rows) {
      const c = (r.custom ?? {}) as Record<string, unknown>;
      lines.push(csvLine([r.email, r.firstName, r.company, r.website, r.country, r.city, ...customKeys.map((k) => c[k])]));
    }
    await db.auditLog.create({
      data: { actor: request.admin?.email ?? null, action: "list.export", entity: "lead_list", entityId: String(list.id), details: { rows: rows.length }, ip: request.ip },
    });
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header("content-disposition", `attachment; filename="list-${list.id}.csv"`);
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  });

  app.delete("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const list = await db.leadList.findUnique({ where: { id: BigInt(id) } });
    if (!list) throw errors.notFound("List not found");
    await db.$transaction([
      db.leadList.delete({ where: { id: list.id } }),
      db.auditLog.create({
        data: { actor: request.admin?.email ?? null, action: "list.delete", entity: "lead_list", entityId: String(list.id), details: { name: list.name }, ip: request.ip },
      }),
    ]);
    return { deleted: Number(list.id) };
  });

  done();
};
