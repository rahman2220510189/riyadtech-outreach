"use client";

import { useSystemStatus } from "@/lib/system";
import { formatDuration } from "@/lib/send-windows";

/** Shown on every page when the worker's heartbeat is missing or older than 90 s. */
export function WorkerBanner() {
  const { data } = useSystemStatus();
  if (!data || data.worker.state === "ok") return null;

  const w = data.worker;
  const title =
    w.state === "never"
      ? "The background worker has not run yet."
      : `The background worker stopped. Last sign of life ${formatDuration((w.ageSeconds ?? 0) / 60)} ago.`;

  return (
    <div role="alert" className="border-b border-warn/30 bg-warn-soft px-5 py-3 text-sm text-warn sm:px-8">
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5">
        Finding leads and sending emails wait until it runs again. Locally, start it with{" "}
        <code className="rounded bg-surface/70 px-1 py-0.5">npm run dev:all</code> in the backend folder. When hosted, the
        service restarts it by itself; if this stays, check the Render logs.
      </p>
    </div>
  );
}
