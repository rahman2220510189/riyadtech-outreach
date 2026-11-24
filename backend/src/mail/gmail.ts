import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import type { OutgoingMail } from "./transport.js";

/**
 * Sending through the Gmail API (HTTPS, port 443) instead of SMTP: works on hosts whose free plan
 * blocks SMTP, without the PC. Google Workspace and personal Gmail mailboxes only.
 * The user connects a mailbox once (OAuth "Sign in with Google"); we keep only the refresh token,
 * encrypted with ENCRYPTION_KEY. Scope: gmail.send (send only; the tool cannot read the mailbox)
 * plus openid email to confirm which address was connected.
 */

export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type GmailEnv = Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "PUBLIC_BASE_URL">;

let fetchHook: typeof fetch | null = null;
/** Tests only: answer Google's endpoints without the network. */
export function setGmailTestHooks(h: { fetch?: typeof fetch }): void {
  fetchHook = h.fetch ?? null;
  tokenCache.clear();
}
const http = (url: string, init: RequestInit) => (fetchHook ?? fetch)(url, { ...init, signal: AbortSignal.timeout(30_000) });

export function gmailConfigured(env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Where Google sends the browser back: through the website, which forwards /api/v1 to this API. */
export function redirectUri(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/v1/mailboxes/gmail/callback`;
}

/* ----------------------------------- state ----------------------------------- */

const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

/** "mailboxId.expiresAt.nonce.signature": ties Google's answer to the mailbox I clicked, for 15 minutes. */
export function makeState(key: string, mailboxId: bigint, now = Date.now()): string {
  const payload = `${mailboxId}.${now + 15 * 60_000}.${randomBytes(9).toString("base64url")}`;
  return `${payload}.${sign(key, payload)}`;
}

export function readState(key: string, state: string, now = Date.now()): bigint | null {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join(".");
  const want = Buffer.from(sign(key, payload));
  const got = Buffer.from(parts[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!/^\d+$/.test(parts[0]!) || Number(parts[1]) < now) return null;
  return BigInt(parts[0]!);
}

export function authUrl(env: GmailEnv, state: string, loginHint: string): string {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: loginHint,
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/* ----------------------------------- tokens ---------------------------------- */

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenCall(body: Record<string, string>): Promise<TokenAnswer> {
  const res = await http(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const j = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || j.error) {
    const code = j.error ?? `HTTP ${res.status}`;
    throw new AppError(code === "invalid_grant" ? 401 : 502, code === "invalid_grant" ? "GMAIL_RECONNECT" : "GMAIL_TOKEN", gmailErrorText(code, j.error_description));
  }
  return j;
}

export function gmailErrorText(code: string, description?: string): string {
  if (code === "invalid_grant") return "The Gmail connection has expired or was removed. Connect Gmail again on the Mailboxes page.";
  if (code === "invalid_client" || code === "unauthorized_client") return "Google does not accept GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Check them on the server.";
  if (code === "access_denied") return "Access was not granted on Google's page (or your organisation's admin blocks this app).";
  if (code === "admin_policy_enforced" || code === "org_internal") return "Your organisation's Google admin blocks this app for your account.";
  return `Google: ${code}${description ? ` (${description})` : ""}`;
}

/** The e-mail address in Google's ID token (read from the token answer over TLS, as Google's docs allow). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    return payload.email && payload.email_verified !== false ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(env: GmailEnv, code: string): Promise<{ refreshToken: string; email: string | null }> {
  const j = await tokenCall({ code, client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(env), grant_type: "authorization_code" });
  if (!j.refresh_token) throw new AppError(502, "GMAIL_TOKEN", "Google gave no long-term permission (refresh token). Remove the app under myaccount.google.com → Security → Third-party access, then connect again.");
  return { refreshToken: j.refresh_token, email: emailFromIdToken(j.id_token) };
}

const tokenCache = new Map<string, { token: string; until: number }>();

async function accessToken(env: GmailEnv, refreshToken: string): Promise<string> {
  const k = createHash("sha256").update(refreshToken).digest("hex");
  const hit = tokenCache.get(k);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const j = await tokenCall({ refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token" });
  if (!j.access_token) throw new AppError(502, "GMAIL_TOKEN", "Google gave no access token");
  tokenCache.set(k, { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** Checks that the saved connection still works (no e-mail is sent). */
export async function checkGmail(env: GmailEnv, refreshToken: string): Promise<void> {
  await accessToken(env, refreshToken);
}

export async function revokeGmail(refreshToken: string): Promise<void> {
  await http(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }).toString() }).catch(() => undefined);
}

/* ----------------------------------- sending --------------------------------- */

/** The complete message (headers, text, attachments) as Gmail wants it: base64url of the raw MIME. */
export async function rawMessage(m: OutgoingMail): Promise<string> {
  const composer = new MailComposer({
    from: m.from,
    to: m.to,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    subject: m.subject,
    text: m.text,
    headers: m.headers ?? {},
    messageId: m.messageId,
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  const buf = await composer.compile().build();
  return buf.toString("base64url");
}

export async function sendGmail(env: GmailEnv, refreshToken: string, m: OutgoingMail): Promise<{ id: string }> {
  const token = await accessToken(env, refreshToken);
  const res = await http(SEND_URL, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: await rawMessage(m) }) });
  const j = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; status?: string } };
  if (!res.ok || !j.id) {
    if (res.status === 401) tokenCache.clear();
    throw new AppError(res.status === 401 || res.status === 403 ? 401 : 502, "GMAIL_SEND", `Gmail API: ${j.error?.message ?? `HTTP ${res.status}`}`);
  }
  return { id: j.id };
}
