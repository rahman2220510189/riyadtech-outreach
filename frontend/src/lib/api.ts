import axios, { AxiosError } from "axios";

/**
 * The ONLY axios instance in the app. Every request goes to /api/v1 on this
 * website; Next forwards it to the backend (see next.config.ts).
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "/api/v1",
  withCredentials: true,
  // The free backend may be asleep; waking it can take up to a minute.
  timeout: 120_000,
  headers: {
    // Required by the backend on every POST/PUT/PATCH/DELETE (CSRF protection).
    "X-Requested-With": "XMLHttpRequest",
  },
});

/** Every failed request becomes an ApiError with the backend's error shape. */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the backend could not be reached at all. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data as ErrorBody | undefined;
    const e = body?.error;
    if (e && typeof e.code === "string" && typeof e.message === "string") {
      return new ApiError(status, e.code, e.message, e.details);
    }
    if (err.code === AxiosError.ECONNABORTED || err.code === "ETIMEDOUT") {
      return new ApiError(0, "TIMEOUT", "The server did not answer in time. Try again in a minute.");
    }
    if (!err.response) {
      return new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.");
    }
    // The Next proxy answers 5xx with HTML when the backend is down or still starting.
    if (status >= 500) {
      return new ApiError(status, "SERVER_UNAVAILABLE", "The server is starting or unavailable. Try again in a minute.");
    }
    return new ApiError(status, "HTTP_ERROR", `Request failed (${status}).`);
  }
  return new ApiError(0, "UNKNOWN", err instanceof Error ? err.message : "Something went wrong.");
}

api.interceptors.response.use(
  (res) => res,
  (err: unknown) => Promise.reject(toApiError(err)),
);
