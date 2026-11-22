import type { FastifyInstance } from "fastify";
import { AppError } from "../lib/errors.js";

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "XMLHttpRequest";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for the API: every state-changing request must send
 * `X-Requested-With: XMLHttpRequest`. Browsers cannot add that header cross-site
 * without a CORS preflight, and CORS only allows the frontend origin.
 * Together with the SameSite=Lax cookie this blocks forged requests.
 */
export function registerCsrfGuard(app: FastifyInstance, opts: { prefix: string; exempt?: string[] }): void {
  const exempt = opts.exempt ?? [];
  app.addHook("onRequest", (request, _reply, done) => {
    const path = request.url.split("?")[0] ?? "";
    const needsHeader =
      !SAFE_METHODS.has(request.method) && path.startsWith(opts.prefix) && !exempt.some((p) => path.startsWith(p));
    if (needsHeader && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      done(new AppError(403, "CSRF_HEADER_MISSING", `Missing header X-Requested-With: ${CSRF_VALUE}`));
      return;
    }
    done();
  });
}
