import type { Env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

/**
 * Drafting e-mails with Groq (OpenAI-compatible chat API). The model gets only my profile facts and
 * the programme facts; it is told not to invent anything. Every draft is read and edited by me before
 * it can be sent.
 */

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
/** Extra request options: Groq's built-in browser search (gpt-oss models) for the scholarship search. */
export interface ChatOptions {
  browserSearch?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
}
type ChatFn = (key: string, model: string, messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;

/** Groq could not parse the model's own output (code tool_use_failed): a one-off, worth one more try. */
export function isGenerationFailure(msg: string): boolean {
  return /parsing failed|failed_generation|tool_use_failed|could not be parsed/i.test(msg);
}

/** A wrong or retired model name — not every message that mentions "the model". */
export function isModelProblem(status: number, msg: string): boolean {
  return status === 404 || /model[^.]{0,60}(not found|does not exist|decommissioned|deprecated|not supported|no access|unknown)|(unknown|invalid) model/i.test(msg);
}

async function groqChat(key: string, model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  try {
    return await groqChatOnce(key, model, messages, opts);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "AI_GENERATION") throw err;
    return groqChatOnce(key, model, messages, opts);
  }
}

async function groqChatOnce(key: string, model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
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
    if (isGenerationFailure(`${msg} ${text.slice(0, 500)}`))
      throw new AppError(502, "AI_GENERATION", "Groq could not read the model's answer this time (tried twice); the next run tries again.");
    if (opts.browserSearch && /tool|browser|search|plan|billing|not available|not supported/i.test(msg))
      throw new AppError(502, "AI_SEARCH", `Groq did not run its web search: ${msg} (it may need a paid plan or a gpt-oss model).`);
    if (isModelProblem(res.status, msg)) throw new AppError(502, "AI_MODEL", `Groq: ${msg} Set GROQ_MODEL in backend/.env to a production model from console.groq.com/docs/models.`);
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

/* ------------------------------ Motivation letter / statement of purpose ------------------------------ */

export interface LetterFacts {
  profile: Record<string, string | number | boolean | null>;
  program: Record<string, string | null>;
  /** My own points for this programme: why it, what I want to do after. */
  notes?: string | undefined;
  /** For a scholarship: the university programme I apply to through it ("MSc Computer Science, University of Szeged"). */
  target?: string | undefined;
  /** standard: 500–650 words (most applications); short: 300–400 words (forms with a limit). */
  length: "standard" | "short";
}

export const LETTER_WORDS = { standard: { min: 500, max: 650 }, short: { min: 300, max: 400 } } as const;

const LETTER_SYSTEM = `You help a student write a motivation letter (statement of purpose) for a master's or scholarship application.
Facts:
- Use ONLY the facts given (student facts, programme facts, target programme and the student's own notes). Never invent grades, awards, projects, publications, job titles, employers, dates, numbers, test scores, professors, courses, coursework subjects, modules, labs or research groups. Do not describe what the student studied in class unless the facts say so.
- Where the letter needs something that is not in the facts (a specific course, lab or research group of the programme, or a goal the student has not given), write a short gap marker [[…]] saying what the student should add. Use at most 4 markers.
- A scholarship is not a study programme. If the programme facts are a scholarship, write that the student applies to the target programme through the scholarship; if no target programme is given, write [[programme name]] at [[university]].
- Never mention money: no stipend or scholarship amounts, costs, prices, budgets or cost caps, in any currency. Reasons for the scholarship are academic, not financial details.
- Keep events in the order their dates show. Do not write "earlier", "previously" or "later" about two activities unless their dates prove it.
Content:
- Structure in plain paragraphs: (1) opening: the programme and the field; (2) academic background, short; (3) research, the longest part: what was done, what was learned; (4) work experience in at most 80 words in total (one paragraph for all jobs), focused on what it taught; leave out business figures such as budgets, prices, lead, customer, city or country counts; (5) why this programme, university and country, only reasons from the facts or the notes; (6) goals after the degree, realistic for a fresh graduate (a PhD or a research-oriented role, not a "senior" role); (7) one-sentence closing.
- Concrete and modest, first person, consistent British English. No clichés and no praise words such as "remarkable", "passionate", "cutting-edge", "state-of-the-art", "world-class", "unique opportunity". Never belittle the student's home country or university. No flattery of the host university. No markdown, no bullet points, no emojis.
- Do not include addresses, date lines or "Dear …" greetings; the letter starts with its first paragraph and ends with the student's full name exactly as given.
Answer exactly in this format:
TITLE: <Statement of Purpose – target programme or programme name>
LETTER:
<letter>`;

const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

export async function draftLetter(env: Pick<Env, "GROQ_API_KEY" | "GROQ_MODEL">, facts: LetterFacts): Promise<{ title: string; body: string; model: string }> {
  const { min, max } = LETTER_WORDS[facts.length];
  const user = [
    `Length: ${min} to ${max} words. Never more than ${max}.`,
    `Student facts (JSON): ${JSON.stringify(facts.profile)}`,
    `Programme facts (JSON): ${JSON.stringify(facts.program)}`,
    facts.target ? `Target programme (the student applies to this): ${facts.target}` : "No target programme given.",
    facts.notes ? `The student's own notes for this programme (use them, in better words): ${facts.notes}` : "The student gave no notes for this programme.",
  ].join("\n");
  const messages = [
    { role: "system" as const, content: LETTER_SYSTEM },
    { role: "user" as const, content: user },
  ];
  let letter = parseLetter(await chat(env, messages, { maxTokens: 4000, timeoutMs: 90_000 }));
  // Too long: one more pass that only shortens (same facts, nothing new).
  if (wordCount(letter.body) > max + 30) {
    const shorter = await chat(
      env,
      [
        ...messages,
        { role: "assistant" as const, content: `TITLE: ${letter.title}\nLETTER:\n${letter.body}` },
        { role: "user" as const, content: `This has ${wordCount(letter.body)} words. Shorten it to at most ${max} words: keep every fact and every [[…]] marker exactly, cut repetition and the work details first, add nothing new. Same answer format.` },
      ],
      { maxTokens: 4000, timeoutMs: 90_000 },
    ).catch(() => null);
    if (shorter) {
      try {
        letter = parseLetter(shorter);
      } catch {
        /* keep the first version */
      }
    }
  }
  return { ...letter, model: env.GROQ_MODEL };
}

/** Words that make a letter sound generated or boastful. */
const STYLE_WORDS = /\b(remarkabl[ey]|passionate|passion|cutting[- ]edge|state[- ]of[- ]the[- ]art|world[- ]class|unique opportunity|esteemed|prestigious|near[- ]perfect|production[- ]grade|unavailable in bangladesh|senior research role)\b/gi;

/**
 * Things to check by hand: numbers that are not in my facts (the AI may have invented them),
 * style words, length, and order words. Plain-words warnings for the letter page.
 */
export function letterChecks(body: string, factsText: string, length: "standard" | "short" = "standard"): string[] {
  const out: string[] = [];
  const facts = factsText.replace(/,(?=\d{3})/g, "").toLowerCase();
  const numbers = [...new Set([...body.replace(/(\d),(?=\d{3})/g, "$1").matchAll(/\b\d+(?:[.,]\d+)?\b/g)].map((m) => m[0]))];
  const strange = numbers.filter((n) => !/^(19|20)\d{2}$/.test(n) && !facts.includes(n.replace(",", ".").toLowerCase()) && !facts.includes(n.toLowerCase()));
  if (strange.length) out.push(`Numbers not found in your profile: ${strange.join(", ")}. Check they are right.`);
  const style = [...new Set([...body.matchAll(STYLE_WORDS)].map((m) => m[0].toLowerCase()))];
  if (style.length) out.push(`Words that sound boastful or generated: ${style.join(", ")}. Replace them.`);
  const money = [...new Set([...body.matchAll(/(?:[€$£]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:euros?|eur|usd|dollars?|huf|forints?|taka|bdt)\b)/gi)].map((m) => m[0]))];
  if (money.length) out.push(`Money amounts (${money.join(", ")}): leave stipends, costs and budgets out of a motivation letter.`);
  if (/\b(earlier|previously)\b/i.test(body)) out.push("Uses “earlier” or “previously”: check the order of events against the dates.");
  const { max } = LETTER_WORDS[length];
  const n = wordCount(body);
  if (n > max + 30) out.push(`${n} words: longer than ${max}. Shorten it, or check the programme's own limit.`);
  return out;
}

export function parseLetter(raw: string): { title: string; body: string } {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r\n/g, "\n").trim();
  const m = /TITLE:\s*(.+)\n+LETTER:\s*\n?([\s\S]+)/i.exec(text);
  const title = (m?.[1] ?? "").replace(/^["*#\s]+|["*\s]+$/g, "").slice(0, 200);
  const body = (m?.[2] ?? "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!title || body.split(/\s+/).length < 120) throw new AppError(502, "AI_FORMAT", "The AI answer could not be read as a letter; try again.");
  return { title, body };
}

/** The [[…]] places the student still has to fill in. */
export function letterGaps(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]{1,200})\]\]/g)].map((m) => m[1]!.trim());
}
