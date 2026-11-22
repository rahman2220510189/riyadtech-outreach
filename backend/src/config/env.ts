import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 * Secrets live only in backend/.env (local) or the hosting provider's Environment page.
 */

const booleanFromString = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const originList = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter((o) => o.length > 0),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1));

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/[^\s]+$/, "must be a postgresql:// connection string");

/** ENCRYPTION_KEY as 32 bytes, or null when it is not 64 hex characters or base64 of 32 bytes. */
export function keyBytes(value: string): Buffer | null {
  const v = value.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return b.length === 32 ? b : null;
  }
  return null;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TRUST_PROXY: booleanFromString.default(false),
    CORS_ORIGIN: originList.default(["http://localhost:3000"]),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
    /** Neon POOLED connection (host contains "-pooler"): used by the app at runtime. */
    DATABASE_URL: postgresUrl,
    /** Neon DIRECT connection (no "-pooler"): used only for migrations (prisma.config.ts) and checks. */
    DIRECT_URL: postgresUrl.optional(),
    /** Max connections in this process's pool. Neon free plan: keep small. */
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    /** Signs the login cookie. At least 32 random characters; different per environment. */
    JWT_SECRET: z.string().min(32, "must be at least 32 characters (use a long random string)"),
    /** How long a login lasts. */
    SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    /** Overture Maps STAC catalog (lists the data files of each release). */
    OVERTURE_STAC_URL: z.url({ protocol: /^https?$/ }).default("https://stac.overturemaps.org"),
    /** GeoNames download folder (cities5000.zip, admin1CodesASCII.txt). */
    GEONAMES_BASE_URL: z.url({ protocol: /^https?$/ }).default("https://download.geonames.org/export/dump"),
    /** Local cache for downloaded data indexes (Parquet footers). Inside backend/data, which git ignores. */
    DATA_CACHE_DIR: z.string().min(1).default("data/cache"),
    /**
     * 32 random bytes (64 hex characters or base64) that encrypt mailbox passwords and sign
     * unsubscribe links. Changing it makes stored passwords unreadable and old unsubscribe links invalid.
     */
    ENCRYPTION_KEY: z
      .string()
      .trim()
      .refine((v) => keyBytes(v) !== null, "must be 32 random bytes as 64 hex characters or base64 (see .env.example)")
      .optional(),
    /** Groq API key (starts with gsk_) for drafting study e-mails. Optional: without it, e-mails are written by hand. */
    GROQ_API_KEY: z.string().trim().min(10).optional(),
    /** Groq model for drafts; a production model (see console.groq.com/docs/models). */
    GROQ_MODEL: z.string().trim().min(3).default("openai/gpt-oss-120b"),
    /** false (default): campaigns only fill the Outbox preview and applications are not sent. */
    SENDING_ENABLED: booleanFromString.default(false),
    /** Set automatically by Render on hosted services. */
    RENDER: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (env.CORS_ORIGIN.some((o) => o.startsWith("http://localhost"))) {
        ctx.addIssue({
          code: "custom",
          path: ["CORS_ORIGIN"],
          message: "CORS_ORIGIN must be set to the real frontend origin in production",
        });
      }
      if (/change-me|example|secret/i.test(env.JWT_SECRET)) {
        ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "looks like a placeholder; generate a real random value" });
      }
      if (!env.ENCRYPTION_KEY) {
        ctx.addIssue({ code: "custom", path: ["ENCRYPTION_KEY"], message: "is required in production (mailbox passwords, unsubscribe links)" });
      }
      for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
        const url = env[key];
        if (url && !/[?&]sslmode=/.test(url)) {
          ctx.addIssue({ code: "custom", path: [key], message: "must use SSL in production (add ?sslmode=require)" });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema> & { listenHost: string };

/**
 * Hosted (Render) must bind to 0.0.0.0. Never default a hosted server to 127.0.0.1.
 * - RENDER set            -> always 0.0.0.0 (HOST is ignored)
 * - HOST set              -> HOST
 * - production otherwise  -> 0.0.0.0
 * - local development     -> 127.0.0.1
 */
export function resolveListenHost(env: Pick<z.infer<typeof envSchema>, "RENDER" | "HOST" | "NODE_ENV">): string {
  if (env.RENDER) return "0.0.0.0";
  if (env.HOST) return env.HOST;
  return env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
}

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

/** Parse and validate an environment object. Error messages never include values. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // "KEY=" (empty) in .env means "not set", like a missing line.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return { ...result.data, listenHost: resolveListenHost(result.data) };
}

/** Load backend/.env if it exists (local only), then validate process.env. */
export function loadEnv(envFile = ".env"): Env {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseEnv(process.env);
}
