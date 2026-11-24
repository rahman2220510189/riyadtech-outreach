/**
 * npm run mail:outbox            sends waiting e-mails, then keeps checking every 30 seconds (Ctrl+C stops)
 * npm run mail:outbox -- --once  sends what waits now and stops
 *
 * The hosted tool (MAIL_DELIVERY=outbox on Render, whose free plan blocks SMTP) only queues e-mails.
 * This runs on my PC with the same DATABASE_URL and ENCRYPTION_KEY in backend/.env, and sends them
 * through each mailbox's own SMTP server, exactly as the local tool would.
 */
import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { describePgUrl } from "../db/url.js";
import { deliverOutbox } from "../mail/outbox.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const env = loadEnv();
  const once = process.argv.includes("--once");
  const target = describePgUrl(env.DATABASE_URL);
  out(`Outbox: database ${target.host} / ${target.database}${once ? "" : " · checking every 30 seconds, Ctrl+C to stop"}`);
  const db = createDb(env);
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    out("Stopping after the current e-mail…");
  });
  try {
    for (;;) {
      const r = await deliverOutbox(db, env);
      for (const l of r.lines) out(`${new Date().toLocaleTimeString()}  ${l}`);
      if (r.interrupted) out(`${r.interrupted} e-mail(s) were interrupted earlier and marked failed: check the Sent folder before sending again.`);
      if (once) {
        out(r.sent + r.failed === 0 ? "Nothing waiting." : `Done: ${r.sent} sent, ${r.failed} failed.`);
        break;
      }
      for (let i = 0; i < 30 && !stop; i++) await new Promise((res) => setTimeout(res, 1000));
      if (stop) break;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  out(`mail:outbox failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
