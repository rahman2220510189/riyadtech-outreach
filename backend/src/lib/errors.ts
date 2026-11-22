import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

/**
 * Every API error has the same shape:
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Throw this from route handlers for expected, user-facing errors. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details),
  unauthorized: (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Forbidden") => new AppError(403, "FORBIDDEN", message),
  notFound: (message = "Not found") => new AppError(404, "NOT_FOUND", message),
  conflict: (message: string, details?: unknown) => new AppError(409, "CONFLICT", message, details),
};

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Maps Fastify's own error codes to stable API codes. */
function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "ERROR";
  }
}

export function registerErrorHandlers(app: FastifyInstance, opts: { exposeInternalErrors: boolean }): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(errorBody("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }

    if (err instanceof ZodError) {
      return reply.status(400).send(errorBody("VALIDATION_ERROR", "Request validation failed", zodDetails(err)));
    }

    const fErr = err as FastifyError;
    if (fErr.validation) {
      return reply.status(400).send(errorBody("VALIDATION_ERROR", fErr.message, fErr.validation));
    }

    const status = typeof fErr.statusCode === "number" && fErr.statusCode >= 400 ? fErr.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err }, "Unhandled error");
      const message = opts.exposeInternalErrors ? err.message : "Something went wrong. Check the server logs.";
      return reply.status(status).send(errorBody("INTERNAL_ERROR", message));
    }

    return reply.status(status).send(errorBody(codeForStatus(status), err.message));
  });
}
