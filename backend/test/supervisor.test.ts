import { describe, expect, it } from "vitest";
import { supervise } from "../src/supervisor.js";

const forever = ["-e", "setInterval(() => {}, 1000)"];
const quiet = () => undefined;

describe("supervise", () => {
  it("stops everything and exits 1 when one child exits on its own", async () => {
    const lines: string[] = [];
    const s = supervise(
      [
        { name: "server", args: forever },
        { name: "worker", args: ["-e", "setTimeout(() => process.exit(0), 200)"] },
      ],
      { log: (l) => lines.push(l), killTimeoutMs: 2_000 },
    );
    expect(await s.done).toBe(1);
    expect(lines.join("\n")).toMatch(/worker exited with code 0/);
    expect(lines.join("\n")).toMatch(/stopping all: worker stopped unexpectedly/);
    expect(lines.join("\n")).toMatch(/server (exited|exited by signal)/);
  }, 10_000);

  it("exits 1 when a child crashes at start", async () => {
    const s = supervise(
      [
        { name: "server", args: forever },
        { name: "worker", args: ["-e", "process.exit(2)"] }, // e.g. invalid .env
      ],
      { log: quiet },
    );
    expect(await s.done).toBe(1);
  }, 10_000);

  it("stop() ends all children with exit code 0", async () => {
    const s = supervise(
      [
        { name: "server", args: forever },
        { name: "worker", args: forever },
      ],
      { log: quiet },
    );
    setTimeout(() => s.stop("received SIGTERM"), 300);
    expect(await s.done).toBe(0);
  }, 10_000);

  it("kills a child that ignores the stop request", async () => {
    const lines: string[] = [];
    const s = supervise(
      [{ name: "stubborn", args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"] }],
      { log: (l) => lines.push(l), killTimeoutMs: 300 },
    );
    setTimeout(() => s.stop("test"), 300);
    expect(await s.done).toBe(0);
    if (process.platform !== "win32") expect(lines.join("\n")).toMatch(/killing it/);
  }, 10_000);
});
