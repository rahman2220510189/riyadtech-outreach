"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type WorkerState = "ok" | "stale" | "never";

export interface SystemStatus {
  server: { version: string; uptimeSeconds: number };
  worker: {
    state: WorkerState;
    lastBeatAt: string | null;
    ageSeconds: number | null;
    startedAt: string | null;
    version: string | null;
    staleAfterSeconds: number;
  };
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  checks: { database: "ok" | "error" | "not_configured"; databaseLatencyMs?: number };
}

/** Worker heartbeat, refreshed every 30 s (the worker beats every 30 s). */
export function useSystemStatus(enabled = true) {
  return useQuery({
    queryKey: ["system", "status"],
    queryFn: async () => (await api.get<SystemStatus>("/system/status")).data,
    refetchInterval: 30_000,
    enabled,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: async () => (await api.get<Health>("/health")).data,
    refetchInterval: 60_000,
  });
}
