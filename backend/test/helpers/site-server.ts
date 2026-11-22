import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

/** One answer of a fake website. A string is a 200 HTML page. */
export type FakeAnswer =
  | string
  | {
      status?: number;
      body?: string | Buffer;
      type?: string;
      headers?: Record<string, string>;
      gzip?: boolean;
      /** Redirect target (absolute, or a path on the same host). */
      location?: string;
    };

/** Fake websites by host name ("agency.test") and path ("/contact"). */
export type FakeSites = Record<string, Record<string, FakeAnswer>>;

export interface SiteServer {
  port: number;
  /** "http://agency.test:1234" */
  origin(host: string): string;
  /** Every request: host, path, user agent, time. */
  requests: { host: string; path: string; ua: string; at: number }[];
  sites: FakeSites;
  close(): Promise<void>;
}

/** One local HTTP server answering for many fake host names (DNS is faked in the crawler). */
export async function startSiteServer(sites: FakeSites): Promise<SiteServer> {
  const requests: SiteServer["requests"] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push({ host, path, ua: String(req.headers["user-agent"] ?? ""), at: Date.now() });
    const answer = sites[host]?.[path];
    if (answer === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>Not found</body></html>");
      return;
    }
    const a = typeof answer === "string" ? { body: answer } : answer;
    const headers: Record<string, string> = { "content-type": a.type ?? "text/html; charset=utf-8", ...a.headers };
    if (a.location) headers.location = a.location.startsWith("/") ? `http://${req.headers.host}${a.location}` : a.location;
    let body: Buffer = Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body ?? "");
    if (a.gzip) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
    }
    res.writeHead(a.status ?? (a.location ? 302 : 200), headers);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: (host) => `http://${host}:${port}`,
    requests,
    sites,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let flakyLeft = 0;
/** The next N lookups of "flaky.test" fail with EAI_AGAIN (a temporary DNS failure). */
export function failFlakyDns(times: number): void {
  flakyLeft = times;
}

/** Fake DNS: *.test and *.invalid go to the local server, a few names to private addresses. */
export async function fakeResolve(host: string): Promise<{ address: string; family: number }[]> {
  await Promise.resolve();
  if (host === "metadata.test") return [{ address: "169.254.169.254", family: 4 }];
  if (host === "intranet.test") return [{ address: "10.1.2.3", family: 4 }];
  if (host === "v6local.test") return [{ address: "::ffff:127.0.0.1", family: 6 }];
  if (host === "flaky.test" && flakyLeft > 0) {
    flakyLeft--;
    throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: "EAI_AGAIN" });
  }
  if (host.startsWith("missing.")) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return [{ address: "127.0.0.1", family: 4 }];
}
