/**
 * npm run seed:admin
 *
 * Creates the single admin, or sets a new password for it (this logs out every session).
 *   ADMIN_EMAIL     required, in backend/.env (not a secret)
 *   ADMIN_PASSWORD  optional; if not set you type it here, hidden (recommended locally)
 */
import { z } from "zod";
import { normalizeEmail } from "../auth/password.js";
import { checkPassword, seedAdmin } from "../auth/seed.js";
import { EnvError, loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { describePgUrl } from "../db/url.js";
import { promptHidden } from "./prompt.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const emailParse = z.email().safeParse(process.env.ADMIN_EMAIL?.trim());
  if (!emailParse.success) {
    throw new Error("Set ADMIN_EMAIL=you@example.com in backend/.env first.");
  }
  const email = normalizeEmail(emailParse.data);

  let password = process.env.ADMIN_PASSWORD;
  if (password) {
    process.stdout.write("Using ADMIN_PASSWORD from the environment. Remove it from .env afterwards.\n");
  } else {
    password = await promptHidden(`New password for ${email}: `);
    const again = await promptHidden("Type it again: ");
    if (again !== password) throw new Error("The two passwords are different. Nothing changed.");
  }

  const problems = checkPassword(password, email);
  if (problems.length > 0) throw new Error(`Password ${problems.join("; ")}. Nothing changed.`);

  const target = describePgUrl(env.DATABASE_URL);
  process.stdout.write(`Database: ${target.host} / ${target.database}\n`);

  const db = createDb(env);
  try {
    const result = await seedAdmin(db, email, password);
    process.stdout.write(
      result.action === "created"
        ? `Admin created: ${result.email}\n`
        : `Password updated for ${result.email}. All existing sessions are logged out.\n`,
    );
    if (result.otherAdmins.length > 0) {
      process.stdout.write(`WARNING: other admin accounts exist: ${result.otherAdmins.join(", ")}\n`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error(`seed:admin failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
