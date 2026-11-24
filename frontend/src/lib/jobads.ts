"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { JobStatus } from "./finder";

export type JobSource = "ba" | "arbeitnow";
export type JobAdStatus = "new" | "saved" | "hidden" | "applied";

export const SOURCE_LABELS: Record<JobSource, string> = { ba: "Bundesagentur für Arbeit", arbeitnow: "Arbeitnow" };

export const FLAG_LABELS: Record<string, string> = {
  remote: "Remote",
  visa: "Visa / relocation",
  english_team: "English team",
  ad_english: "Advert in English",
  local_lang: "Fluent German",
};

export interface JobAdFilters {
  q?: string;
  source?: JobSource;
  dev?: boolean;
  stack?: boolean;
  flag?: "remote" | "visa" | "english" | "no_local_lang";
  place?: string;
  days?: number;
  status?: "open" | JobAdStatus | "all";
  linked?: boolean;
  /** entry: junior roles and roles without a level (no senior, lead or student jobs). */
  level?: "any" | "entry";
  fit?: "good" | "possible";
  sort?: "newest" | "company" | "fit";
  page?: number;
}

export type GermanLevel = "none" | "a1" | "a2" | "b1" | "b2" | "c1" | "c2";
export interface JobProfile {
  skills: string[];
  yearsExperience: number;
  germanLevel: GermanLevel;
}

export interface JobFit {
  level: "good" | "possible" | "unlikely";
  score: number;
  seniority: "student" | "junior" | "senior" | "open";
  years: number | null;
  german: "fluent" | "good" | "some" | "none";
  matched: string[];
  missing: string[];
  reasons: string[];
  warnings: string[];
}

export const FIT_TEXT: Record<JobFit["level"], string> = { good: "Good match", possible: "Possible", unlikely: "Unlikely" };
export const FIT_STYLE: Record<JobFit["level"], string> = {
  good: "bg-go text-white",
  possible: "bg-go-soft text-go",
  unlikely: "bg-bad-soft text-bad",
};

export interface JobAd {
  id: number;
  source: JobSource;
  sourceLabel: string;
  title: string;
  role: string | null;
  company: string;
  location: string | null;
  country: string | null;
  url: string;
  externalUrl: string | null;
  excerpt: string | null;
  tags: string[];
  jobTypes: string[];
  isDev: boolean;
  stackMatch: boolean;
  flags: string[];
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobAdStatus;
  note: string | null;
  fit: JobFit;
  lead: { id: number; name: string; domain: string; applyEmail: string | null } | null;
}

export interface JobAdStats {
  sources: { source: JobSource; label: string; ads: number; lastSeenAt: string | null }[];
  openDev: number;
  byStatus: Partial<Record<JobAdStatus, number>>;
  lastFetch: {
    id: number;
    status: JobStatus;
    label: string | null;
    summary: { ads?: number; dev?: number; stack?: number; remote?: number; visa?: number; english?: number; linked?: number; added?: number; failed?: number } | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
    events: { at: string; level: "info" | "warn" | "error"; message: string }[];
  } | null;
}

export interface FetchParams {
  sources: JobSource[];
  keywords: string[];
  where?: string;
  radiusKm: number;
  days: number;
  maxPages: number;
  details: number;
}

function params(f: JobAdFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  return out;
}

export function useJobAds(filters: JobAdFilters) {
  return useQuery({
    queryKey: ["jobads", filters],
    queryFn: async () => (await api.get<{ items: JobAd[]; total: number; page: number; pageSize: number; profile: JobProfile }>("/jobads", { params: params(filters) })).data,
    placeholderData: keepPreviousData,
  });
}

let lastSearchKey: string | null = null;
const active = (s: JobStatus | undefined) => s === "queued" || s === "running";

export function useJobAdStats() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["jobads-stats"],
    queryFn: async () => {
      const data = (await api.get<JobAdStats>("/jobads/stats")).data;
      // While a search runs (and once when it ends), new adverts arrive: refresh the list too.
      const key = data.lastFetch ? `${data.lastFetch.id}:${data.lastFetch.status}` : "";
      if (active(data.lastFetch?.status) || (lastSearchKey !== null && key !== lastSearchKey)) void qc.invalidateQueries({ queryKey: ["jobads"] });
      lastSearchKey = key;
      return data;
    },
    refetchInterval: (query) => (active(query.state.data?.lastFetch?.status) ? 3_000 : false),
  });
}

export function useStartJobSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: FetchParams) => (await api.post<{ jobId: number }>("/jobads/fetch", p)).data.jobId,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobads-stats"] }),
  });
}

export function useCancelJobSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<{ status: JobStatus }>(`/jobads/fetch/${id}/cancel`)).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobads-stats"] }),
  });
}

export function useUpdateJobAd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; status?: JobAdStatus; note?: string | null }) =>
      (await api.patch<{ id: number; status: JobAdStatus; note: string | null }>(`/jobads/${id}`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jobads"] });
      void qc.invalidateQueries({ queryKey: ["jobads-stats"] });
    },
  });
}

export function useSaveJobProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<JobProfile>) => (await api.patch<{ changed: string[] }>("/settings/jobProfile", body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jobads"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
