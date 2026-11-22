import { CRAWL_STATUS_LABELS, type CrawlStatus } from "@/lib/leads";

/** A 0-100 score as a number with a thin bar under it (no colour meaning beyond "more"). */
export function Score({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="text-ink-3" aria-label={`${label}: not scored`}>–</span>;
  return (
    <span className="inline-flex w-10 flex-col items-end" aria-label={`${label}: ${value} of 100`} title={`${label}: ${value} of 100`}>
      <span className="font-medium tabular-nums">{value}</span>
      <span className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-paper">
        <span className="block h-full rounded-full bg-ink-2" style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

const CRAWL_STYLES: Record<CrawlStatus, string> = {
  ok: "bg-go-soft text-go",
  partial: "bg-go-soft text-go",
  robots_blocked: "bg-paper text-ink-2",
  bot_blocked: "bg-warn-soft text-warn",
  unreachable: "bg-paper text-ink-2",
  not_html: "bg-paper text-ink-2",
  platform: "bg-paper text-ink-2",
  error: "bg-bad-soft text-bad",
};

export function CrawlBadge({ status }: { status: CrawlStatus | null }) {
  if (!status) return <span className="inline-flex rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-ink-3">Not crawled</span>;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${CRAWL_STYLES[status]}`}>
      {CRAWL_STATUS_LABELS[status]}
    </span>
  );
}

export function SignalChip({ label, strong = false }: { label: string; strong?: boolean }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs ${strong ? "border-ink/30 font-medium text-ink" : "border-line text-ink-2"}`}
    >
      {label}
    </span>
  );
}

export function SuppressedBadge() {
  return (
    <span className="inline-flex whitespace-nowrap rounded-full bg-bad-soft px-2 py-0.5 text-xs font-semibold text-bad" title="On the suppression list: never contacted">
      Suppressed
    </span>
  );
}
