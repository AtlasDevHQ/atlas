import { describe, expect, it, mock, afterEach } from "bun:test";

// Mock logger to avoid side effects
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const { executePythonViaSidecar } = await import(
  "@atlas/api/lib/tools/python-sidecar"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIDECAR_URL = "http://localhost:9999";

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Save original fetch and provide a type-safe mock helper
const originalFetch = globalThis.fetch;

/** Override globalThis.fetch with a mock function. */
function mockFetch(fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

afterEach(() => {
  // Restore env
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];

  // Restore fetch
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executePythonViaSidecar", () => {
  describe("URL validation", () => {
    it("returns error for invalid sidecar URL", async () => {
      const result = await executePythonViaSidecar(
        "not-a-url",
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid ATLAS_SANDBOX_URL");
      }
    });
  });

  describe("connection errors", () => {
    it("returns error when sidecar is unreachable", async () => {
      mockFetch(() => Promise.reject(new Error("fetch failed: ECONNREFUSED")));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("sidecar unreachable");
      }
    });

    it("returns timeout error when request exceeds deadline", async () => {
      mockFetch(() => Promise.reject(new Error("TimeoutError: timed out")));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("timed out");
      }
    });

    it("returns error for generic fetch failures", async () => {
      mockFetch(() => Promise.reject(new Error("network error")));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Sidecar request failed");
      }
    });
  });

  describe("HTTP error responses", () => {
    it("parses structured error from HTTP 500", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: false, error: "crash" }),
            { status: 500 },
          ),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("crash");
      }
    });

    it("returns raw error for non-500 HTTP errors", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response("Rate limited", { status: 429 }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("HTTP 429");
        expect(result.error).toContain("Rate limited");
      }
    });

    it("returns raw error for 500 with non-JSON body", async () => {
      mockFetch(() =>
        Promise.resolve(
          new Response("Internal Server Error", { status: 500 }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("HTTP 500");
      }
    });
  });

  describe("response parsing", () => {
    it("returns error when response JSON is unparseable", async () => {
      mockFetch(() =>
        Promise.resolve(new Response("not json", { status: 200 })));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Failed to parse sidecar response");
      }
    });

    it("returns error when response lacks success boolean", async () => {
      mockFetch(() =>
        Promise.resolve(
          Response.json({ output: "hello" }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello")',
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("unexpected response format");
      }
    });
  });

  describe("successful execution", () => {
    it("returns PythonResult on success", async () => {
      mockFetch(() =>
        Promise.resolve(
          Response.json({
            success: true,
            output: "hello world",
          }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        'print("hello world")',
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toBe("hello world");
      }
    });

    it("returns result with table data", async () => {
      mockFetch(() =>
        Promise.resolve(
          Response.json({
            success: true,
            table: { columns: ["x"], rows: [[1], [2]] },
          }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        "code",
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.table).toEqual({ columns: ["x"], rows: [[1], [2]] });
      }
    });

    it("returns result with rechartsCharts", async () => {
      mockFetch(() =>
        Promise.resolve(
          Response.json({
            success: true,
            rechartsCharts: [
              { type: "bar", data: [{ x: 1 }], categoryKey: "x", valueKeys: ["x"] },
            ],
          }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        "code",
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.rechartsCharts).toHaveLength(1);
      }
    });

    it("returns error result from sidecar", async () => {
      mockFetch(() =>
        Promise.resolve(
          Response.json({
            success: false,
            error: "ZeroDivisionError: division by zero",
          }),
        ));

      const result = await executePythonViaSidecar(
        SIDECAR_URL,
        "1/0",
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("ZeroDivisionError");
      }
    });
  });

  describe("request construction", () => {
    it("sends auth header when SIDECAR_AUTH_TOKEN is set", async () => {
      setEnv("SIDECAR_AUTH_TOKEN", "test-token-123");
      let capturedHeaders: Headers | null = null;

      mockFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(Response.json({ success: true }));
      });

      await executePythonViaSidecar(SIDECAR_URL, "code");
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer test-token-123");
    });

    it("omits auth header when SIDECAR_AUTH_TOKEN is not set", async () => {
      setEnv("SIDECAR_AUTH_TOKEN", undefined);
      let capturedHeaders: Headers | null = null;

      mockFetch((_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(Response.json({ success: true }));
      });

      await executePythonViaSidecar(SIDECAR_URL, "code");
      expect(capturedHeaders!.get("Authorization")).toBeNull();
    });

    it("sends data payload when provided", async () => {
      let capturedBody: string | null = null;

      mockFetch((_input, init) => {
        capturedBody = init?.body as string;
        return Promise.resolve(Response.json({ success: true }));
      });

      const data = { columns: ["id"], rows: [[1], [2]] };
      await executePythonViaSidecar(SIDECAR_URL, "code", data);

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.data).toEqual(data);
      expect(parsed.code).toBe("code");
    });

    it("omits data from request when not provided", async () => {
      let capturedBody: string | null = null;

      mockFetch((_input, init) => {
        capturedBody = init?.body as string;
        return Promise.resolve(Response.json({ success: true }));
      });

      await executePythonViaSidecar(SIDECAR_URL, "code");

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.data).toBeUndefined();
    });
  });

  describe("timeout configuration", () => {
    it("uses ATLAS_PYTHON_TIMEOUT when set", async () => {
      setEnv("ATLAS_PYTHON_TIMEOUT", "5000");
      let capturedBody: string | null = null;

      mockFetch((_input, init) => {
        capturedBody = init?.body as string;
        return Promise.resolve(Response.json({ success: true }));
      });

      await executePythonViaSidecar(SIDECAR_URL, "code");

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.timeout).toBe(5000);
    });

    it("falls back to default on invalid ATLAS_PYTHON_TIMEOUT", async () => {
      setEnv("ATLAS_PYTHON_TIMEOUT", "not-a-number");
      let capturedBody: string | null = null;

      mockFetch((_input, init) => {
        capturedBody = init?.body as string;
        return Promise.resolve(Response.json({ success: true }));
      });

      await executePythonViaSidecar(SIDECAR_URL, "code");

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.timeout).toBe(30000); // DEFAULT_TIMEOUT_MS
    });
  });
});
