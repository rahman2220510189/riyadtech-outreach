import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import { ApiError, api, toApiError } from "./api";

function axiosError(status: number | undefined, data: unknown, code?: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response = status
    ? ({ status, data, statusText: "", headers: {}, config } as AxiosResponse)
    : undefined;
  return new AxiosError("failed", code, config, undefined, response);
}

describe("api instance", () => {
  it("sends the CSRF header and cookies, and calls /api/v1", () => {
    expect(api.defaults.baseURL).toBe("/api/v1");
    expect(api.defaults.withCredentials).toBe(true);
    expect(api.defaults.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(api.defaults.timeout).toBe(120_000);
  });
});

describe("toApiError", () => {
  it("keeps the backend error shape", () => {
    const e = toApiError(
      axiosError(401, { error: { code: "INVALID_CREDENTIALS", message: "Wrong e-mail or password." } }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", message: "Wrong e-mail or password." });
  });

  it("explains a network failure", () => {
    expect(toApiError(axiosError(undefined, undefined, "ERR_NETWORK"))).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("explains a timeout", () => {
    expect(toApiError(axiosError(undefined, undefined, AxiosError.ECONNABORTED))).toMatchObject({ code: "TIMEOUT" });
  });

  it("turns an HTML 5xx from the proxy into a plain message", () => {
    expect(toApiError(axiosError(502, "<html>Bad gateway</html>"))).toMatchObject({
      status: 502,
      code: "SERVER_UNAVAILABLE",
    });
  });
});
