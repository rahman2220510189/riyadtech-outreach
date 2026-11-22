/**
 * Hosting entry point (Render start command: `node dist/all.js`).
 * Runs the API server and the worker as two child processes. If either one
 * exits, both are stopped and this process exits with code 1 so Render restarts it.
 * Locally (`npm run dev:all`) the same file runs the TypeScript sources through tsx.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supervise } from "./supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const fromSource = import.meta.url.endsWith(".ts");
const ext = fromSource ? ".ts" : ".js";
const loader = fromSource ? ["--import", "tsx"] : [];

const supervision = supervise([
  { name: "server", args: [...loader, join(here, `server${ext}`)] },
  { name: "worker", args: [...loader, join(here, `worker${ext}`)] },
]);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => supervision.stop(`received ${signal}`));
}

void supervision.done.then((code) => process.exit(code));
