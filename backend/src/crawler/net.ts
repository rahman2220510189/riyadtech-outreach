import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";

/**
 * The crawler's only way onto the network. It identifies itself honestly, never
 * pretends to be a browser, and refuses private, loopback and link-local addresses
 * (checked at connect time, so also after every redirect and against DNS tricks).
 */
export const BOT_USER_AGENT = "RiyadTechBot (+https://riyadtech.xyz/bot)";
/** The token robots.txt rules are matched against. */
export const BOT_TOKEN = "RiyadTechBot";

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net6, prefix, "ipv6");
}

/** IPv4 address hidden inside an IPv6 one (::ffff:a.b.c.d, 64:ff9b::a.b.c.d, ::a.b.c.d). */
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m?.[1]) return m[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex?.[1] && hex[2]) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True for addresses on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return isPublicAddress(v4);
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface NetOptions {
  /** DNS resolver (tests map fake host names to a local server). */
  resolve?: Resolver;
  /** Addresses allowed even though they are private (tests only: the local fixture server). */
  allowAddresses?: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export class BlockedAddressError extends Error {
  constructor(readonly host: string, readonly address: string) {
    super(`${host} points to a private or local address (${address}); not crawled`);
    this.name = "BlockedAddressError";
  }
}

export class FetchError extends Error {
  constructor(
    message: string,
    /** dns | refused | timeout | tls | blocked_address | too_many_redirects | bad_url | network */
    readonly kind: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

function addressAllowed(address: string, opts: NetOptions): boolean {
  return isPublicAddress(address) || (opts.allowAddresses ?? []).includes(address);
}

function safeLookup(opts: NetOptions): LookupFunction {
  const resolve = opts.resolve ?? defaultResolver;
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((all) => {
        if (all.length === 0) throw Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" });
        const bad = all.find((a) => !addressAllowed(a.address, opts));
        if (bad) throw new BlockedAddressError(hostname, bad.address);
        const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        const list = wanted.length > 0 ? wanted : all;
        if (options.all) callback(null, list.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: Error) => callback(err as NodeJS.ErrnoException, "", 0));
  };
}

export interface FetchResult {
  /** The URL that answered (after redirects). */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  contentType: string;
  /** Decoded text when the content type was accepted; null otherwise. */
  body: string | null;
  bytes: number;
  truncated: boolean;
  redirects: number;
  ms: number;
}

/** Checks a URL before any request: http(s) only, no credentials, normal ports, no private IP literals. */
export function checkUrl(raw: string, opts: Pick<NetOptions, "allowAddresses">): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError(`Not a valid URL: ${raw.slice(0, 100)}`, "bad_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError(`Only http and https: ${url.protocol}`, "bad_url");
  if (url.username || url.password) throw new FetchError("URLs with a user name are not crawled", "bad_url");
  const testing = (opts.allowAddresses ?? []).length > 0;
  if (url.port && !testing && !["80", "443"].includes(url.port)) throw new FetchError(`Unusual port ${url.port}`, "bad_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !(isPublicAddress(host) || (opts.allowAddresses ?? []).includes(host))) {
    throw new FetchError(`${host} is a private or local address; not crawled`, "blocked_address");
  }
  url.hash = "";
  return url;
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = head.subarray(0, 2048).toString("latin1");
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1];
  return (fromMeta ?? "utf-8").toLowerCase();
}

function decode(buf: Buffer, contentType: string): string {
  const charset = charsetOf(contentType, buf);
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function classifyNetError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  if (err instanceof BlockedAddressError) return new FetchError(err.message, "blocked_address");
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  if (e?.cause instanceof BlockedAddressError) return new FetchError(e.cause.message, "blocked_address");
  const code = e?.code ?? "";
  const msg = e?.message ?? String(err);
  if (code === "EAI_AGAIN") return new FetchError("DNS lookup failed for now (EAI_AGAIN)", "dns_temp");
  if (code === "ENOTFOUND" || code === "ENODATA") return new FetchError(`Domain not found (${code})`, "dns");
  if (code === "ECONNREFUSED") return new FetchError("Connection refused", "refused");
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(msg)) return new FetchError("No answer in time", "timeout");
  if (/certificate|SSL|TLS|ERR_TLS|EPROTO|self.signed|CERT_/i.test(`${code} ${msg}`)) {
    return new FetchError(`TLS problem: ${msg.slice(0, 120)}`, "tls");
  }
  return new FetchError(`${code || "Network error"}: ${msg.slice(0, 120)}`, "network");
}

interface HopResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, opts: NetOptions, readBody: boolean, extraHeaders: Record<string, string>): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: safeLookup(opts),
        headers: {
          "user-agent": BOT_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/xml;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
          ...extraHeaders,
        },
        // A fresh connection per request: no agent keeps sockets to sites we have finished with.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!readBody || (status >= 300 && status < 400)) {
          res.resume();
          res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false }));
          res.on("error", reject);
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > opts.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - opts.maxBytes)));
            req.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        stream.on("error", (err: Error) => {
          if (truncated) return;
          // A broken compressed stream: keep what arrived when there is something.
          if (chunks.length > 0) resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
          else reject(err);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), opts.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

export interface FetchOptions {
  /** Content types whose body is read (others: headers only). */
  accept?: RegExp;
  headers?: Record<string, string>;
}

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

/**
 * GET with manual redirects (each hop checked again), a time limit, a size limit and
 * decompression. Throws FetchError for network problems; HTTP errors are returned.
 */
export async function safeFetch(raw: string, opts: NetOptions, fo: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const accept = fo.accept ?? HTML_TYPES;
  let url = checkUrl(raw, opts);
  for (let redirects = 0; ; redirects++) {
    let hop: HopResult;
    try {
      hop = await requestOnce(url, opts, true, fo.headers ?? {});
    } catch (err) {
      throw classifyNetError(err);
    }
    const location = hop.headers.location;
    if (hop.status >= 300 && hop.status < 400 && location) {
      if (redirects >= opts.maxRedirects) throw new FetchError(`More than ${opts.maxRedirects} redirects`, "too_many_redirects");
      url = checkUrl(new URL(location, url).toString(), opts);
      continue;
    }
    const contentType = String(hop.headers["content-type"] ?? "");
    const readable = accept.test(contentType) || (contentType === "" && hop.body.length > 0);
    return {
      url: url.toString(),
      status: hop.status,
      headers: hop.headers,
      contentType,
      body: readable ? decode(hop.body, contentType) : null,
      bytes: hop.body.length,
      truncated: hop.truncated,
      redirects,
      ms: Date.now() - started,
    };
  }
}
