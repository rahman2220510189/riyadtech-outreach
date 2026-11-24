import { afterEach, describe, expect, it } from "vitest";

const urlOf = (x: unknown): string => (typeof x === "string" ? x : x instanceof URL ? x.href : x instanceof Request ? x.url : "");
import { authUrl, emailFromIdToken, exchangeCode, makeState, rawMessage, readState, redirectUri, sendGmail, setGmailTestHooks } from "../src/mail/gmail.js";

const env = { GOOGLE_CLIENT_ID: "client-id-123.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "client-secret-xyz", PUBLIC_BASE_URL: "https://outreach.example.org/" };
const idToken = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
const json = (status: number, body: object) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => setGmailTestHooks({}));

describe("Gmail API", () => {
  it("signs the state, and refuses a changed or expired one", () => {
    const st = makeState("secret-key", 42n, 1_000);
    expect(readState("secret-key", st, 2_000)).toBe(42n);
    expect(readState("other-key", st, 2_000)).toBeNull();
    expect(readState("secret-key", st.replace(/^42/, "43"), 2_000)).toBeNull();
    expect(readState("secret-key", st, 1_000 + 16 * 60_000)).toBeNull();
    expect(readState("secret-key", "garbage", 2_000)).toBeNull();
  });

  it("builds Google's sign-in address: send-only scope, offline, back to our callback", () => {
    expect(redirectUri(env)).toBe("https://outreach.example.org/api/v1/mailboxes/gmail/callback");
    const u = new URL(authUrl(env, "st", "student@uni.example"));
    expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.send");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("login_hint")).toBe("student@uni.example");
    expect(u.searchParams.get("redirect_uri")).toBe("https://outreach.example.org/api/v1/mailboxes/gmail/callback");
  });

  it("reads the address from the ID token", () => {
    expect(emailFromIdToken(idToken({ email: "Student@Uni.Example", email_verified: true }))).toBe("student@uni.example");
    expect(emailFromIdToken(idToken({ email: "x@y.z", email_verified: false }))).toBeNull();
    expect(emailFromIdToken("not-a-token")).toBeNull();
  });

  it("exchanges the code for a refresh token; explains Google's errors", async () => {
    setGmailTestHooks({ fetch: () => json(200, { access_token: "at", refresh_token: "rt-1", id_token: idToken({ email: "student@uni.example" }), expires_in: 3600 }) });
    expect(await exchangeCode(env, "code")).toEqual({ refreshToken: "rt-1", email: "student@uni.example" });
    setGmailTestHooks({ fetch: () => json(400, { error: "invalid_grant" }) });
    await expect(exchangeCode(env, "code")).rejects.toThrow(/Connect Gmail again/);
    setGmailTestHooks({ fetch: () => json(200, { access_token: "at" }) });
    await expect(exchangeCode(env, "code")).rejects.toThrow(/refresh token/);
  });

  it("sends the full MIME message (with attachments) as base64url", async () => {
    const calls: { url: string; body: string }[] = [];
    setGmailTestHooks({
      fetch: (url, init) => {
        calls.push({ url: urlOf(url), body: typeof init?.body === "string" ? init.body : "" });
        return urlOf(url).includes("oauth2") ? json(200, { access_token: "at-9", expires_in: 3600 }) : json(200, { id: "msg-1" });
      },
    });
    const mail = { from: { name: "Demo Student", address: "student@uni.example" }, to: "admissions@tu.example", subject: "Question about the MSc", text: "Dear Admissions Team,\nA question.", messageId: "<abc@uni.example>", attachments: [{ filename: "transcript.pdf", content: Buffer.from("%PDF-1.4 x"), contentType: "application/pdf" }] };
    expect(await sendGmail(env, "rt-1", mail)).toEqual({ id: "msg-1" });
    const raw = Buffer.from((JSON.parse(calls.at(-1)!.body) as { raw: string }).raw, "base64url").toString("utf8");
    expect(raw).toMatch(/^From: Demo Student <student@uni\.example>/m);
    expect(raw).toMatch(/^To: admissions@tu\.example/m);
    expect(raw).toMatch(/^Message-ID: <abc@uni\.example>/im);
    expect(raw).toContain('filename=transcript.pdf');
    await sendGmail(env, "rt-1", mail);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1); // access token reused
    expect((await rawMessage({ ...mail, attachments: [] })).length).toBeGreaterThan(50);

    setGmailTestHooks({ fetch: (url) => (urlOf(url).includes("oauth2") ? json(200, { access_token: "at", expires_in: 3600 }) : json(403, { error: { message: "Gmail API has not been used in project 1 before or it is disabled" } })) });
    await expect(sendGmail(env, "rt-2", mail)).rejects.toThrow(/Gmail API: Gmail API has not been used/);
  });
});
