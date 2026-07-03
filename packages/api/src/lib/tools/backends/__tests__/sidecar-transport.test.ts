import { describe, expect, it, afterEach } from "bun:test";
import {
  isSidecarConnectionError,
  isSidecarTimeoutError,
  sidecarRequestHeaders,
} from "@atlas/api/lib/tools/backends/sidecar-transport";

// The connection/timeout classifiers and the bearer-auth header were copy-pasted
// across explore-sidecar + python-sidecar (exec + stream). #4187 consolidated
// them here; these tests pin the classification and header shape so the three
// call sites can't drift.

describe("isSidecarConnectionError", () => {
  it("matches the fetch-down signatures", () => {
    expect(isSidecarConnectionError("connect ECONNREFUSED 127.0.0.1:8080")).toBe(true);
    expect(isSidecarConnectionError("TypeError: fetch failed")).toBe(true);
    expect(isSidecarConnectionError("Failed to connect to host")).toBe(true);
  });

  it("does not match timeouts or arbitrary errors", () => {
    expect(isSidecarConnectionError("TimeoutError: the operation timed out")).toBe(false);
    expect(isSidecarConnectionError("HTTP 500")).toBe(false);
    expect(isSidecarConnectionError("")).toBe(false);
  });
});

describe("isSidecarTimeoutError", () => {
  it("matches abort/timeout signatures", () => {
    expect(isSidecarTimeoutError("TimeoutError")).toBe(true);
    expect(isSidecarTimeoutError("the operation timed out")).toBe(true);
    expect(isSidecarTimeoutError("The operation was aborted")).toBe(true);
  });

  it("does not match connection refusals", () => {
    expect(isSidecarTimeoutError("ECONNREFUSED")).toBe(false);
  });
});

describe("sidecarRequestHeaders", () => {
  const saved = process.env.SIDECAR_AUTH_TOKEN;

  afterEach(() => {
    if (saved === undefined) delete process.env.SIDECAR_AUTH_TOKEN;
    else process.env.SIDECAR_AUTH_TOKEN = saved;
  });

  it("omits Authorization when no token is configured", () => {
    delete process.env.SIDECAR_AUTH_TOKEN;
    expect(sidecarRequestHeaders()).toEqual({ "Content-Type": "application/json" });
  });

  it("adds a bearer Authorization header when a token is set", () => {
    process.env.SIDECAR_AUTH_TOKEN = "sekret";
    expect(sidecarRequestHeaders()).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sekret",
    });
  });
});
