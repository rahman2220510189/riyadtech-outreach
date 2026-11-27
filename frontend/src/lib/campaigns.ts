"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type CampaignStatus = "draft" | "running" | "paused" | "stopped" | "done";
export type CampaignLeadStatus = "waiting_crawl" | "queued" | "done" | "stopped" | "replied" | "skipped" | "failed" | "bounced";

export interface Campaign {
  id: number;
  name: string;
  segment: "A" | "B";
  country: string;
  categoryKeys: string[];
  mailboxId: number;
  mailbox: string | null;
  status: CampaignStatus;
  sendLimit: number | null;
  note: string | null;
  crawlJobId: number | null;
  createdAt: string;
  startedAt: string | null;
  leads: Record<CampaignLeadStatus, number>;
  sent: number;
  previews: number;
  failed: number;
}

export interface CampaignLeadRow {
  id: number;
  company: string;
  website: string;
  city: string | null;
  email: string;
  offer: string | null;
  step: number;
  status: CampaignLeadStatus;
  nextAt: string | null;
  reason: string | null;
  sends: { step: number; status: string; createdAt: string }[];
}

export interface CampaignDetail extends Omit<Campaign, "leads"> {
  leads: CampaignLeadRow[];
}

export interface CampaignOptions {
  mailboxes: { id: number; label: string; fromEmail: string; gmail: boolean }[];
  countries: { code: string; name: string; ready: { A: number; B: number } }[];
  categories: { key: string; label: string; segment: "A" | "B" }[];
  sendingEnabled: boolean;
  postalAddressSet: boolean;
  firstCampaign: boolean;
}

export interface PreviewItem {
  leadId: number;
  company: string;
  to: string;
  waitingForCrawl: boolean;
  subject: string | null;
  text: string | null;
  missing: string[];
  template: string | null;
}

export const LEAD_STATUS_TEXT: Record<CampaignLeadStatus, string> = {
  waiting_crawl: "Reading website",
  queued: "Waiting",
  done: "All sent",
  stopped: "Stopped",
  replied: "Replied",
  skipped: "Skipped",
  failed: "Failed",
  bounced: "Bounced",
};

export const STATUS_TEXT: Record<CampaignStatus, string> = { draft: "Draft", running: "Running", paused: "Paused", stopped: "Stopped", done: "Done" };

export function useCampaignOptions() {
  return useQuery({ queryKey: ["campaigns", "options"], queryFn: async () => (await api.get<CampaignOptions>("/campaigns/options")).data });
}

export function useCampaigns() {
  return useQuery({ queryKey: ["campaigns", "list"], queryFn: async () => (await api.get<{ items: Campaign[] }>("/campaigns")).data.items, refetchInterval: 30_000 });
}

export function useCampaign(id: number) {
  return useQuery({ queryKey: ["campaigns", id], queryFn: async () => (await api.get<CampaignDetail>(`/campaigns/${id}`)).data, refetchInterval: 20_000 });
}

export function useCampaignPreview(id: number, step: number) {
  return useQuery({ queryKey: ["campaigns", id, "preview", step], queryFn: async () => (await api.get<{ items: PreviewItem[] }>(`/campaigns/${id}/preview?step=${step}&limit=3`)).data.items });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; segment: "A" | "B"; country: string; categoryKeys: string[]; mailboxId: number; size: number }) =>
      (await api.post<{ id: number; leads: number }>("/campaigns", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function useCampaignAction(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: "launch" | "pause" | "stop") => (await api.post(`/campaigns/${id}/${action}`, {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
      void qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/campaigns/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function useStopCampaignLead(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { leadId: number; reason: "replied" | "manual" }) => (await api.post(`/campaigns/${id}/leads/${v.leadId}/stop`, { reason: v.reason })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns", id] }),
  });
}
