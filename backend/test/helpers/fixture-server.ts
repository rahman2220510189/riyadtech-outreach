import { readFile, stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../fixtures/overture/", import.meta.url));

export interface FixtureServer {
  baseUrl: string;
  stacUrl: string;
  geonamesUrl: string;
  /** Requests per path (to check that pruning skipped files). */
  requests: Map<string, number>;
  /** Every range request as "path bytes=a-b". */
  ranges: string[];
  bytesServed: () => number;
  close: () => Promise<void>;
}

/**
 * Serves test/fixtures/overture over HTTP like S3 and the STAC site: JSON files get
 * "{BASE}" replaced with the server URL; other files support Range requests.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests = new Map<string, number>();
  const ranges: string[] = [];
  let bytes = 0;
  let baseUrl = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      requests.set(path, (requests.get(path) ?? 0) + 1);
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      try {
        await stat(file);
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      if (file.endsWith(".json")) {
        const body = (await readFile(file, "utf8")).replaceAll("{BASE}", baseUrl);
        res.writeHead(200, { "content-type": "application/json" }).end(body);
        return;
      }
      const data = await readFile(file);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        ranges.push(`${path} ${req.headers.range}`);
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        const part = data.subarray(start, end + 1);
        bytes += part.length;
        res
          .writeHead(206, { "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": part.length })
          .end(part);
        return;
      }
      bytes += data.length;
      res.writeHead(200, { "content-length": data.length }).end(data);
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    stacUrl: `${baseUrl}/stac`,
    geonamesUrl: `${baseUrl}/geonames`,
    requests,
    ranges,
    bytesServed: () => bytes,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
