import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { AppError, errors } from "../lib/errors.js";
import { defaultSettings, SETTINGS_KEYS, type SettingsKey, settingsSchemas } from "../settings/definitions.js";
import { resolveSettings } from "../settings/loader.js";

export interface SettingsRoutesOptions {
  db: Db;
}

/** Keys the Settings page may change now; the others arrive with their phase. */
export const EDITABLE_KEYS: readonly SettingsKey[] = ["company", "sending", "crawler", "scores", "finder", "storage", "study"];

const keyParam = z.object({ key: z.enum(SETTINGS_KEYS as [SettingsKey, ...SettingsKey[]]) });

/**
 * Settings (one row per key). PATCH merges the given fields over the current value,
 * validates the result, and writes the change to the audit log. The worker picks it
 * up within a minute.
 */
export const settingsRoutes: FastifyPluginCallback<SettingsRoutesOptions> = (app, { db }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => {
    const { settings, problems } = resolveSettings(await db.setting.findMany());
    return { values: settings, defaults: defaultSettings(), editable: EDITABLE_KEYS, problems };
  });

  app.patch("/:key", async (request) => {
    const { key } = keyParam.parse(request.params);
    if (!EDITABLE_KEYS.includes(key)) throw new AppError(400, "NOT_EDITABLE", `Settings "${key}" are not editable yet`);
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      throw errors.badRequest("Send the fields to change as a JSON object");
    }
    const current = resolveSettings(await db.setting.findMany()).settings[key];
    const merged = { ...(current as Record<string, unknown>), ...(request.body as Record<string, unknown>) };
    const value = settingsSchemas[key].parse(merged);
    const changed = Object.keys(request.body).filter(
      (k) => JSON.stringify((current as Record<string, unknown>)[k]) !== JSON.stringify((value as Record<string, unknown>)[k]),
    );
    if (changed.length === 0) return { key, value, changed };
    await db.$transaction([
      db.setting.upsert({ where: { key }, create: { key, value }, update: { value } }),
      db.auditLog.create({
        data: {
          actor: request.admin?.email ?? null,
          action: "settings.update",
          entity: "settings",
          entityId: key,
          details: {
            changed,
            before: Object.fromEntries(changed.map((k) => [k, (current as Record<string, unknown>)[k] ?? null])),
            after: Object.fromEntries(changed.map((k) => [k, (value as Record<string, unknown>)[k] ?? null])),
          },
          ip: request.ip,
        },
      }),
    ]);
    return { key, value, changed };
  });

  done();
};
