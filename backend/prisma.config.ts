import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 does not read .env by itself. Locally we load backend/.env;
// on Render the variables come from the Environment page.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations always use the DIRECT (non-pooled) Neon URL.
  // Optional here so `prisma generate` works without a database.
  datasource: { url: process.env.DIRECT_URL },
});
