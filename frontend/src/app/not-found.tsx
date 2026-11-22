import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">This page does not exist</h1>
      <p className="mt-2 text-ink-2">The address may be mistyped, or the page has not been built yet.</p>
      <Link href="/dashboard" className="mt-6 font-medium underline underline-offset-4">
        Go to the dashboard
      </Link>
    </main>
  );
}
