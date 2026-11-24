"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/* --------------------------------- mailboxes -------------------------------- */

export interface DnsItem {
  key: "mx" | "spf" | "dmarc" | "dkim" | "alignment";
  status: "ok" | "warn" | "bad" | "info";
  title: string;
  detail: string;
  records: string[];
}
export interface DnsResult {
  domain: string;
  provider: string;
  items: DnsItem[];
  checkedAt: string;
}
export interface TestResult {
  smtp: { ok: boolean; message: string };
  imap: { ok: boolean; message: string };
  gmail?: { ok: boolean; message: string };
  at: string;
}

export interface Mailbox {
  id: number;
  label: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "starttls";
  smtpUser: string;
  smtpPasswordSet: boolean;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapSameAsSmtp: boolean;
  imapPasswordSet: boolean;
  dailyCap: number;
  warmupStartedOn: string;
  allowedToday: number;
  dkimSelector: string | null;
  active: boolean;
  lastTestAt: string | null;
  lastTest: TestResult | null;
  lastDnsAt: string | null;
  lastDns: DnsResult | null;
  gmailConnected: boolean;
  gmailConnectedAt: string | null;
  gmailError: string | null;
}

export type MailboxInput = Partial<Omit<Mailbox, "id" | "smtpPasswordSet" | "imapPasswordSet" | "allowedToday" | "warmupStartedOn" | "lastTestAt" | "lastTest" | "lastDnsAt" | "lastDns" | "gmailConnected" | "gmailConnectedAt" | "gmailError">> & {
  smtpPassword?: string;
  imapPassword?: string;
};

export function useMailboxes() {
  return useQuery({
    queryKey: ["mailboxes"],
    queryFn: async () => (await api.get<{
          items: Mailbox[];
          sendingEnabled: boolean;
          encryptionKeySet: boolean;
          mailDelivery: "direct" | "outbox";
          gmail: { available: boolean; redirectUri: string };
        }>("/mailboxes")).data,
  });
}

export function useSaveMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: MailboxInput & { id?: number }) =>
      (id ? await api.patch<Mailbox>(`/mailboxes/${id}`, body) : await api.post<Mailbox>("/mailboxes", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useDeleteMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/mailboxes/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

/** Asks the server for Google's sign-in address and goes there. */
export function useConnectGmail() {
  return useMutation({
    mutationFn: async (id: number) => (await api.post<{ url: string }>(`/mailboxes/${id}/gmail/start`, {})).data,
    onSuccess: (r) => {
      window.location.href = r.url;
    },
  });
}

export function useDisconnectGmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<Mailbox>(`/mailboxes/${id}/gmail/disconnect`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useTestMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<TestResult>(`/mailboxes/${id}/test`, {}, { timeout: 90_000 })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useDnsCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<DnsResult>(`/mailboxes/${id}/dns`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

/* --------------------------------- templates -------------------------------- */

export type TemplateKind = "outreach" | "job";
export interface Template {
  id: number;
  kind: TemplateKind;
  name: string;
  segment: "A" | "B" | null;
  offer: "chatbot" | "agent" | null;
  step: number;
  subject: string;
  body: string;
  seedKey: string | null;
  variables: string[];
  updatedAt: string;
}

export function useTemplates() {
  return useQuery({
    queryKey: ["templates"],
    queryFn: async () => (await api.get<{ items: Template[]; variables: { name: string; help: string }[] }>("/templates")).data,
  });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: Partial<Omit<Template, "id" | "seedKey" | "variables" | "updatedAt">> & { id?: number }) =>
      (id ? await api.patch<Template>(`/templates/${id}`, body) : await api.post<Template>("/templates", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/templates/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export interface PreviewSource {
  listId?: number;
  segment?: "A" | "B";
  country?: string;
  hiring?: boolean;
}
export interface PreviewItem {
  /** "place:12", "list:34" or "sample". */
  key: string;
  recipient: string;
  to: string | null;
  subject: string;
  text: string;
  missing: string[];
  unknown: string[];
  warnings: string[];
  headers: Record<string, string>;
  willSkip: boolean;
}

export function usePreview() {
  return useMutation({
    mutationFn: async (body: { templateId?: number; kind: TemplateKind; subject: string; body: string; mailboxId?: number; source: PreviewSource }) =>
      (await api.post<{ items: PreviewItem[]; sample: boolean; problems: string[]; mailbox: { id: number; fromEmail: string } | null }>("/templates/preview", body)).data,
  });
}

export function useTestAddresses() {
  return useQuery({
    queryKey: ["test-addresses"],
    queryFn: async () => (await api.get<{ items: string[] }>("/templates/test-addresses")).data.items,
  });
}

export function useTestSend() {
  return useMutation({
    mutationFn: async (body: { templateId?: number; kind: TemplateKind; subject: string; body: string; mailboxId: number; to: string; leadId?: number; listLeadId?: number }) =>
      (await api.post<{ sent: boolean; to: string; subject: string; recipient: string; warnings: string[]; queued?: boolean }>("/templates/test-send", body, { timeout: 90_000 })).data,
  });
}

/* ------------------------------- applications ------------------------------- */

export type ApplicationStatus = "draft" | "sent" | "failed" | "applied_elsewhere" | "interview" | "rejected" | "offer" | "no_answer";
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  failed: "Failed",
  applied_elsewhere: "Applied on their site",
  interview: "Interview",
  rejected: "Rejected",
  offer: "Offer",
  no_answer: "No answer",
};

export interface Application {
  id: number;
  jobAdId: number | null;
  job: { title: string; url: string; source: string } | null;
  placeId: number | null;
  company: string;
  role: string;
  toEmail: string | null;
  mailboxId: number | null;
  mailboxEmail: string | null;
  templateId: number | null;
  subject: string;
  body: string;
  cvFileIds: number[];
  status: ApplicationStatus;
  sentAt: string | null;
  messageId: string | null;
  error: string | null;
  note: string | null;
  hasPlaceholders: boolean;
  /** Sent from the hosted tool, still waiting in the outbox for my PC. */
  waiting: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CvFile {
  id: number;
  label: string;
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
}

export function useApplications(status: string) {
  return useQuery({
    queryKey: ["applications", status],
    queryFn: async () =>
      (
        await api.get<{ items: Application[]; total: number; byStatus: Partial<Record<ApplicationStatus, number>>; sendingEnabled: boolean; sentToday: number; perDay: number }>(
          "/applications",
          { params: { status } },
        )
      ).data,
  });
}

export function useApplication(id: number) {
  return useQuery({ queryKey: ["application", id], queryFn: async () => (await api.get<Application>(`/applications/${id}`)).data });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { jobAdId?: number; company?: string; role?: string; toEmail?: string; mailboxId?: number; templateId?: number }) =>
      (await api.post<Application>("/applications", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["applications"] }),
  });
}

export function useUpdateApplication(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<Pick<Application, "toEmail" | "mailboxId" | "subject" | "body" | "cvFileIds" | "status" | "note">>) =>
      (await api.patch<Application>(`/applications/${id}`, body)).data,
    onSuccess: (a) => {
      qc.setQueryData(["application", id], a);
      void qc.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

export function useDeleteApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/applications/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["applications"] }),
  });
}

export function useApplicationTestSend(id: number) {
  return useMutation({
    mutationFn: async (to: string) => (await api.post<{ sent: boolean; to: string; queued?: boolean }>(`/applications/${id}/test-send`, { to }, { timeout: 90_000 })).data,
  });
}

export function useSendApplication(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<Application>(`/applications/${id}/send`, {}, { timeout: 90_000 })).data,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["application", id] });
      void qc.invalidateQueries({ queryKey: ["applications"] });
      void qc.invalidateQueries({ queryKey: ["jobads"] });
    },
  });
}

export function useCvFiles() {
  return useQuery({ queryKey: ["cv-files"], queryFn: async () => (await api.get<{ items: CvFile[] }>("/applications/cv-files")).data.items });
}

export function useUploadCv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { label: string; fileName: string; dataBase64: string }) => (await api.post<CvFile>("/applications/cv-files", body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cv-files"] }),
  });
}

export function useDeleteCv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/applications/cv-files/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cv-files"] }),
  });
}

export const cvDownloadUrl = (id: number) => `${api.defaults.baseURL ?? "/api/v1"}/applications/cv-files/${id}/download`;
