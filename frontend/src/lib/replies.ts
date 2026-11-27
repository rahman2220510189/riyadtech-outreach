"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type ReplyKind = "reply" | "auto_reply" | "unsubscribe" | "bounce";

export interface ReplyItem {
  id: number;
  kind: ReplyKind;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  done: boolean;
  company: string | null;
  website: string | null;
  campaignId: number | null;
  campaign: string | null;
}

export interface RepliesData {
  open: number;
  mailboxes: { id: number; fromEmail: string; checkedAt: string | null; error: string | null }[];
  items: ReplyItem[];
}

export const KIND_TEXT: Record<ReplyKind, string> = {
  reply: "Reply",
  unsubscribe: "Said no",
  auto_reply: "Out of office",
  bounce: "Bounced",
};

export function useReplies(show: "open" | "all") {
  return useQuery({ queryKey: ["replies", show], queryFn: async () => (await api.get<RepliesData>(`/replies?show=${show}`)).data, refetchInterval: 60_000 });
}

export function useReplyDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: number; done: boolean }) => (await api.post(`/replies/${v.id}/done`, { done: v.done })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["replies"] }),
  });
}

export function useCheckReplies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post("/replies/check", {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["replies"] });
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}
