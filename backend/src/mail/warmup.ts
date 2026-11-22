import type { Settings } from "../settings/definitions.js";

/** How many e-mails a mailbox may send today: warm-up start + step per day since it began, up to its cap. */
export function warmupAllowance(m: { dailyCap: number; warmupStartedOn: Date }, s: Settings["sending"], today = new Date()): number {
  const day = 24 * 3600_000;
  const days = Math.max(0, Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - m.warmupStartedOn.getTime()) / day));
  return Math.min(m.dailyCap, s.mailboxDailyCap, s.warmupStart + s.warmupStepPerDay * days);
}
