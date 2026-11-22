"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { PasswordInput } from "@/components/PasswordInput";
import { SendWindows } from "@/components/SendWindows";
import { WAKE_UP_HINT, useSlowHint } from "@/components/useSlowHint";
import { Wordmark } from "@/components/Wordmark";
import { useLogin, useMe } from "@/lib/auth";

/** Only same-site paths, never "//evil.com" or "https://...". */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const me = useMe();
  const login = useLogin();
  const slow = useSlowHint(login.isPending);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Already logged in: go straight on.
  useEffect(() => {
    if (me.data) router.replace(next);
  }, [me.data, next, router]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => router.replace(next) });
  };

  const error = login.error;

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-sm">
      <Wordmark />
      <h1 className="mt-10 text-2xl font-semibold tracking-tight">Log in</h1>

      <div className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            E-mail
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-ink focus:ring-2 focus:ring-ink/15"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="block w-full rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-ink focus:ring-2 focus:ring-ink/15"
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-bad-soft px-3 py-2.5 text-sm text-bad">
          {error.message}
        </p>
      )}

      <button
        type="submit"
        disabled={login.isPending || !email || !password}
        className="mt-6 w-full rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {login.isPending ? "Logging in…" : "Log in"}
      </button>

      {slow && (
        <p className="mt-3 text-sm text-ink-3" role="status">
          {WAKE_UP_HINT}
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-[minmax(22rem,30rem)_1fr]">
      <div className="flex justify-center bg-surface px-6 py-12 lg:items-center lg:border-r lg:border-line lg:py-0">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
      <div className="flex items-center px-5 py-10 sm:px-10">
        <div className="w-full">
          <SendWindows />
        </div>
      </div>
    </main>
  );
}
