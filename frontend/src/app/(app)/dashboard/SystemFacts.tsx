"use client";

import type { ReactNode } from "react";
import { formatDuration } from "@/lib/send-windows";
import { useHealth, useSystemStatus } from "@/lib/system";

function Fact({ name, value, tone }: { name: string; value: ReactNode; tone: "go" | "warn" | "bad" | "plain" }) {
  const dot = { go: "bg-go", warn: "bg-warn", bad: "bg-bad", plain: "bg-line" }[tone];
  return (
    <div className="px-5 py-4">
      <dt className="text-sm text-ink-2">{name}</dt>
      <dd className="mt-1 flex items-center gap-2 font-medium">
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        {value}
      </dd>
    </div>
  );
}

export function SystemFacts() {
  const health = useHealth();
  const status = useSystemStatus();
  const h = health.data;
  const w = status.data?.worker;

  const database =
    !h ? (health.isError ? "No answer" : "Checking…") : h.checks.database === "ok" ? `Connected, ${h.checks.databaseLatencyMs ?? "?"} ms` : "Not reachable";
  const databaseTone = !h ? (health.isError ? "bad" : "plain") : h.checks.database === "ok" ? "go" : "bad";

  const worker = !w
    ? status.isError
      ? "No answer"
      : "Checking…"
    : w.state === "ok"
      ? `Running, last heartbeat ${w.ageSeconds ?? 0} s ago`
      : w.state === "stale"
        ? `Stopped ${formatDuration((w.ageSeconds ?? 0) / 60)} ago`
        : "Never started";
  const workerTone = !w ? (status.isError ? "bad" : "plain") : w.state === "ok" ? "go" : "warn";

  return (
    <section aria-labelledby="system-title">
      <h2 id="system-title" className="mb-3 text-base font-semibold">
        System
      </h2>
      <dl className="grid divide-y divide-line-soft rounded-xl border border-line bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Fact name="Server" value={h ? `Version ${h.version}` : health.isError ? "No answer" : "Checking…"} tone={h ? "go" : health.isError ? "bad" : "plain"} />
        <Fact name="Database" value={database} tone={databaseTone} />
        <Fact name="Worker" value={worker} tone={workerTone} />
      </dl>
    </section>
  );
}
