export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex flex-col leading-none ${className}`}>
      <span className="text-[0.8125rem] text-ink-2">Riyad Tech</span>
      <span className="mt-1 text-lg font-bold tracking-tight">Outreach</span>
    </span>
  );
}
