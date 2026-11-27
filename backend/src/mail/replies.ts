/**
 * Phase 6, the pure part: what kind of message came back (a real reply, an auto-reply, a "no",
 * a bounce), the new text of a reply without the quoted history, and the references a bounce
 * carries to the e-mail it bounced. No network, no database.
 */

export type ReplyKind = "reply" | "auto_reply" | "unsubscribe" | "bounce";

export interface ParsedMessage {
  from: string;
  subject: string;
  /** Lower-case header names. */
  headers: Map<string, string>;
  text: string;
  contentType: string;
}

const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mail-delivery-subsystem|maildelivery|bounce[s]?|no-?reply-bounce)(@|$)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification \(failure\)|delivery has failed|mail delivery (failed|subsystem)|returned mail|failure notice|could not be delivered|address not found|message not delivered|nicht zustellbar)/i;
const AUTO_SUBJECT = /^\s*(auto(matic)?[\s-]*(reply|response|antwort)|autoreply|auto:|out of (the )?office|ooo\b|abwesenheit|away from (the )?office|on (annual )?leave|i am away|i'm away|absence)/i;
const NO_ONLY = /^\s*(no|nope|no thanks?( you)?|no,? thank you|not interested)[\s.!,]*(thanks?|thank you|cheers|regards)?[\s.!]*$/i;
const UNSUBSCRIBE = /\b(unsubscribe|remove me|take me off|stop (emailing|e-mailing|contacting|sending)|please stop|not interested|no interest|do not (email|e-mail|contact)|don'?t (email|e-mail|contact)|no thanks?)\b/i;

export function isDaemon(from: string): boolean {
  return DAEMON.test(from.trim().toLowerCase());
}

/** The reply's own words: quoted lines and the history under "On … wrote:" are dropped. */
export function newText(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const l = line.trim();
    if (/^On .{4,200}wrote:\s*$/i.test(l)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(l)) break;
    if (/^From:\s.+/i.test(l) && out.length > 0) break;
    if (/^Am .{4,200}schrieb.*:\s*$/i.test(l) || /^Le .{4,200}a écrit\s*:\s*$/i.test(l)) break;
    if (l.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
}

export function classifyMessage(m: ParsedMessage): ReplyKind {
  const auto = m.headers.get("auto-submitted");
  if (isDaemon(m.from) || /multipart\/report/i.test(m.contentType) || (BOUNCE_SUBJECT.test(m.subject) && !auto)) return "bounce";
  if ((auto && auto.toLowerCase() !== "no") || m.headers.has("x-autoreply") || m.headers.has("x-autorespond") || AUTO_SUBJECT.test(m.subject)) {
    return "auto_reply";
  }
  const own = newText(m.text);
  const firstLines = own.split("\n").slice(0, 6).join("\n");
  if (NO_ONLY.test(own) || UNSUBSCRIBE.test(firstLines)) return "unsubscribe";
  return "reply";
}

/** Message-IDs ("<…>") in a header value or a text. */
export function messageIds(value: string | undefined | null): string[] {
  return [...new Set((value ?? "").match(/<[^<>\s]{1,250}@[^<>\s]{1,250}>/g) ?? [])];
}

/** What a bounce points at: the bounced message's Message-ID(s) and the address that failed. */
export function bounceRefs(text: string): { messageIds: string[]; recipients: string[] } {
  const recipients = [...text.matchAll(/(?:final|original)-recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi)].map((m) => m[1]!.toLowerCase());
  const ids = [...text.matchAll(/message-id:\s*(<[^<>\s]+>)/gi)].map((m) => m[1]!);
  return { messageIds: [...new Set([...ids, ...messageIds(text)])], recipients: [...new Set(recipients)] };
}
