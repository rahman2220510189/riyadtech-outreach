"use client";

import { useState } from "react";

/**
 * Downloads a file from the API and saves it, showing a readable message when the
 * backend refuses or cannot be reached (a plain link would only show "download failed").
 */
export function DownloadButton({ url, fallbackName, label, title }: { url: string; fallbackName: string; label: string; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const unreachable = "The backend cannot be reached. Is npm run dev:all running?";
        let message = res.status >= 500 ? unreachable : `The export failed (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { error?: { message?: string }; message?: string };
          message = body.error?.message ?? body.message ?? `The export failed (HTTP ${res.status}).`;
        } catch {
          /* not JSON: the website could not forward the request to the backend */
        }
        if (res.status === 400 || res.status === 404) message += " Is the backend running the latest version? Restart npm run dev:all.";
        throw new Error(message);
      }
      const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      setError(err instanceof TypeError ? "The backend cannot be reached. Is npm run dev:all running?" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={title}
        className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium hover:bg-paper disabled:opacity-60"
      >
        {busy ? "Preparing…" : label}
      </button>
      {error && (
        <span role="alert" className="mt-1 max-w-xs text-xs text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
