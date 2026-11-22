import type { Env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

/**
 * Drafting e-mails with Groq (OpenAI-compatible chat API). The model gets only my profile facts and
 * the programme facts; it is told not to invent anything. Every draft is read and edited by me before
 * it can be sent.
 */

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}
/** Extra request options: Groq's built-in browser search (gpt-oss models) for the scholarship search. */
export interface ChatOptions {
  browserSearch?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
}
type ChatFn = (key: string, model: string, messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;

async function groqChat(key: string, model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.browserSearch ? 0.2 : 0.4,
        max_completion_tokens: opts.maxTokens ?? 2000,
        // Browser search runs on Groq's side; low reasoning keeps the search short (Groq docs).
        ...(opts.browserSearch ? { tools: [{ type: "browser_search" }], tool_choice: "required", reasoning_effort: "low" } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new AppError(502, "AI_UNREACHABLE", `Groq could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new AppError(502, "AI_KEY", "Groq refused the API key (GROQ_API_KEY in backend/.env). Create a new key at console.groq.com/keys.");
    if (res.status === 429) throw new AppError(429, "AI_LIMIT", "Groq's free limit is reached for now; try again in a minute.");
    if (opts.browserSearch && /tool|browser|search|plan|billing|not available|not supported/i.test(msg))
      throw new AppError(502, "AI_SEARCH", `Groq did not run its web search: ${msg} (it may need a paid plan or a gpt-oss model).`);
    if (res.status === 404 || /model/i.test(msg)) throw new AppError(502, "AI_MODEL", `Groq: ${msg} Set GROQ_MODEL in backend/.env to a production model from console.groq.com/docs/models.`);
    throw new AppError(502, "AI_FAILED", `Groq answered HTTP ${res.status}: ${msg}`);
  }
  const content = (JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  if (!content?.trim()) throw new AppError(502, "AI_EMPTY", "Groq sent an empty answer; try again.");
  return content;
}

let chatHook: ChatFn | null = null;
export function setAiTestHook(fn: ChatFn | null): void {
  chatHook = fn;
}

export function aiConfigured(env: Pick<Env, "GROQ_API_KEY">): boolean {
  return !!env.GROQ_API_KEY;
}

export async function chat(env: { GROQ_API_KEY?: string | undefined; GROQ_MODEL: string }, messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
  if (!env.GROQ_API_KEY) throw new AppError(400, "AI_NOT_SET", "GROQ_API_KEY is not set in backend/.env; write the e-mail by hand or add the key.");
  return (chatHook ?? groqChat)(env.GROQ_API_KEY, env.GROQ_MODEL, messages, opts);
}

export interface DraftFacts {
  purpose: "inquiry" | "application" | "follow_up";
  profile: Record<string, string | number | boolean | null>;
  program: Record<string, string | null>;
  attachments: string[];
  extra?: string | undefined;
}

const SYSTEM = `You write short, honest, polite e-mails from a student to a university admissions office or a scholarship office.
Rules:
- Use ONLY the facts given. Never invent grades, awards, experience, test scores, dates or names. If something is unknown, leave it out.
- Plain text, no markdown, no emojis, no placeholders like [Name] except where a fact is missing and the student must add it; then write [[…]] with what to add.
- 120 to 200 words in the body. Clear subject line, max 80 characters.
- Greeting "Dear Admissions Team," unless a contact name is given. Sign with the student's full name.
- If the student has no IELTS and studied in English, ask clearly whether a Medium of Instruction (MOI) letter is accepted as proof of English.
- For an inquiry: ask 2 to 3 specific questions (MOI acceptance, scholarship or tuition waiver, deadline for the next intake).
- For an application: say which documents are attached (only the listed ones) and ask them to confirm receipt.
- For a follow-up: refer politely to the earlier e-mail and repeat the main question in one sentence.
Answer exactly in this format:
SUBJECT: <subject line>
BODY:
<body>`;

/** Asks the model for a draft and splits it into subject and body. */
export async function draftEmail(env: Pick<Env, "GROQ_API_KEY" | "GROQ_MODEL">, facts: DraftFacts): Promise<{ subject: string; body: string; model: string }> {
  const user = [
    `Purpose: ${facts.purpose}`,
    `Student facts (JSON): ${JSON.stringify(facts.profile)}`,
    `Programme facts (JSON): ${JSON.stringify(facts.program)}`,
    `Attached documents: ${facts.attachments.length ? facts.attachments.join(", ") : "none"}`,
    facts.extra ? `Extra instruction from the student: ${facts.extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await chat(env, [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ]);
  return { ...parseDraft(raw), model: env.GROQ_MODEL };
}

export function parseDraft(raw: string): { subject: string; body: string } {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r\n/g, "\n").trim();
  const m = /SUBJECT:\s*(.+)\n+BODY:\s*\n?([\s\S]+)/i.exec(text);
  const subject = (m?.[1] ?? "").replace(/^["*\s]+|["*\s]+$/g, "").slice(0, 150);
  const body = (m?.[2] ?? text).replace(/\*\*/g, "").trim();
  if (!subject || body.length < 40) throw new AppError(502, "AI_FORMAT", "The AI answer could not be read as an e-mail; try again.");
  return { subject, body };
}
