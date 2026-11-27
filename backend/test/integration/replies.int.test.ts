/**
 * Phase 6 on a real PostgreSQL with a fake inbox: a reply stops the follow-ups, a "no" and a bounce
 * go on the suppression list, an out-of-office answer delays the next e-mail, unrelated mail is
 * never saved, and nothing is handled twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { encryptSecret } from "../../src/mail/crypto.js";
import { checkInbox, type HeaderInfo, type InboxReader, setInboxTestHook } from "../../src/mail/inbox.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const KEY = testEnv().ENCRYPTION_KEY!;
const SENT_AT = new Date("2026-11-30T10:00:00Z");

interface FakeMsg {
  uid: number;
  raw: string;
}
function rfc(o: { from: string; subject: string; inReplyTo?: string; body: string; extra?: string; date?: string }): string {
  return [
    `From: ${o.from}`,
    "To: hello@riyadtech.invalid",
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? "Tue, 01 Dec 2026 09:00:00 +0000"}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@sender.invalid>`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    ...(o.extra ? [o.extra] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
  ].join("\r\n");
}

describe.skipIf(!url)("replies (integration)", () => {
  let db: Db;
  let inbox: FakeMsg[] = [];
  let uidValidity = "100";
  let mailboxId: bigint;
  const leadIds: Record<string, bigint> = {};
  const msgIds: Record<string, string> = {};

  async function cleanup() {
    if (!db) return;
    await db.campaign.deleteMany({ where: { name: { startsWith: "ZZR " } } });
    await db.place.deleteMany({ where: { country: "ZR" } });
    await db.mailbox.deleteMany({ where: { fromEmail: "zz-replies@riyadtech.invalid" } });
    await db.suppression.deleteMany({ where: { value: { endsWith: ".zr.invalid" } } });
    await db.country.deleteMany({ where: { code: "ZR" } });
  }

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 3, NODE_ENV: "test" });
    await cleanup();
    await db.country.create({ data: { code: "ZR", name: "Replyland", timezones: ["UTC"], bbox: [0, 0, 1, 1], enabled: true, outreachRules: { law: "test", genericOnly: false, verified: true, notes: "t" } } });
    const mb = await db.mailbox.create({
      data: {
        label: "ZZR",
        fromName: "Riyad",
        fromEmail: "zz-replies@riyadtech.invalid",
        smtpHost: "smtp.zr.invalid",
        smtpPort: 465,
        smtpSecurity: "ssl",
        smtpUser: "me@gmail.invalid",
        smtpPasswordEnc: encryptSecret(KEY, "app-pass"),
        imapHost: "imap.zr.invalid",
        imapPort: 993,
        imapUser: "me@gmail.invalid",
      },
    });
    mailboxId = mb.id;
    const campaign = await db.campaign.create({ data: { name: "ZZR one", segment: "A", country: "ZR", mailboxId, status: "running" } });
    for (const k of ["reply", "no", "ooo", "bounce", "quiet"]) {
      const p = await db.place.create({
        data: { segment: "A", categoryKey: "web_design", name: `${k} studio`, website: `https://${k}.zr.invalid/`, websiteDomain: `${k}.zr.invalid`, country: "ZR", lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", primaryEmail: `hello@${k}.zr.invalid` },
      });
      msgIds[k] = `<${k}.first@riyadtech.invalid>`;
      const l = await db.campaignLead.create({
        data: { campaignId: campaign.id, placeId: p.id, email: `hello@${k}.zr.invalid`, domain: `${k}.zr.invalid`, step: 1, status: "queued", nextAt: new Date("2026-12-04T10:00:00Z"), firstMessageId: msgIds[k], lastMessageId: msgIds[k], firstSubject: `Dev capacity for ${k}?` },
      });
      leadIds[k] = l.id;
      await db.campaignSend.create({ data: { campaignLeadId: l.id, step: 1, mailboxId, toEmail: l.email, subject: `Dev capacity for ${k}?`, body: "x", messageId: msgIds[k], status: "sent", createdAt: SENT_AT } });
    }

    setInboxTestHook((login): InboxReader => {
      expect(login).toMatchObject({ host: "imap.zr.invalid", user: "me@gmail.invalid", password: "app-pass" });
      const head = (m: FakeMsg): HeaderInfo => {
        const from = /^From: .*?<?([^\s<>]+@[^\s<>]+)>?$/m.exec(m.raw)?.[1]?.toLowerCase() ?? "";
        const ids = [...(m.raw.match(/^(In-Reply-To|References): (.*)$/gm) ?? [])].join(" ").match(/<[^<>\s]+>/g) ?? [];
        return { uid: m.uid, from, subject: /^Subject: (.*)$/m.exec(m.raw)?.[1] ?? "", date: new Date("2026-12-01T09:00:00Z"), ids };
      };
      return {
        open: () => Promise.resolve({ uidValidity, uidNext: (inbox.at(-1)?.uid ?? 0) + 1 }),
        headersFrom: (from, limit) => Promise.resolve(inbox.filter((m) => m.uid >= from).slice(0, limit).map(head)),
        headersSince: (_since, limit) => Promise.resolve(inbox.slice(0, limit).map(head)),
        source: (uid) => Promise.resolve(Buffer.from(inbox.find((m) => m.uid === uid)!.raw)),
        close: () => Promise.resolve(),
      };
    });
  }, 60_000);

  afterAll(async () => {
    setInboxTestHook(null);
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("handles replies, a no, an out-of-office, a bounce; ignores other mail; never twice", async () => {
    inbox = [
      { uid: 10, raw: rfc({ from: "Friend <friend@personal.invalid>", subject: "Dinner?", body: "See you at 8." }) },
      { uid: 11, raw: rfc({ from: "Anna <hello@reply.zr.invalid>", subject: "Re: Dev capacity for reply?", inReplyTo: msgIds.reply, body: "Hi Riyad,\n\nYes please send two examples.\n\nOn Mon, 30 Nov 2026, Riyad wrote:\n> Would a short call make sense?" }) },
      { uid: 12, raw: rfc({ from: "hello@no.zr.invalid", subject: "Re: Dev capacity for no?", inReplyTo: msgIds.no, body: "No thanks." }) },
      { uid: 13, raw: rfc({ from: "hello@ooo.zr.invalid", subject: "Automatic reply: Dev capacity for ooo?", inReplyTo: msgIds.ooo, extra: "Auto-Submitted: auto-replied", body: "I am away until 10 December." }) },
      { uid: 14, raw: rfc({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.invalid>", subject: "Delivery Status Notification (Failure)", body: `Address not found.\n\nFinal-Recipient: rfc822; hello@bounce.zr.invalid\nStatus: 5.1.1\n\nMessage-ID: ${msgIds.bounce}` }) },
    ];
    const mb = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    const r = await checkInbox(db, KEY, mb);
    expect(r).toMatchObject({ checked: 5, saved: 4, error: null, byKind: { reply: 1, unsubscribe: 1, auto_reply: 1, bounce: 1 } });

    const lead = async (k: string) => db.campaignLead.findUniqueOrThrow({ where: { id: leadIds[k]! } });
    expect(await lead("reply")).toMatchObject({ status: "replied", nextAt: null });
    expect(await lead("no")).toMatchObject({ status: "stopped" });
    expect(await lead("bounce")).toMatchObject({ status: "bounced" });
    expect((await lead("ooo")).nextAt!.toISOString()).toBe("2026-12-08T09:00:00.000Z"); // a week after the auto-reply
    expect(await lead("quiet")).toMatchObject({ status: "queued" });
    const sup = await db.suppression.findMany({ where: { value: { endsWith: ".zr.invalid" } }, orderBy: { value: "asc" } });
    expect(sup.map((s) => `${s.value}:${s.reason}:${s.source}`)).toEqual(["hello@bounce.zr.invalid:bounced:imap", "hello@no.zr.invalid:replied_no:imap"]);
    expect((await db.place.findFirstOrThrow({ where: { websiteDomain: "no.zr.invalid" } })).suppressed).toBe(true);

    const saved = await db.reply.findMany({ where: { mailboxId }, orderBy: { id: "asc" } });
    expect(saved.map((s) => s.fromEmail)).not.toContain("friend@personal.invalid"); // other mail is never saved
    expect(saved.find((s) => s.kind === "reply")!.snippet).toBe("Hi Riyad,\n\nYes please send two examples.");
    expect(saved.find((s) => s.kind === "reply")!.done).toBe(false);

    // The next check only reads new messages; a new UID validity re-reads but saves nothing twice.
    expect(await checkInbox(db, KEY, await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } }))).toMatchObject({ checked: 0, saved: 0 });
    inbox.push({ uid: 15, raw: rfc({ from: "hello@quiet.zr.invalid", subject: "Re: Dev capacity for quiet?", body: "Interesting, what do you charge per hour?" }) }); // matched by sender only
    expect(await checkInbox(db, KEY, await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } }))).toMatchObject({ checked: 1, saved: 1 });
    expect(await lead("quiet")).toMatchObject({ status: "replied" });
    uidValidity = "200";
    // Same messages, new UID validity (the mailbox was rebuilt): all read again, nothing handled twice.
    const again = await checkInbox(db, KEY, await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } }));
    expect(again).toMatchObject({ checked: 6, saved: 0 });
    expect(await db.reply.count({ where: { mailboxId } })).toBe(5);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).imapUidValidity).toBe("200");
  });

  it("explains a failed login in plain words", async () => {
    setInboxTestHook(() => ({
      open: () => Promise.reject(Object.assign(new Error("Command failed"), { authenticationFailed: true })),
      headersFrom: () => Promise.resolve([]),
      headersSince: () => Promise.resolve([]),
      source: () => Promise.resolve(Buffer.alloc(0)),
      close: () => Promise.resolve(),
    }));
    const r = await checkInbox(db, KEY, await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } }));
    expect(r.error).toMatch(/Enable IMAP.*App Password/);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } })).imapError).toMatch(/IMAP login failed/);
  });
});
