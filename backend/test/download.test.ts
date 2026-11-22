import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HttpLogEntry, download, setHttpLogger } from "../src/finder/overture/http.js";

/** Local server with scripted answers per path (no internet). */
let server: Server;
let base = "";
const hits = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    if (path === "/ok") return void res.end("hello");
    if (path === "/404") return void res.writeHead(404).end();
    if (path === "/flaky") {
      if (n < 3) return void res.writeHead(503).end();
      return void res.end("third time");
    }
    if (path === "/slow-but-moving") {
      // 6 chunks, 150 ms apart: total 0.9 s, never silent for more than 150 ms.
      res.writeHead(200);
      let i = 0;
      const t = setInterval(() => {
        res.write(`chunk${i}`);
        if (++i === 6) {
          clearInterval(t);
          res.end();
        }
      }, 150);
      return;
    }
    if (path === "/stall-once") {
      res.writeHead(200);
      res.write("part");
      if (n === 1) return; // first time: never finishes (stalls)
      return void res.end("-rest");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setHttpLogger(undefined);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("download", () => {
  it("downloads and reports to the logger", async () => {
    const log: HttpLogEntry[] = [];
    setHttpLogger((e) => log.push(e));
    expect(text((await download(`${base}/ok`)).body)).toBe("hello");
    expect(log[0]).toMatchObject({ status: 200, bytes: 5, attempt: 0 });
    setHttpLogger(undefined);
  });

  it("fails at once on 404", async () => {
    await expect(download(`${base}/404`)).rejects.toThrow(/HTTP 404/);
    expect(hits.get("/404")).toBe(1);
  });

  it("retries 5xx answers", async () => {
    expect(text((await download(`${base}/flaky`, { retries: 3 })).body)).toBe("third time");
  }, 15_000);

  it("allows a slow download as long as data keeps coming", async () => {
    const body = await download(`${base}/slow-but-moving`, { stallTimeoutMs: 500, retries: 0 });
    expect(text(body.body)).toBe("chunk0chunk1chunk2chunk3chunk4chunk5");
  });

  it("aborts a stalled download and retries it", async () => {
    const body = await download(`${base}/stall-once`, { stallTimeoutMs: 300, retries: 2 });
    expect(text(body.body)).toBe("part-rest");
    expect(hits.get("/stall-once")).toBe(2);
  }, 15_000);

  it("gives a clear message after the last try", async () => {
    await expect(download(`http://127.0.0.1:1/x`, { retries: 1, connectTimeoutMs: 500 })).rejects.toThrow(
      /Could not download 127\.0\.0\.1:1\/x after 2 tries/,
    );
  }, 15_000);
});
