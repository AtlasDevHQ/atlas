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

const { executePythonViaSidecar, executePythonViaSidecarStream } = await import(
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

/** Build an NDJSON response body from event objects. */
function ndjsonResponse(events: object[]): Response {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return new Response(body, { status: 200 });
}

/** Build a Response whose body yields string chunks then optionally errors. */
function streamResponse(chunks: string[], error?: Error): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else if (error) {
        controller.error(error);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200 });
}

/** No-op progress callback. */
const noop = () => {};

/** Inferred PythonResult from the function's return type. */
type PythonResult = Awaited<ReturnType<typeof executePythonViaSidecar>>;

/** Assert result is a failure and narrow the type for subsequent assertions. */
function expectFailure(result: PythonResult): asserts result is Extract<PythonResult, { success: false }> {
  expect(result.success).toBe(false);
}

/** Assert result is a success and narrow the type for subsequent assertions. */
function expectSuccess(result: PythonResult): asserts result is Extract<PythonResult, { success: true }> {
  expect(result.success).toBe(true);
}

const OK_FALLBACK = () => Promise.resolve(Response.json({ success: true }));

/** Route-aware mock: returns different responses for streaming vs non-streaming. */
function mockFetchByRoute(
  streamHandler: () => Promise<Response>,
  nonStreamHandler: () => Promise<Response> = OK_FALLBACK,
) {
  mockFetch((input) => {
    const url = String(input);
    if (url.includes("/exec-python-stream")) return streamHandler();
    return nonStreamHandler();
  });
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

// ---------------------------------------------------------------------------
// Streaming endpoint tests
// ---------------------------------------------------------------------------

describe("executePythonViaSidecarStream", () => {
  describe("URL validation", () => {
    it("returns error for invalid sidecar URL", async () => {
      const result = await executePythonViaSidecarStream(
        "not-a-url", 'print("hello")', undefined, noop,
      );
      expectFailure(result);
      expect(result.error).toContain("Invalid ATLAS_SANDBOX_URL");
    });
  });

  describe("timeout paths", () => {
    it("returns error when execution exceeds timeout", async () => {
      mockFetchByRoute(
        () => Promise.reject(new Error("TimeoutError: The operation was aborted due to timeout")),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, 'print("hello")', undefined, (e) => progress.push(e),
      );

      expectFailure(result);
      expect(result.error).toContain("Streaming Python execution failed");
      expect(progress).toHaveLength(0);
    });

    it("has no leaked state between consecutive timeouts", async () => {
      mockFetchByRoute(
        () => Promise.reject(new Error("TimeoutError: timed out")),
      );

      const progress1: unknown[] = [];
      const result1 = await executePythonViaSidecarStream(
        SIDECAR_URL, "code1", undefined, (e) => progress1.push(e),
      );

      const progress2: unknown[] = [];
      const result2 = await executePythonViaSidecarStream(
        SIDECAR_URL, "code2", undefined, (e) => progress2.push(e),
      );

      expectFailure(result1);
      expectFailure(result2);
      expect(progress1).toHaveLength(0);
      expect(progress2).toHaveLength(0);
    });

    it("handles timeout during SSE streaming — partial results captured", async () => {
      const chunks = [
        JSON.stringify({ type: "stdout", data: "partial output\n" }) + "\n",
      ];

      mockFetchByRoute(
        () => Promise.resolve(streamResponse(chunks, new Error("TimeoutError: timed out"))),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectFailure(result);
      expect(result.error).toContain("Stream read failed");
      // The partial stdout event should have been delivered before the error
      expect(progress).toHaveLength(1);
      expect(progress[0]).toEqual({ type: "stdout", content: "partial output\n" });
    });
  });

  describe("NDJSON protocol errors", () => {
    it("skips malformed NDJSON lines — missing data: prefix, empty lines, binary garbage", async () => {
      const body = [
        JSON.stringify({ type: "stdout", data: "line 1\n" }),
        "not json at all",
        "\x00\x01\x02binary garbage",
        "",
        JSON.stringify({ type: "stdout", data: "line 2\n" }),
        JSON.stringify({ type: "done", data: { success: true, exitCode: 0 } }),
      ].join("\n") + "\n";

      mockFetchByRoute(
        () => Promise.resolve(new Response(body, { status: 200 })),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectSuccess(result);
      expect(progress).toHaveLength(2);
      expect(result.output).toBe("line 1\nline 2");
    });

    it("reports interrupted execution on truncated stream (no terminal event)", async () => {
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([{ type: "stdout", data: "before drop\n" }])),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectFailure(result);
      expect(result.error).toContain("interrupted");
      expect(result.output).toContain("before drop");
      expect(progress).toHaveLength(1);
    });

    it("skips invalid JSON in NDJSON data field without crashing", async () => {
      const body = [
        '{"type":"stdout","data":"valid\\n"}',
        '{"type":"stdout","data":}', // invalid JSON
        '{"type":"stdout","data":"also valid\\n"}',
        '{"type":"done","data":{"success":true,"exitCode":0}}',
      ].join("\n") + "\n";

      mockFetchByRoute(
        () => Promise.resolve(new Response(body, { status: 200 })),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectSuccess(result);
      // Two valid stdout events processed, one invalid skipped
      expect(progress).toHaveLength(2);
    });

    it("returns stream read error when connection drops mid-chunk", async () => {
      const chunks = [
        JSON.stringify({ type: "stdout", data: "chunk1\n" }) + "\n",
      ];

      mockFetchByRoute(
        () => Promise.resolve(streamResponse(chunks, new Error("network connection lost"))),
      );

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toContain("Stream read failed");
    });
  });

  describe("error response handling", () => {
    it("falls back on sidecar 404 — older sidecar without streaming support", async () => {
      let callCount = 0;
      mockFetch((input) => {
        callCount++;
        const url = String(input);
        if (url.includes("/exec-python-stream")) {
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        return Promise.resolve(Response.json({ success: true, output: "fallback worked" }));
      });

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectSuccess(result);
      expect(result.output).toBe("fallback worked");
      expect(callCount).toBe(2);
    });

    it("falls back on sidecar 500 — extracts JSON error from non-streaming endpoint", async () => {
      let callCount = 0;
      mockFetch((input) => {
        callCount++;
        const url = String(input);
        if (url.includes("/exec-python-stream")) {
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, error: "crash" }), { status: 500 }),
        );
      });

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toBe("crash");
      expect(callCount).toBe(2);
    });

    it("falls back on sidecar 500 with non-JSON body — fallback message", async () => {
      let callCount = 0;
      mockFetch((input) => {
        callCount++;
        const url = String(input);
        if (url.includes("/exec-python-stream")) {
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      });

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toContain("HTTP 500");
      expect(callCount).toBe(2);
    });

    it("falls back on sidecar 429 — rate limit handling", async () => {
      let callCount = 0;
      mockFetch((input) => {
        callCount++;
        const url = String(input);
        if (url.includes("/exec-python-stream")) {
          return Promise.resolve(new Response("Rate limited", { status: 429 }));
        }
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      });

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toContain("HTTP 429");
      expect(result.error).toContain("Rate limited");
      expect(callCount).toBe(2);
    });

    it("falls back when sidecar unreachable — clean error", async () => {
      let callCount = 0;
      mockFetch((input) => {
        callCount++;
        const url = String(input);
        if (url.includes("/exec-python-stream")) {
          return Promise.reject(new Error("fetch failed: ECONNREFUSED"));
        }
        return Promise.reject(new Error("fetch failed: ECONNREFUSED"));
      });

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toContain("sidecar unreachable");
      expect(callCount).toBe(2);
    });

    it("returns error event data from stream", async () => {
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([
          { type: "stdout", data: "partial output\n" },
          { type: "error", data: { error: "MemoryError: out of memory", output: "extra context" } },
        ])),
      );

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectFailure(result);
      expect(result.error).toBe("MemoryError: out of memory");
      expect(result.output).toContain("partial output");
      expect(result.output).toContain("extra context");
    });
  });

  describe("output handling", () => {
    it("captures large stdout output without truncation", async () => {
      const bigChunk = "x".repeat(10_000);
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([
          { type: "stdout", data: bigChunk },
          { type: "stdout", data: "\n" },
          { type: "stdout", data: bigChunk },
          { type: "done", data: { success: true, exitCode: 0 } },
        ])),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectSuccess(result);
      expect(result.output).toBe(`${bigChunk}\n${bigChunk}`);
      expect(progress).toHaveLength(3);
    });

    it("extracts base64 chart data from stream", async () => {
      const chartData = { base64: "iVBORw0KGgo=", mimeType: "image/png" as const };
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([
          { type: "chart", data: chartData },
          { type: "done", data: { success: true, exitCode: 0 } },
        ])),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectSuccess(result);
      expect(result.charts).toHaveLength(1);
      expect(result.charts![0].base64).toBe("iVBORw0KGgo=");
      expect(progress).toHaveLength(1);
      expect(progress[0]).toEqual({ type: "chart", chart: chartData });
    });

    it("preserves ordering of mixed stdout + chart output", async () => {
      const chart = { base64: "abc123", mimeType: "image/png" as const };
      const rechartsChart = {
        type: "bar" as const,
        data: [{ x: 1, y: 2 }],
        categoryKey: "x",
        valueKeys: ["y"],
      };
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([
          { type: "stdout", data: "first output\n" },
          { type: "chart", data: chart },
          { type: "stdout", data: "second output\n" },
          { type: "recharts", data: rechartsChart },
          { type: "done", data: { success: true, exitCode: 0 } },
        ])),
      );

      const progress: unknown[] = [];
      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, (e) => progress.push(e),
      );

      expectSuccess(result);
      expect(result.output).toBe("first output\nsecond output");
      expect(result.charts).toHaveLength(1);
      expect(result.rechartsCharts).toHaveLength(1);

      // Verify progress events in order
      expect(progress).toHaveLength(4);
      expect(progress.map((e) => (e as { type: string }).type)).toEqual([
        "stdout", "chart", "stdout", "recharts",
      ]);
    });

    it("handles table data in stream", async () => {
      mockFetchByRoute(
        () => Promise.resolve(ndjsonResponse([
          { type: "table", data: { columns: ["id", "name"], rows: [[1, "alice"], [2, "bob"]] } },
          { type: "done", data: { success: true, exitCode: 0 } },
        ])),
      );

      const result = await executePythonViaSidecarStream(
        SIDECAR_URL, "code", undefined, noop,
      );

      expectSuccess(result);
      expect(result.table).toEqual({ columns: ["id", "name"], rows: [[1, "alice"], [2, "bob"]] });
    });
  });
});
