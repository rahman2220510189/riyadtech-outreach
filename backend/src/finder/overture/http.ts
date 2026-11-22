import type { AsyncBuffer } from "hyparquet";
import { APP_VERSION } from "../../version.js";
import { Semaphore } from "./ranges.js";

/**
 * At most 3 data downloads at once per process. On a slow, far-away link (Dhaka to S3
 * us-west-2 measured 0.03-0.13 MB/s) dozens of parallel requests starve each other and stall.
 */
const rangeLimit = new Semaphore(3);

/** Open data downloads identify the tool honestly. */
export const DATA_USER_AGENT = `RiyadTechOutreach/${APP_VERSION} (+https://riyadtech.xyz)`;

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Short, log-friendly description of a URL (host + path only). */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 60 ? `…${u.pathname.slice(-57)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 80);
  }
}

export interface HttpLogEntry {
  url: string;
  range?: string;
  status: number;
  bytes: number;
  ms: number;
  attempt: number;
}

let httpLogger: ((e: HttpLogEntry) => void) | undefined;

/** Every finished download is reported here (CLI --verbose, worker debug log). */
export function setHttpLogger(fn: ((e: HttpLogEntry) => void) | undefined): void {
  httpLogger = fn;
}

export interface FetchOptions {
  retries?: number;
  headers?: Record<string, string>;
  /** Abort when the server sends no headers for this long. */
  connectTimeoutMs?: number;
  /** Abort when no data arrives for this long (a slow but moving download is fine). */
  stallTimeoutMs?: number;
}

export interface Downloaded {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/**
 * Downloads a URL completely, with retries (1 s, 2 s, 4 s, 8 s) for network errors, stalls,
 * 429 and 5xx. There is no limit on total time: a large file on a slow connection is fine as
 * long as data keeps arriving. Other 4xx answers fail at once.
 */
export async function download(url: string, opts: FetchOptions = {}): Promise<Downloaded> {
  const retries = opts.retries ?? 4;
  const connectMs = opts.connectTimeoutMs ?? 30_000;
  const stallMs = opts.stallTimeoutMs ?? 60_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error(`no answer within ${connectMs / 1000} s`)), connectMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "user-agent": DATA_USER_AGENT, ...opts.headers },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new HttpError(url, res.status, `HTTP ${res.status} from ${shortUrl(url)}`);
        await res.body?.cancel().catch(() => undefined);
        if (res.status !== 429 && res.status < 500) throw err;
        lastError = err;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          clearTimeout(timer);
          timer = setTimeout(
            () => controller.abort(new Error(`download stalled (no data for ${stallMs / 1000} s)`)),
            stallMs,
          );
          const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
          if (done || !value) break;
          chunks.push(value);
          size += value.byteLength;
        }
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        body.set(c, offset);
        offset += c.byteLength;
      }
      httpLogger?.({ url, range: opts.headers?.range, status: res.status, bytes: size, ms: Date.now() - started, attempt });
      return { status: res.status, headers: res.headers, body };
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastError = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err;
    } finally {
      clearTimeout(timer);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not download ${shortUrl(url)} after ${retries + 1} tries: ${reason}`);
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  const res = await download(url, opts);
  return JSON.parse(new TextDecoder().decode(res.body)) as T;
}

/** Counts bytes downloaded by range requests (shown in job results). */
export class ByteCounter {
  bytes = 0;
}

/**
 * hyparquet AsyncBuffer over HTTP range requests, with retries.
 * Only the byte ranges hyparquet asks for are downloaded (footer, chosen columns of chosen row groups).
 */
export async function httpAsyncBuffer(url: string, byteLength?: number): Promise<AsyncBuffer> {
  let size = byteLength;
  if (size === undefined) {
    const res = await download(url, { headers: { range: "bytes=0-0" } });
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (!total) throw new Error(`Could not read the size of ${shortUrl(url)}`);
    size = Number(total);
  }
  const fileSize = size;
  return {
    byteLength: fileSize,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const last = (end ?? fileSize) - 1;
      const res = await rangeLimit.run(() => download(url, { headers: { range: `bytes=${start}-${last}` } }));
      if (res.status !== 206 && !(start === 0 && last === fileSize - 1)) {
        throw new Error(`Server ignored the byte range for ${shortUrl(url)} (HTTP ${res.status})`);
      }
      const { buffer, byteOffset, byteLength } = res.body;
      return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
    },
  };
}
