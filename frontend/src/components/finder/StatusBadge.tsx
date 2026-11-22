import { type JobStatus, STATUS_LABELS } from "@/lib/finder";

const STYLES: Record<JobStatus, string> = {
  queued: "bg-paper text-ink-2",
  running: "bg-ink text-white",
  paused: "bg-warn-soft text-warn",
  done: "bg-go-soft text-go",
  failed: "bg-bad-soft text-bad",
  cancelled: "bg-paper text-ink-3",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
