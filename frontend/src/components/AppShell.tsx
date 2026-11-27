"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useLogout, useMe } from "@/lib/auth";
import { WAKE_UP_HINT, useSlowHint } from "./useSlowHint";
import { DeadlineBar } from "./study/DeadlineBar";
import { WorkerBanner } from "./WorkerBanner";
import { Wordmark } from "./Wordmark";

/** Pages are added here as each phase is built. */
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/finder", label: "Finder" },
  { href: "/leads", label: "Leads" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/study", label: "Study abroad" },
  { href: "/job-search", label: "Job search" },
  { href: "/applications", label: "Applications" },
  { href: "/templates", label: "Templates" },
  { href: "/mailboxes", label: "Mailboxes" },
  { href: "/suppression", label: "Suppression" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const logout = useLogout();
  const router = useRouter();
  const pathname = usePathname();
  const slow = useSlowHint(me.isPending);

  useEffect(() => {
    if (me.data === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.data, pathname, router]);

  if (me.isPending || me.data === null) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
        <Wordmark />
        <p className="mt-6 text-ink-2" role="status">
          Checking your session…
        </p>
        {slow && <p className="mt-2 max-w-sm text-sm text-ink-3">{WAKE_UP_HINT}</p>}
      </main>
    );
  }

  if (me.isError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <Wordmark />
        <h1 className="mt-8 text-xl font-semibold">Can&apos;t reach the server</h1>
        <p className="mt-2 text-ink-2">{me.error.message}</p>
        <button
          type="button"
          onClick={() => void me.refetch()}
          className="mt-6 self-start rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90"
        >
          Try again
        </button>
      </main>
    );
  }

  const onLogout = () => {
    logout.mutate(undefined, { onSettled: () => router.replace("/login") });
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="border-b border-line bg-surface lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 lg:sticky lg:top-0 lg:h-dvh lg:flex-col lg:flex-nowrap lg:items-stretch lg:justify-start lg:px-4 lg:py-6">
        <Link href="/dashboard" className="rounded px-2">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="order-last -mx-2 w-[calc(100%+1rem)] overflow-x-auto lg:order-none lg:mx-0 lg:mt-8 lg:w-auto lg:flex-1">
          <ul className="flex gap-1 lg:flex-col">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-2 text-sm font-medium ${
                      active ? "bg-paper text-ink" : "text-ink-2 hover:bg-paper hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex items-center gap-3 lg:flex-col lg:items-stretch lg:border-t lg:border-line-soft lg:pt-4">
          <p className="hidden truncate px-2 text-sm text-ink-2 sm:block" title={me.data.email}>
            {me.data.email}
          </p>
          <button
            type="button"
            onClick={onLogout}
            disabled={logout.isPending}
            className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-paper disabled:opacity-60"
          >
            {logout.isPending ? "Logging out…" : "Log out"}
          </button>
        </div>
        </div>
      </aside>

      <div className="min-w-0">
        <DeadlineBar />
        <WorkerBanner />
        <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
