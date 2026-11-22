/**
 * Phase 4 mail pieces without a database: encryption, unsubscribe tokens, the DNS check
 * (fake DNS answers), composing (footer, headers), warm-up, and real SMTP through nodemailer
 * against a local fake SMTP server (nothing leaves this machine).
 */
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, readUnsubscribeToken, unsubscribeToken } from "../src/mail/crypto.js";
import { composeMail, SAMPLE_RECIPIENT } from "../src/mail/compose.js";
import { checkSendingDomain, setDnsTestLookups } from "../src/mail/dns-check.js";
import { mailErrorText, newMessageId, sendMail, setMailTestHooks, verifySmtp } from "../src/mail/transport.js";
import { warmupAllowance } from "../src/mail/warmup.js";
import { defaultSettings } from "../src/settings/definitions.js";

const KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
const OTHER = "1f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";

describe("secrets and unsubscribe tokens", () => {
  it("encrypts with AES-256-GCM: a different value each time, readable only with the same key", () => {
    const a = encryptSecret(KEY, "abcd efgh ijkl mnop");
    const b = encryptSecret(KEY, "abcd efgh ijkl mnop");
    expect(a).not.toBe(b);
    expect(a).not.toContain("abcd");
    expect(decryptSecret(KEY, a)).toBe("abcd efgh ijkl mnop");
    expect(() => decryptSecret(OTHER, a)).toThrow(/ENCRYPTION_KEY has changed/);
    const parts = a.split(":");
    parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1); // a changed tag: tampering is detected
    expect(() => decryptSecret(KEY, parts.join(":"))).toThrow();
    expect(() => encryptSecret(undefined, "x")).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("unsubscribe tokens name the address and cannot be forged", () => {
    const t = unsubscribeToken(KEY, "Sarah@Pixel.TEST");
    expect(readUnsubscribeToken(KEY, t)).toBe("sarah@pixel.test");
    expect(readUnsubscribeToken(OTHER, t)).toBeNull();
    const forged = `${Buffer.from("boss@pixel.test").toString("base64url")}.${t.split(".")[1]}`;
    expect(readUnsubscribeToken(KEY, forged)).toBeNull();
    expect(readUnsubscribeToken(KEY, "nonsense")).toBeNull();
  });
});

describe("DNS check (fake DNS)", () => {
  afterAll(() => setDnsTestLookups(null));
  it("Cloudflare routing, SPF without Google, DMARC none, Gmail send-as: explains each point", async () => {
    setDnsTestLookups({
      mx: () => Promise.resolve([{ exchange: "route2.mx.cloudflare.net", priority: 20 }, { exchange: "route1.mx.cloudflare.net", priority: 10 }]),
      txt: (name) =>
        Promise.resolve(
          name === "riyadtech.xyz"
            ? [["v=spf1 include:_spf.mx.cloudflare.net ~all"], ["google-site-verification=x"]]
            : name === "_dmarc.riyadtech.xyz"
              ? [["v=DMARC1; p=none; rua=mailto:x@riyadtech.xyz"]]
              : [],
        ),
    });
    const r = await checkSendingDomain({ fromEmail: "hello@riyadtech.xyz", smtpHost: "smtp.gmail.com" });
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(r.provider).toBe("Gmail / Google");
    expect(by.mx).toMatchObject({ status: "ok", detail: expect.stringContaining("Cloudflare Email Routing") as string });
    expect(by.mx!.records[0]).toBe("10 route1.mx.cloudflare.net");
    expect(by.spf).toMatchObject({ status: "bad", title: "SPF does not include Gmail / Google", detail: expect.stringContaining("include:_spf.google.com") as string });
    expect(by.dmarc).toMatchObject({ status: "ok", title: "DMARC policy none" });
    expect(by.dkim?.status).toBe("info");
    expect(by.alignment).toMatchObject({ status: "warn", detail: expect.stringContaining("Show original") as string });
  });

  it("no SPF, two SPF records, no DMARC, strict DMARC with Gmail send-as", async () => {
    setDnsTestLookups({ mx: () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" })), txt: () => Promise.resolve([]) });
    const none = await checkSendingDomain({ fromEmail: "a@none.test", smtpHost: "smtp.gmail.com" });
    expect(none.items.map((i) => [i.key, i.status])).toEqual([
      ["mx", "bad"],
      ["spf", "bad"],
      ["dmarc", "warn"],
      ["dkim", "info"],
      ["alignment", "warn"],
    ]);
    setDnsTestLookups({
      mx: () => Promise.resolve([{ exchange: "mx.zoho.eu", priority: 10 }]),
      txt: (n) => Promise.resolve(n === "two.test" ? [["v=spf1 include:_spf.google.com ~all"], ["v=spf1 -all"]] : n.startsWith("_dmarc") ? [["v=DMARC1; p=reject"]] : []),
    });
    const two = await checkSendingDomain({ fromEmail: "a@two.test", smtpHost: "smtp.gmail.com" });
    expect(two.items.find((i) => i.key === "spf")?.title).toBe("Two SPF records");
    expect(two.items.find((i) => i.key === "alignment")?.status).toBe("bad");
  });
});

describe("composing an outreach e-mail", () => {
  const company = { ...defaultSettings().company, senderName: "Riyad", postalAddress: "House 1, Road 2\nDhaka 1207, Bangladesh" };
  const env = { ENCRYPTION_KEY: KEY, PUBLIC_BASE_URL: "https://outreach.riyadtech.xyz/" };
  const mailbox = { fromName: "Riyad from Riyad Tech", fromEmail: "hello@riyadtech.xyz", replyTo: null };

  it("adds the footer and List-Unsubscribe headers with a token for the recipient", () => {
    const m = composeMail({ kind: "outreach", subject: "Hi {company}", body: "{Hi|Hello} {first_name|there},\n\n{signal_line}", templateKey: "t1", recipient: SAMPLE_RECIPIENT, to: "sarah@pixel.test", mailbox, company, env });
    expect(m.subject).toBe("Hi Pixel Studio");
    expect(m.text).toMatch(/^(Hi|Hello) Sarah,\n\nI saw Pixel Studio is hiring a Senior React Developer\.\n\n--\nRiyad · Riyad Tech\nHouse 1, Road 2, Dhaka 1207, Bangladesh\nReply "no" and I won't email again, or unsubscribe here: https:\/\/outreach\.riyadtech\.xyz\/u\//);
    const token = m.unsubscribeUrl!.split("/u/")[1]!;
    expect(readUnsubscribeToken(KEY, token)).toBe("sarah@pixel.test");
    expect(m.headers["List-Unsubscribe"]).toBe(`<mailto:hello@riyadtech.xyz?subject=unsubscribe>, <https://outreach.riyadtech.xyz/api/v1/u/${token}>`);
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.warnings).toEqual([]);
  });

  it("warns about a missing postal address; job e-mails have no footer and no unsubscribe", () => {
    const noAddr = composeMail({ kind: "outreach", subject: "x", body: "y", templateKey: "t", recipient: SAMPLE_RECIPIENT, to: "a@b.test", mailbox, company: { ...company, postalAddress: "" }, env });
    expect(noAddr.warnings[0]).toMatch(/postal address is empty/);
    const job = composeMail({ kind: "job", subject: "Application: {role}", body: "Dear team at {company}", templateKey: "t", recipient: SAMPLE_RECIPIENT, to: "jobs@b.test", mailbox, company, env });
    expect(job.text).toBe("Dear team at Pixel Studio");
    expect(job.headers).toEqual({});
    expect(job.subject).toBe("Application: Senior React Developer");
  });

  it("warm-up: 10 on the first day, +2 a day, never above the caps", () => {
    const s = defaultSettings().sending;
    const start = new Date("2026-10-01T00:00:00Z");
    expect(warmupAllowance({ dailyCap: 50, warmupStartedOn: start }, s, new Date("2026-10-01T15:00:00Z"))).toBe(10);
    expect(warmupAllowance({ dailyCap: 50, warmupStartedOn: start }, s, new Date("2026-10-06T08:00:00Z"))).toBe(20);
    expect(warmupAllowance({ dailyCap: 30, warmupStartedOn: start }, s, new Date("2026-12-01T08:00:00Z"))).toBe(30);
  });
});

describe("SMTP through nodemailer (local fake server)", () => {
  let server: SMTPServer;
  let port = 0;
  const received: { from: string; to: string[]; raw: string }[] = [];
  beforeAll(async () => {
    server = new SMTPServer({
      secure: true,
      authMethods: ["PLAIN", "LOGIN"],
      onAuth(auth, _s, cb) {
        if (auth.username === "hello@riyadtech.xyz" && auth.password === "abcd efgh ijkl mnop") cb(null, { user: auth.username });
        else cb(Object.assign(new Error("Username and Password not accepted"), { responseCode: 535 }));
      },
      onData(stream, session, cb) {
        let raw = "";
        stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        stream.on("end", () => {
          received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw });
          cb(null, "Message queued as TEST123");
        });
      },
      logger: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.server.address() as { port: number }).port;
    setMailTestHooks({}, { acceptSelfSigned: true });
  });
  afterAll(async () => {
    setMailTestHooks({});
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("logs in (verify), refuses a wrong password with a plain explanation, sends with headers and an attachment", async () => {
    const cfg = { host: "127.0.0.1", port, security: "ssl" as const, user: "hello@riyadtech.xyz", password: "abcd efgh ijkl mnop" };
    await expect(verifySmtp(cfg)).resolves.toBeUndefined();
    const bad = await verifySmtp({ ...cfg, password: "wrong" }).catch((e: unknown) => e);
    expect(mailErrorText(bad, "SMTP")).toMatch(/SMTP login failed: .*App Password/);
    const id = newMessageId("hello@riyadtech.xyz");
    expect(id).toMatch(/^<.+@riyadtech\.xyz>$/);
    const r = await sendMail(cfg, {
      from: { name: "Riyad", address: "hello@riyadtech.xyz" },
      to: "me@riyadtech.xyz",
      subject: "[TEST] Hällo",
      text: "Line one\n\n--\nfooter",
      headers: { "List-Unsubscribe": "<mailto:hello@riyadtech.xyz?subject=unsubscribe>, <https://x.test/api/v1/u/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      attachments: [{ filename: "CV.pdf", content: Buffer.from("%PDF-1.4 test"), contentType: "application/pdf" }],
      messageId: id,
    });
    expect(r.response).toMatch(/TEST123/);
    expect(r.accepted).toEqual(["me@riyadtech.xyz"]);
    const got = received.at(-1)!;
    expect(got.to).toEqual(["me@riyadtech.xyz"]);
    expect(got.raw).toContain(`Message-ID: ${id}`);
    expect(got.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(got.raw).toMatch(/filename="?CV\.pdf/);
    expect(got.raw).toMatch(/Subject: =\?UTF-8\?/); // non-ASCII subject is encoded
  });
});
