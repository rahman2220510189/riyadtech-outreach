import { type ChildProcess, spawn } from "node:child_process";

export interface ChildSpec {
  name: string;
  /** Arguments for `node` (the same Node binary that runs the supervisor). */
  args: string[];
}

export interface SuperviseOptions {
  /** After asking a child to stop, wait this long before killing it. */
  killTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface Supervision {
  /** Resolves with the exit code for the supervisor once every child has exited. */
  done: Promise<number>;
  /** Stop all children (e.g. on SIGTERM from Render). Exit code 0. */
  stop(reason: string): void;
}

/**
 * Runs the children side by side. If ANY child exits on its own, all are stopped
 * and the supervisor exits with code 1, so Render restarts the whole service
 * (a server without a worker, or a worker without a server, is never left running).
 */
export function supervise(specs: ChildSpec[], opts: SuperviseOptions = {}): Supervision {
  const killTimeoutMs = opts.killTimeoutMs ?? 10_000;
  const log = opts.log ?? ((line: string) => process.stdout.write(`[all] ${line}\n`));
  const running = new Map<string, ChildProcess>();
  let stopping = false;
  let exitCode = 0;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));

  const stopAll = (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    log(`stopping all: ${reason}`);
    for (const [name, child] of running) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (running.has(name)) {
          log(`${name} did not stop in ${killTimeoutMs} ms; killing it`);
          child.kill("SIGKILL");
        }
      }, killTimeoutMs);
      timer.unref();
    }
    if (running.size === 0) resolveDone(exitCode);
  };

  for (const spec of specs) {
    const child = spawn(process.execPath, spec.args, { stdio: "inherit", env: process.env });
    running.set(spec.name, child);
    log(`started ${spec.name} (pid ${child.pid ?? "?"})`);

    let finished = false;
    const onEnd = (description: string) => {
      if (finished) return;
      finished = true;
      running.delete(spec.name);
      log(`${spec.name} ${description}`);
      if (!stopping) stopAll(`${spec.name} stopped unexpectedly`, 1);
      if (running.size === 0) resolveDone(exitCode);
    };
    child.on("exit", (code, signal) => onEnd(signal ? `exited by signal ${signal}` : `exited with code ${code ?? "?"}`));
    child.on("error", (err) => onEnd(`failed to start: ${err.message}`));
  }

  return { done, stop: (reason) => stopAll(reason, 0) };
}
