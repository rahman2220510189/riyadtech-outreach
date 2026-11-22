"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/study", label: "Overview" },
  { href: "/study/programs", label: "Scholarships & programmes" },
  { href: "/study/updates", label: "Updates" },
  { href: "/study/universities", label: "Universities" },
  { href: "/study/documents", label: "My documents" },
  { href: "/study/profile", label: "My profile" },
  { href: "/study/emails", label: "E-mails" },
];

/** Title and tabs shared by every study page. */
export function StudyNav({ title, intro }: { title: string; intro?: string }) {
  const path = usePathname();
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-ink-3">Study abroad</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro && <p className="mt-1 max-w-prose text-ink-2">{intro}</p>}
      </div>
      <nav aria-label="Study abroad" className="-mx-1 overflow-x-auto">
        <ul className="flex gap-1 whitespace-nowrap px-1 text-sm">
          {TABS.map((t) => {
            const active = t.href === "/study" ? path === "/study" : path === t.href || path.startsWith(`${t.href}/`);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`block rounded-lg px-3 py-2 font-medium ${active ? "bg-ink text-white" : "border border-line bg-surface text-ink-2 hover:bg-paper"}`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
