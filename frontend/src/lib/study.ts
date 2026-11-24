"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type Level = "bachelor" | "master" | "both";
export type ProgramStatus = "interested" | "preparing" | "applied" | "interview" | "accepted" | "rejected" | "not_now";
export type EnglishRequirement = "moi_ok" | "varies" | "test_required" | "not_required";
export type DocKind =
  | "passport"
  | "photo"
  | "bsc_certificate"
  | "bsc_completion_letter"
  | "bsc_transcript"
  | "hsc_certificate"
  | "hsc_marksheet"
  | "ssc_certificate"
  | "ssc_marksheet"
  | "moi_letter"
  | "cv"
  | "motivation_letter"
  | "recommendation"
  | "ielts_result"
  | "other";

export const STATUS_LABELS: Record<ProgramStatus, string> = {
  interested: "Interested",
  preparing: "Preparing",
  applied: "Applied",
  interview: "Interview",
  accepted: "Accepted",
  rejected: "Rejected",
  not_now: "Not now",
};
export const ENGLISH_LABELS: Record<EnglishRequirement, string> = {
  moi_ok: "MOI letter accepted",
  varies: "Depends on the university",
  test_required: "English test required",
  not_required: "No English test",
};
export const LEVEL_LABELS: Record<Level, string> = { bachelor: "Bachelor", master: "Master", both: "Bachelor & Master" };

export interface StudyProfile {
  fullName: string;
  nationality: string;
  dateOfBirth: string | null;
  phone: string | null;
  targetLevel: Level;
  targetFields: string[];
  bscSubject: string | null;
  bscUniversity: string | null;
  bscCgpa: number | null;
  bscCgpaScale: number;
  bscYear: number | null;
  hscGpa: number | null;
  hscYear: number | null;
  sscGpa: number | null;
  sscYear: number | null;
  englishMedium: boolean;
  ieltsScore: number | null;
  duolingoScore: number | null;
  passportStatus: "none" | "applied" | "ready";
  passportExpiry: string | null;
  workExperience: string | null;
  aboutMe: string | null;
}

export interface StudyDocument {
  id: number;
  kind: DocKind;
  kindLabel: string;
  label: string;
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface StudyDate {
  id: number;
  label: string;
  kind: "deadline" | "opens" | "reminder";
  dueOn: string;
  daysLeft: number;
  confirmed: boolean;
  done: boolean;
  note: string | null;
}

export interface Program {
  id: number;
  name: string;
  kind: "scholarship" | "programme";
  country: string;
  university: string | null;
  level: Level;
  field: string | null;
  englishRequirement: EnglishRequirement;
  minIelts: number | null;
  funding: string | null;
  costs: string | null;
  workWhileStudying: string | null;
  applyUrl: string | null;
  infoUrl: string | null;
  contactEmail: string | null;
  requiredDocs: DocKind[];
  howToApply: string | null;
  notes: string | null;
  status: ProgramStatus;
  verified: boolean;
  seedKey: string | null;
  origin: "seed" | "manual" | "auto";
  window: AppWindow | null;
  subjectFit: SubjectFit;
  newFindings?: number;
  english: { fit: "yes" | "maybe" | "no"; why: string };
  docsNeeded: { kind: DocKind; label: string; have: boolean }[];
  docsMissing: number;
  nextDate: { id: number; label: string; kind: string; dueOn: string; daysLeft: number; confirmed: boolean } | null;
  deadlines: StudyDate[];
  emails?: { id: number; purpose: string; subject: string; status: string; toEmail: string | null; sentAt: string | null; updatedAt: string }[];
}

export interface UpcomingDate {
  id: number;
  programId: number;
  program: string;
  label: string;
  kind: "deadline" | "opens" | "reminder";
  dueOn: string;
  daysLeft: number;
  confirmed: boolean;
}

export interface StudyEmail {
  id: number;
  programId: number | null;
  program: string | null;
  purpose: "inquiry" | "application" | "follow_up";
  toEmail: string | null;
  mailboxId: number | null;
  subject: string;
  body: string;
  documentIds: number[];
  aiModel: string | null;
  status: "draft" | "sent" | "failed";
  sentAt: string | null;
  error: string | null;
  hasPlaceholders: boolean;
  updatedAt: string;
}

/** "in 12 days", "today", "3 days ago". */
export function whenText(daysLeft: number): string {
  if (daysLeft === 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  if (daysLeft < 0) return `${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
  return `in ${daysLeft} days`;
}

export function urgency(daysLeft: number): "red" | "orange" | "calm" {
  if (daysLeft <= 14) return "red";
  if (daysLeft <= 30) return "orange";
  return "calm";
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ["study-overview", "study-programs", "study-program", "study-upcoming", "study-documents", "study-emails"]) void qc.invalidateQueries({ queryKey: [k] });
};

export function useStudyOverview() {
  return useQuery({
    queryKey: ["study-overview"],
    queryFn: async () =>
      (
        await api.get<{
          steps: { id: string; text: string; link: string; urgent: boolean }[];
          counts: Record<ProgramStatus, number>;
          documents: number;
          sentEmails: number;
          findings: number;
          openNow: { id: number; name: string; country: string; applyUrl: string | null; window: AppWindow }[];
          subjects: { topic: string; label: string; why: string }[];
          bestMatches: { id: number; name: string; country: string; reason: string; window: AppWindow | null }[];
          ai: { configured: boolean; model: string };
        }>("/study/overview")
      ).data,
  });
}

export function useUpcoming(days = 120) {
  return useQuery({
    queryKey: ["study-upcoming", days],
    queryFn: async () => (await api.get<{ items: UpcomingDate[] }>("/study/upcoming", { params: { days } })).data.items,
    refetchInterval: 30 * 60_000,
    staleTime: 5 * 60_000,
  });
}

export function useStudyProfile() {
  return useQuery({ queryKey: ["study-profile"], queryFn: async () => (await api.get<StudyProfile>("/study/profile")).data });
}

export function useSaveStudyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<StudyProfile>) => (await api.put<StudyProfile>("/study/profile", body)).data,
    onSuccess: (p) => {
      qc.setQueryData(["study-profile"], p);
      invalidate(qc);
    },
  });
}

export function useStudyDocuments() {
  return useQuery({
    queryKey: ["study-documents"],
    queryFn: async () => (await api.get<{ items: StudyDocument[]; kinds: { kind: DocKind; label: string }[] }>("/study/documents")).data,
  });
}

export function useUploadStudyDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { kind: DocKind; label?: string; fileName: string; dataBase64: string }) => (await api.post<StudyDocument>("/study/documents", body)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteStudyDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/study/documents/${id}`)).data,
    onSuccess: () => invalidate(qc),
  });
}

export const studyDocumentUrl = (id: number) => `${api.defaults.baseURL ?? "/api/v1"}/study/documents/${id}/download`;

/** Does the subject suit me (from my profile), with reasons and hard-requirement warnings. */
export interface SubjectFit {
  level: "strong" | "related" | "weak" | "any";
  reasons: string[];
  warnings: string[];
}
export const FIT_LEVEL_TEXT: Record<SubjectFit["level"], string> = { strong: "Strong match", related: "Related to your degree", weak: "Weak match", any: "Any subject" };
export const FIT_LEVEL_STYLE: Record<SubjectFit["level"], string> = {
  strong: "bg-go text-white",
  related: "bg-go-soft text-go",
  weak: "bg-bad-soft text-bad",
  any: "bg-paper text-ink-2",
};

/** Whether the application is open: from the programme's dates (or a date found on its website). */
export interface AppWindow {
  state: "open" | "likely_open" | "opens_soon";
  deadline?: string;
  opensOn?: string;
  daysLeft: number;
  fromWebsite?: boolean;
}

export const WINDOW_TEXT: Record<AppWindow["state"], string> = { open: "Open now", likely_open: "Probably open", opens_soon: "Opens soon" };

export function usePrograms(params: { status?: string; level?: string; fit?: string; origin?: string; open?: string; sort?: string }) {
  return useQuery({
    queryKey: ["study-programs", params],
    queryFn: async () => (await api.get<{ items: Program[] }>("/study/programs", { params })).data.items,
  });
}

export function useProgram(id: number) {
  return useQuery({ queryKey: ["study-program", id], queryFn: async () => (await api.get<Program>(`/study/programs/${id}`)).data });
}

export type ProgramInput = Partial<Omit<Program, "id" | "english" | "docsNeeded" | "docsMissing" | "nextDate" | "deadlines" | "emails" | "seedKey">>;

export function useSaveProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: ProgramInput & { id?: number }) =>
      (id ? await api.patch<Program>(`/study/programs/${id}`, body) : await api.post<Program>("/study/programs", body)).data,
    onSuccess: (p) => {
      qc.setQueryData<Program>(["study-program", p.id], (old) => (old ? { ...p, emails: old.emails } : p));
      invalidate(qc);
    },
  });
}

export function useDeleteProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/study/programs/${id}`)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useAddDate(programId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { label: string; kind: StudyDate["kind"]; dueOn: string; confirmed: boolean }) => (await api.post(`/study/programs/${programId}/deadlines`, body)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; done?: boolean; confirmed?: boolean; dueOn?: string; label?: string }) => (await api.patch(`/study/deadlines/${id}`, body)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/study/deadlines/${id}`)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useStudyEmails(params: { programId?: number } = {}) {
  return useQuery({
    queryKey: ["study-emails", params],
    queryFn: async () => (await api.get<{ items: StudyEmail[]; sendingEnabled: boolean; ai: { configured: boolean; model: string } }>("/study/emails", { params })).data,
  });
}

export function useStudyEmail(id: number) {
  return useQuery({ queryKey: ["study-email", id], queryFn: async () => (await api.get<StudyEmail>(`/study/emails/${id}`)).data });
}

export function useCreateStudyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { programId?: number; purpose: StudyEmail["purpose"]; useAi: boolean; extra?: string; mailboxId?: number }) =>
      (await api.post<StudyEmail>("/study/emails", body, { timeout: 120_000 })).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateStudyEmail(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<Pick<StudyEmail, "toEmail" | "mailboxId" | "subject" | "body" | "documentIds" | "purpose">>) =>
      (await api.patch<StudyEmail>(`/study/emails/${id}`, body)).data,
    onSuccess: (e) => {
      qc.setQueryData(["study-email", id], e);
      invalidate(qc);
    },
  });
}

export function useRedraftStudyEmail(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (extra: string) => (await api.post<StudyEmail>(`/study/emails/${id}/redraft`, extra ? { extra } : {}, { timeout: 120_000 })).data,
    onSuccess: (e) => qc.setQueryData(["study-email", id], e),
  });
}

export function useDeleteStudyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.delete(`/study/emails/${id}`)).data,
    onSuccess: () => invalidate(qc),
  });
}

export function useStudyTestSend(id: number) {
  return useMutation({ mutationFn: async (to: string) => (await api.post<{ sent: boolean; to: string }>(`/study/emails/${id}/test-send`, { to }, { timeout: 90_000 })).data });
}

export function useStudySend(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<StudyEmail>(`/study/emails/${id}/send`, {}, { timeout: 90_000 })).data,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["study-email", id] });
      invalidate(qc);
    },
  });
}

export function useAiTest() {
  return useMutation({ mutationFn: async () => (await api.post<{ ok: boolean; model: string; answer: string; ms: number }>("/study/ai/test", {}, { timeout: 90_000 })).data });
}

/* ------------------------- universities and daily check ------------------------- */

export type UniversityStatus = "new" | "found" | "nothing" | "unreadable" | "skipped";
export const UNIVERSITY_STATUS: Record<UniversityStatus, string> = {
  new: "Not read yet",
  found: "Useful facts found",
  nothing: "Nothing found",
  unreadable: "Could not be read",
  skipped: "Skipped",
};

export interface StudySettings {
  autoCheck: boolean;
  newSitesPerDay: number;
  maxPagesPerSite: number;
  retryNothingDays: number;
  directoryRefreshDays: number;
  rorClientId: string;
  countries: string[];
  aiSearch: boolean;
  aiCountriesPerDay: number;
}

export interface WatchJob {
  id: number;
  status: string;
  label: string;
  summary: Record<string, number> | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface University {
  id: number;
  name: string;
  country: string;
  countryCode: string;
  website: string;
  domain: string;
  sources: string[];
  status: UniversityStatus;
  note: string | null;
  lastCheckedAt: string | null;
  programId: number | null;
}

export interface UniversitiesData {
  items: University[];
  total: number;
  page: number;
  counts: Partial<Record<UniversityStatus, number>>;
  countries: { code: string; name: string; n: number }[];
  sources: { key: string; name: string; n: number }[];
  europe: number;
  lastDirectoryJob: WatchJob | null;
  lastCheckJob: WatchJob | null;
  lastAiJob: WatchJob | null;
  aiConfigured: boolean;
  settings: StudySettings;
}

const watchActive = (d?: UniversitiesData) => [d?.lastDirectoryJob?.status, d?.lastCheckJob?.status, d?.lastAiJob?.status].some((s) => s === "running" || s === "queued");

export function useUniversities(params: { country?: string; status?: string; q?: string; page?: number }) {
  return useQuery({
    queryKey: ["study-universities", params],
    queryFn: async () => (await api.get<UniversitiesData>("/study/universities", { params })).data,
    refetchInterval: (q) => (watchActive(q.state.data) ? 5_000 : false),
  });
}

const invalidateWatch = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ["study-universities", "study-findings", "study-programs", "study-program", "study-overview", "study-upcoming"]) void qc.invalidateQueries({ queryKey: [k] });
};

export function useRefreshDirectory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<{ jobId: number }>("/study/universities/refresh", {})).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useStartCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { newSites?: number }) => (await api.post<{ jobId: number }>("/study/check", body)).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useAiSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (countries: string[]) => (await api.post<{ jobId: number }>("/study/ai-search", { countries })).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useCheckUniversity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<{ jobId: number }>(`/study/universities/${id}/check`, {})).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useSetUniversityStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "new" | "skipped" }) => (await api.patch(`/study/universities/${id}`, { status })).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useCheckProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => (await api.post<{ jobId: number }>(`/study/programs/${id}/check`, {})).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function useSaveStudySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<StudySettings>) => (await api.patch<{ changed: string[] }>("/settings/study", body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["study-universities"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface Finding {
  id: number;
  programId: number;
  program: string;
  country: string;
  origin: Program["origin"];
  type: "deadline" | "ielts" | "moi" | "email";
  value: string;
  label: string | null;
  snippet: string;
  url: string;
  status: "new" | "accepted" | "dismissed";
  createdAt: string;
}

export function useFindings(params: { status?: string; programId?: number } = {}) {
  return useQuery({
    queryKey: ["study-findings", params],
    queryFn: async () => (await api.get<{ items: Finding[]; newTotal: number }>("/study/findings", { params })).data,
  });
}

export function useDecideFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "accept" | "dismiss" }) => (await api.post(`/study/findings/${id}/${action}`, {})).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

export function usePasteText(programId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { text: string; url?: string }) => (await api.post<{ added: number }>(`/study/programs/${programId}/paste`, body)).data,
    onSuccess: () => invalidateWatch(qc),
  });
}

/* ---------------------------- Motivation letter (one per programme) ---------------------------- */

export interface StudyLetter {
  id: number;
  programId: number;
  title: string;
  body: string;
  notes: string | null;
  aiModel: string | null;
  updatedAt: string;
  words: number;
  gaps: string[];
}

export interface LetterPage {
  letter: StudyLetter | null;
  program: { id: number; name: string; university: string | null; country: string };
  ai: { configured: boolean; model: string };
}

export function useLetter(programId: number) {
  return useQuery({ queryKey: ["study-letter", programId], queryFn: async () => (await api.get<LetterPage>(`/study/programs/${programId}/letter`)).data });
}

export function useDraftLetter(programId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { notes?: string; length: "standard" | "short" }) =>
      (await api.post<{ letter: StudyLetter }>(`/study/programs/${programId}/letter/draft`, body, { timeout: 150_000 })).data.letter,
    onSuccess: (letter) => qc.setQueryData<LetterPage>(["study-letter", programId], (old) => (old ? { ...old, letter } : old)),
  });
}

export function useSaveLetter(programId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title: string; body: string; notes?: string | null }) => (await api.put<{ letter: StudyLetter }>(`/study/programs/${programId}/letter`, body)).data.letter,
    onSuccess: (letter) => qc.setQueryData<LetterPage>(["study-letter", programId], (old) => (old ? { ...old, letter } : old)),
  });
}

export function useDeleteLetter(programId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.delete(`/study/programs/${programId}/letter`)).data,
    onSuccess: () => qc.setQueryData<LetterPage>(["study-letter", programId], (old) => (old ? { ...old, letter: null } : old)),
  });
}
