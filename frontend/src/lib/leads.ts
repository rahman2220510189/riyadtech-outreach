"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Segment } from "./finder";

export type CrawlStatus = "ok" | "partial" | "robots_blocked" | "bot_blocked" | "unreachable" | "not_html" | "platform" | "error";

export interface LeadFilters {
  segment?: Segment;
  country?: string;
  regionCode?: string;
  city?: string;
  category?: string;
  crawl?: "new" | "crawled" | "readable" | "problem";
  hasEmail?: boolean;
  signal?: string;
  bestOffer?: "chatbot" | "agent";
  /** Only companies whose website advertises a developer job. */
  hiring?: boolean;
  jobFlag?: "remote" | "visa" | "english" | "no_local_lang";
  minFit?: number;
  minNeed?: number;
  /** true: only leads on the suppression list. */
  suppressed?: boolean;
  q?: string;
  sort?: "score" | "fit" | "need" | "name" | "newest";
  page?: number;
}

/** Query parameters for the API (booleans as "true"/"false", empty values left out). */
export function filterParams(filters: LeadFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

/** Download link for the filtered leads (same filters as the list, no paging). */
export function exportUrl(filters: LeadFilters): string {
  const p = filterParams(filters);
  delete p.page;
  return `${api.defaults.baseURL ?? "/api/v1"}/leads/export.csv?${new URLSearchParams(p).toString()}`;
}

export interface LeadRow {
  id: number;
  segment: Segment;
  name: string;
  category: string;
  categoryLabel: string;
  country: string;
  regionCode: string | null;
  city: string | null;
  website: string;
  domain: string;
  crawlStatus: CrawlStatus | null;
  crawledAt: string | null;
  fitScore: number | null;
  needScore: number | null;
  leadScore: number | null;
  bestOffer: "chatbot" | "agent" | null;
  primaryEmail: string | null;
  suppressed: boolean;
  signals: string[];
  hiringRole: string | null;
  jobUrl: string | null;
  stackMatch: boolean | null;
  jobFlags: string[];
  applyEmail: string | null;
  outreachAllowed: boolean;
}

export interface LeadEmail {
  email: string;
  kind: "generic" | "named" | "role";
  domainMatch: "own" | "free" | "other";
  isPrimary: boolean;
  suppressed: boolean;
  firstName: string | null;
  mxValid: boolean | null;
  sourceUrl: string;
  context: string | null;
  origin: string;
  foundAt: string;
}

export interface LeadSignal {
  key: string;
  label: string;
  score: "need" | "fit";
  weight: number;
  value: string | null;
  evidenceUrl: string | null;
  snippet: string | null;
}

export interface CrawlPage {
  url: string;
  kind: string;
  status: number | null;
  bytes: number;
  ms: number;
  note?: string;
}

export interface LeadDetail extends Omit<LeadRow, "signals" | "hiringRole" | "jobUrl" | "stackMatch" | "jobFlags" | "applyEmail" | "suppressed"> {
  suppressed: boolean;
  jobSearchOnly: boolean;
  postcode: string | null;
  address: string | null;
  phone: string | null;
  timezone: string | null;
  locationCount: number;
  crawlStatusText: string | null;
  signalLine: string | null;
  firstName: string | null;
  overtureEmails: string[];
  emails: LeadEmail[];
  signals: LeadSignal[];
  crawl: {
    status: CrawlStatus;
    finalUrl: string | null;
    httpStatus: number | null;
    pages: CrawlPage[];
    robots: { status: string; crawlDelaySeconds: number | null; note: string } | null;
    tech: string[];
    jobBoard: { provider: string; boardUrl: string; jobs: number; developerJobs: number; note?: string } | null;
    error: string | null;
    finishedAt: string;
    jobId: number | null;
  } | null;
}

export interface SignalDef {
  key: string;
  label: string;
  segment: Segment | "*";
  score: "need" | "fit";
  weight: number;
}

export interface LeadStats {
  segment: Segment;
  leads: number;
  crawled: number;
  readable: number;
  withEmail: number;
  waiting: number;
  hiring: number;
}

export interface CrawlParams {
  segment?: Segment;
  country?: string;
  city?: string;
  categoryKeys?: string[];
  finderJobId?: number;
  onlyNew: boolean;
  onlyReadable?: boolean;
  onlyHiring?: boolean;
  limit: number;
}

export const CRAWL_STATUS_LABELS: Record<CrawlStatus, string> = {
  ok: "Read",
  partial: "Partly read",
  robots_blocked: "robots.txt says no",
  bot_blocked: "Blocks bots",
  unreachable: "Unreachable",
  not_html: "Not a web page",
  platform: "Platform page",
  error: "Error",
};

export function useLeads(filters: LeadFilters) {
  return useQuery({
    queryKey: ["leads", "list", filters],
    queryFn: async () =>
      (
        await api.get<{ items: LeadRow[]; total: number; page: number; pageSize: number }>("/leads", {
          params: filterParams(filters),
        })
      ).data,
    placeholderData: keepPreviousData,
  });
}

export function useLead(id: number | null) {
  return useQuery({
    queryKey: ["leads", "detail", id],
    queryFn: async () => (await api.get<LeadDetail>(`/leads/${id}`)).data,
    enabled: id !== null,
  });
}

export function useLeadStats() {
  return useQuery({
    queryKey: ["leads", "stats"],
    queryFn: async () => (await api.get<{ items: LeadStats[] }>("/leads/stats")).data.items,
    refetchInterval: 30_000,
  });
}

export function useSignalDefs() {
  return useQuery({
    queryKey: ["leads", "signals"],
    queryFn: async () => (await api.get<{ items: SignalDef[] }>("/leads/signals")).data.items,
    staleTime: Infinity,
  });
}

export function useCrawlCount(params: CrawlParams, enabled: boolean) {
  return useQuery({
    queryKey: ["leads", "crawl-count", params],
    queryFn: async () =>
      (await api.post<{ matching: number; leads: number; sites: number; label: string }>("/leads/crawl/count", params)).data,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useStartCrawl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: CrawlParams) => (await api.post<{ jobId: number }>("/leads/crawl", params)).data.jobId,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finder", "jobs"] }),
  });
}

/* --------------------------------- settings -------------------------------- */

export interface CrawlerSettings {
  maxPagesPerDomain: number;
  concurrency: number;
  minDelayMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxCrawlDelaySeconds: number;
  siteTimeLimitSeconds: number;
  recrawlDays: number;
}

export interface ScoreSettings {
  weights: Record<string, number>;
  agentThreshold: number;
}

export interface SettingsData {
  values: { crawler: CrawlerSettings; scores: ScoreSettings } & Record<string, unknown>;
  defaults: { crawler: CrawlerSettings; scores: ScoreSettings } & Record<string, unknown>;
  editable: string[];
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await api.get<SettingsData>("/settings")).data,
  });
}

export function useUpdateSettings(key: "crawler" | "scores" | "company" | "sending") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: object) => (await api.patch<{ changed: string[] }>(`/settings/${key}`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

/* -------------------------------- suppression ------------------------------- */

export type SuppressionReason = "unsubscribed" | "bounced" | "replied_no" | "manual" | "client";

export const REASON_LABELS: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  replied_no: "Replied no",
  manual: "Manual",
  client: "Client or partner",
};

export interface SuppressionRow {
  id: number;
  kind: "email" | "domain";
  value: string;
  reason: SuppressionReason;
  source: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function useSuppression(params: { q?: string; reason?: string; page: number }) {
  return useQuery({
    queryKey: ["suppression", params],
    queryFn: async () =>
      (
        await api.get<{ items: SuppressionRow[]; total: number; page: number; pageSize: number; byReason: Record<string, number> }>("/suppression", {
          params: filterParams(params as LeadFilters),
        })
      ).data,
    placeholderData: keepPreviousData,
  });
}

function useInvalidateSuppression() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["suppression"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["lists"] });
  };
}

export function useAddSuppression() {
  const done = useInvalidateSuppression();
  return useMutation({
    mutationFn: async (body: { value: string; reason: SuppressionReason; note?: string }) =>
      (await api.post<{ item: SuppressionRow }>("/suppression", body)).data,
    onSuccess: done,
  });
}

export function useImportSuppression() {
  const done = useInvalidateSuppression();
  return useMutation({
    mutationFn: async (body: { text: string; reason: SuppressionReason }) =>
      (await api.post<{ found: number; added: number; alreadyListed: number; invalid: string[] }>("/suppression/import", body)).data,
    onSuccess: done,
  });
}

export function useRemoveSuppression() {
  const done = useInvalidateSuppression();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete<{ removed: string }>(`/suppression/${id}`)).data,
    onSuccess: done,
  });
}

/* ------------------------------- imported lists ------------------------------ */

export type MappedField = "email" | "first_name" | "company" | "website" | "country" | "city";
export interface ListMapping extends Partial<Record<MappedField, string>> {
  email: string;
  custom: string[];
}

export interface CsvPreview {
  delimiter: string;
  headers: string[];
  sample: string[][];
  rows: number;
  truncated: boolean;
  maxRows: number;
  suggested: Partial<Record<MappedField, string>>;
}

export interface ImportCounts {
  ok: number;
  suppressed: number;
  duplicate: number;
  invalid: number;
}

export interface LeadListSummary {
  id: number;
  name: string;
  fileName: string | null;
  rowsTotal: number;
  counts: ImportCounts;
  createdAt: string;
}

export interface ListRow {
  id: number;
  rowNumber: number;
  email: string;
  firstName: string | null;
  company: string | null;
  website: string | null;
  country: string | null;
  city: string | null;
  custom: Record<string, string | null>;
  status: "ok" | "suppressed" | "duplicate";
  note: string | null;
  placeId: number | null;
}

export function usePreviewCsv() {
  return useMutation({
    mutationFn: async (text: string) => (await api.post<CsvPreview>("/lists/preview", { text })).data,
  });
}

export function useImportList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; fileName?: string; text: string; mapping: ListMapping }) =>
      (await api.post<{ id: number; rows: number; truncated: boolean; counts: ImportCounts }>("/lists", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });
}

export function useLists() {
  return useQuery({
    queryKey: ["lists"],
    queryFn: async () => (await api.get<{ items: LeadListSummary[] }>("/lists")).data.items,
  });
}

export function useList(id: number, params: { status?: string; q?: string; page: number }, enabled = true) {
  return useQuery({
    queryKey: ["lists", id, params],
    enabled,
    queryFn: async () =>
      (
        await api.get<LeadListSummary & { now: Partial<ImportCounts>; items: ListRow[]; total: number; page: number; pageSize: number }>(
          `/lists/${id}`,
          { params: filterParams(params as LeadFilters) },
        )
      ).data,
    placeholderData: keepPreviousData,
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete<{ deleted: number }>(`/lists/${id}`)).data,
    onSuccess: (_d, id) => {
      // Drop the deleted list's own queries (a refetch would only 404), refresh the overview.
      qc.removeQueries({ queryKey: ["lists", id] });
      return qc.invalidateQueries({ queryKey: ["lists"], exact: true });
    },
  });
}

export const listExportUrl = (id: number) => `${api.defaults.baseURL ?? "/api/v1"}/lists/${id}/export.csv`;
