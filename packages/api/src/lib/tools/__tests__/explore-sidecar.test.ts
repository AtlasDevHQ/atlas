import { describe, expect, it, afterEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Mock fetch — intercept HTTP calls to the sidecar
// ---------------------------------------------------------------------------

let fetchCalls: { url: string; options: RequestInit }[] = [];

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, options: RequestInit) => Response | Promise<Response>,
) {
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const options = init ?? {};
    fetchCalls.push({ url, options });
    return handler(url, options);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  fetchCalls = [];
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createSidecarBackend } from "@atlas/api/lib/tools/explore-sidecar";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSidecarBackend", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("rejects invalid URLs", async () => {
    await expect(createSidecarBackend("not-a-url")).rejects.toThrow(
      "Invalid ATLAS_SANDBOX_URL",
    );
  });

  it("creates a backend with valid URL", async () => {
    const backend = await createSidecarBackend("http://localhost:8080");
    expect(backend).toBeDefined();
    expect(typeof backend.exec).toBe("function");
  });
});

describe("sidecar exec", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("sends POST to /exec with command and timeout", async () => {
    mockFetch(() =>
      Response.json({ stdout: "file1.yml\n", stderr: "", exitCode: 0 }),
    );

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("ls");

    expect(result.stdout).toBe("file1.yml\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://localhost:8080/exec");

    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body.command).toBe("ls");
    expect(body.timeout).toBe(10_000);
  });

  it("returns stderr and non-zero exit code", async () => {
    mockFetch(() =>
      Response.json({
        stdout: "",
        stderr: "ls: cannot access '/foo': No such file\n",
        exitCode: 1,
      }),
    );

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("ls /foo");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
  });

  it("returns timeout error on AbortError", async () => {
    mockFetch(() => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    // Suppress log output during test
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("sleep 999");

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");

    warnSpy.mockRestore();
  });

  it("throws on connection refused and invalidates backend", async () => {
    let invalidated = false;

    // Mock the dynamic import of explore module
    const exploreModule = await import("@atlas/api/lib/tools/explore");
    const invalidateSpy = spyOn(
      exploreModule,
      "invalidateExploreBackend",
    ).mockImplementation(() => {
      invalidated = true;
    });

    mockFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const backend = await createSidecarBackend("http://localhost:8080");
    await expect(backend.exec("ls")).rejects.toThrow("Sidecar unreachable");

    expect(invalidated).toBe(true);

    errorSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it("handles HTTP 400 errors gracefully", async () => {
    mockFetch(
      () => new Response("Bad Request", { status: 400 }),
    );

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("ls");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTP 400");

    errorSpy.mockRestore();
  });

  it("handles HTTP 500 with exec response shape", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "Execution failed",
            stdout: "",
            stderr: "command not found",
            exitCode: 127,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
    );

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("nonexistent-cmd");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");

    errorSpy.mockRestore();
  });

  it("handles malformed JSON response", async () => {
    mockFetch(
      () => new Response("not json", { status: 200 }),
    );

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("ls");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to parse sidecar response");

    errorSpy.mockRestore();
  });

  it("handles missing fields in response with defaults", async () => {
    mockFetch(() => Response.json({ exitCode: 0 }));

    const backend = await createSidecarBackend("http://localhost:8080");
    const result = await backend.exec("ls");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
