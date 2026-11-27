import { describe, expect, it } from "vitest";
import { bounceRefs, classifyMessage, messageIds, newText, type ParsedMessage } from "../src/mail/replies.js";

const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({ from: "anna@studio.co.uk", subject: "Re: Dev capacity for Studio?", headers: new Map(), text: "", contentType: "text/plain", ...over });

describe("what came back", () => {
  it("a real reply", () => {
    expect(classifyMessage(msg({ text: "Hi Riyad,\n\nYes, send two examples please.\n\nOn Mon, 30 Nov 2026 at 10:02, Riyad <hello@riyadtech.xyz> wrote:\n> Would a short call make sense?\n> unsubscribe here" }))).toBe("reply");
  });
  it("a no, or a request to stop", () => {
    expect(classifyMessage(msg({ text: "No thanks." }))).toBe("unsubscribe");
    expect(classifyMessage(msg({ text: "Please remove me from your list." }))).toBe("unsubscribe");
    expect(classifyMessage(msg({ text: "Hi, we're not interested at the moment.\n\nAnna" }))).toBe("unsubscribe");
    // "unsubscribe" only inside the quoted e-mail is not a request.
    expect(classifyMessage(msg({ text: "Sounds good, call me Tuesday.\n\n> Reply no or unsubscribe here: https://x" }))).toBe("reply");
  });
  it("an out-of-office answer", () => {
    expect(classifyMessage(msg({ subject: "Automatic reply: Dev capacity for Studio?", text: "I am out until Monday." }))).toBe("auto_reply");
    expect(classifyMessage(msg({ headers: new Map([["auto-submitted", "auto-replied"]]), text: "Thanks for your e-mail." }))).toBe("auto_reply");
  });
  it("a bounce", () => {
    expect(classifyMessage(msg({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" }))).toBe("bounce");
    expect(classifyMessage(msg({ from: "postmaster@outlook.com", subject: "Undeliverable: Dev capacity", contentType: "multipart/report" }))).toBe("bounce");
  });
});

describe("text and references", () => {
  it("keeps only the new words of a reply", () => {
    expect(newText("Great, let's talk.\n\nAnna\n\nOn Mon, 30 Nov 2026, Riyad wrote:\n> old text")).toBe("Great, let's talk.\n\nAnna");
    expect(newText("Ok\n-----Original Message-----\nFrom: Riyad")).toBe("Ok");
  });
  it("finds Message-IDs and the failed address in a bounce", () => {
    expect(messageIds("<a@x.com> <b@riyadtech.xyz>")).toEqual(["<a@x.com>", "<b@riyadtech.xyz>"]);
    const r = bounceRefs("Final-Recipient: rfc822; info@gone.co.uk\nStatus: 5.1.1\nMessage-ID: <abc.123@riyadtech.xyz>");
    expect(r.recipients).toEqual(["info@gone.co.uk"]);
    expect(r.messageIds).toEqual(["<abc.123@riyadtech.xyz>"]);
  });
});
