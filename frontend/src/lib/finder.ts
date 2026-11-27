"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type Segment = "A" | "B";

export interface Country {
  code: string;
  name: string;
  enabled: boolean;
  blocked: boolean;
  allowWholeCountry: boolean;
  regionImports: boolean;
  /** Job search only: companies can be found and crawled to apply for jobs, never e-mailed for sales. */
  jobSearch: boolean;
  timezones: string[];
  outreachRules: { law: string; genericOnly: boolean; verified?: boolean; notes: string };
  regions: number;
  cities: number;
}

export interface Region {
  regionCode: string;
  name: string;
}

export interface City {
  geonameId: number;
  name: string;
  regionCode: string | null;
  regionName: string | null;
  population: number;
  timezone: string | null;
  defaultRadiusKm: number;
}

export interface Category {
  key: string;
  segment: Segment;
  label: string;
  value: number;
}

export interface DataSource {
  name: string;
  use: string;
  licence: string;
  url: string;
}

export interface FinderParams {
  country: string;
  regionCode?: string;
  cityGeonameId?: number;
  radiusKm?: number;
  segments: Segment[];
  categoryKeys?: string[];
}

export interface JobSummary {
  release?: string | null;
  area?: string | null;
  steps?: number;
  stepsDone?: number;
  stepsFailed?: number;
  rowGroupsPlanned?: number;
  scanned?: number;
  kept?: number;
  inserted?: number;
  updated?: number;
  /** Kept places whose Overture record lists an e-mail address. */
  withEmail?: number;
  overtureEmails?: number;
  overtureNoMx?: number;
  /** Leads usable right after the import, before any crawl. */
  readyNow?: number;
  bytes?: number;
  skipped?: Record<string, number>;
  bySegment?: Record<string, number>;
  byCategory?: Record<string, number>;
  unmapped?: Record<string, number>;
  // Crawl jobs
  leadsPlanned?: number;
  sites?: number;
  sitesDone?: number;
  sitesFailed?: number;
  readable?: number;
  byStatus?: Record<string, number>;
  pages?: number;
  sitesWithEmail?: number;
  emails?: number;
  leads?: number;
  leadsWithPrimary?: number;
  noMx?: number;
  overtureOnly?: number;
  jobBoards?: number;
  bySignal?: Record<string, number>;
}

export type JobStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface JobListItem {
  id: number;
  kind: "finder" | "geonames" | "crawl";
  status: JobStatus;
  dryRun: boolean;
  params: FinderParams & { countries?: string[]; label?: string };
  summary: JobSummary | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobEvent {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface StorageEstimate {
  ok: boolean;
  databaseMb: number;
  addedMb: number;
  projectedMb: number;
  limitMb: number;
}

export interface JobDetail extends JobListItem {
  tasks: Partial<Record<"queued" | "running" | "done" | "failed" | "cancelled", number>>;
  /** Estimates only: how big the database would get with these leads. */
  storage?: StorageEstimate | null;
  startedAt: string | null;
  events: JobEvent[];
}

export const isActive = (s: JobStatus) => s === "running" || s === "queued" || s === "paused";

export function useCountries() {
  return useQuery({
    queryKey: ["areas", "countries"],
    queryFn: async () => (await api.get<{ items: Country[] }>("/areas/countries")).data.items,
  });
}

export function useRegions(country: string | null) {
  return useQuery({
    queryKey: ["areas", "regions", country],
    queryFn: async () => (await api.get<{ items: Region[] }>(`/areas/countries/${country}/regions`)).data.items,
    enabled: !!country,
  });
}

export function useCitySearch(country: string | null, q: string) {
  return useQuery({
    queryKey: ["areas", "cities", country, q],
    queryFn: async () =>
      (await api.get<{ items: City[] }>(`/areas/countries/${country}/cities`, { params: { q: q || undefined, limit: 8 } }))
        .data.items,
    enabled: !!country,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ["finder", "categories"],
    queryFn: async () =>
      (await api.get<{ items: Category[]; dataSources: DataSource[]; taxonomyRelease: string }>("/finder/categories")).data,
    staleTime: Infinity,
  });
}

export function useJobs(kind?: "finder" | "geonames" | "crawl") {
  return useQuery({
    queryKey: ["finder", "jobs", kind ?? "all"],
    queryFn: async () =>
      (await api.get<{ items: JobListItem[]; total: number }>("/finder/jobs", { params: { kind, pageSize: 15 } })).data,
    refetchInterval: (query) => (query.state.data?.items.some((j) => isActive(j.status)) ? 3_000 : 30_000),
  });
}

export function useJob(id: number) {
  return useQuery({
    queryKey: ["finder", "job", id],
    queryFn: async () => (await api.get<JobDetail>(`/finder/jobs/${id}`)).data,
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? 3_000 : false),
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ params, dryRun }: { params: FinderParams; dryRun: boolean }) =>
      (await api.post<{ jobId: number }>(dryRun ? "/finder/estimate" : "/finder/jobs", params)).data.jobId,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finder", "jobs"] }),
  });
}

export function useSwitchCountry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { code: string; enabled: boolean; confirmRules?: boolean; confirmBlocked?: boolean }) => {
      const { code, ...body } = input;
      return (await api.patch<{ code: string; enabled: boolean }>(`/areas/countries/${code}`, body)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["areas", "countries"] }),
  });
}

export function useJobSearchCountry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { code: string; jobSearch: boolean }) =>
      (await api.patch<{ code: string; jobSearch: boolean }>(`/areas/countries/${input.code}/job-search`, { jobSearch: input.jobSearch })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["areas", "countries"] }),
  });
}

/** Countries that can be searched: outreach on, or job search only. */
export const searchable = (c: Country) => c.enabled || c.jobSearch;

export function useLoadGeonames() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (countries: string[]) =>
      (await api.post<{ jobId: number }>("/areas/geonames", { countries })).data.jobId,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finder", "jobs"] }),
  });
}

export function useJobAction(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: "pause" | "resume" | "cancel") =>
      (await api.post<{ status: JobStatus }>(`/finder/jobs/${id}/${action}`)).data.status,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["finder", "job", id] });
      void qc.invalidateQueries({ queryKey: ["finder", "jobs"] });
    },
  });
}

/** Plain words for why places were not kept. */
export const SKIP_LABELS: Record<string, string> = {
  no_website: "No website",
  platform_website: "Only a social, listing or booking page",
  low_confidence: "Overture is not sure the place exists",
  closed: "Closed",
  unmapped: "Not a kind of business we target",
  other_category: "A category you did not select",
  outside_outline: "Outside the area's border",
  no_name: "No name",
};

export const SEGMENT_LABELS: Record<Segment, { name: string; hint: string }> = {
  A: { name: "Agencies", hint: "White-label development partner" },
  B: { name: "Businesses", hint: "AI chatbot or AI agent" },
};

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Waiting",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function formatNumber(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString("en-GB");
}

export function formatBytes(b: number | undefined): string {
  const v = b ?? 0;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
