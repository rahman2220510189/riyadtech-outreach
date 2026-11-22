"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/lib/api";

/** Public page behind the link in every e-mail: unsubscribes at once (no login, no button needed). */
export function Unsubscribe({ token }: { token: string }) {
  const run = useMutation({
    mutationFn: async () => (await api.post<{ email: string; unsubscribed: boolean }>(`/u/${encodeURIComponent(token)}`, {})).data,
  });
  const { mutate } = run;
  useEffect(() => {
    mutate();
  }, [mutate]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-xl border border-line bg-surface px-6 py-8">
        <p className="text-sm text-ink-3">Riyad Tech</p>
        {run.isPending || run.isIdle ? (
          <p className="mt-3 text-ink-2">One moment…</p>
        ) : run.isSuccess ? (
          <>
            <h1 className="mt-2 text-xl font-semibold">You are unsubscribed</h1>
            <p className="mt-2 text-ink-2">
              {run.data.email} will not receive any more e-mails from us. Sorry for the interruption.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-xl font-semibold">This link did not work</h1>
            <p className="mt-2 text-ink-2">Please reply to the e-mail with the word “unsubscribe” and we will remove you by hand.</p>
          </>
        )}
      </div>
    </main>
  );
}
