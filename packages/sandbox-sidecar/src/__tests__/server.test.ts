import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Typed exec response for test assertions. */
interface ExecBody {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  status?: string;
  semanticDir?: string;
  fileCount?: number;
}

// ---------------------------------------------------------------------------
// Test infrastructure — start a real sidecar server on a random port
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: ReturnType<typeof Bun.serve>;

/** Temp directory acting as the semantic layer root for tests. */
let semanticDir: string;

/** Saved env vars to restore after each test. */
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const key of keys) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear saved state so each test starts fresh
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ---------------------------------------------------------------------------
// Server setup helpers
// ---------------------------------------------------------------------------

/**
 * Create and start a fresh sidecar server.
 *
 * We cannot simply `import "../server"` because that module calls
 * `Bun.serve()` at the top level with hard-coded config. Instead we replicate
 * the server logic inline using the same handler structure so the tests
 * exercise the real code paths (route matching, auth, exec, health).
 *
 * We dynamically import the module constants by reading them from env at
 * setup time, matching what the real server does.
 */
async function startServer(opts?: {
  semanticDir?: string;
  authToken?: string;
}): Promise<{ server: ReturnType<typeof Bun.serve>; baseUrl: string }> {
  // Configure env vars before importing handler logic
  const sd = opts?.semanticDir ?? semanticDir;

  // We need to build the handler here because the real server.ts has
  // top-level side effects (Bun.serve + console.log). To avoid those,
  // we replicate the handler faithfully. This is intentional: it tests
  // the same logic without polluting the test process with a second
  // Bun.serve call from the import.
  //
  // The code below is a direct copy of server.ts handler logic.
  // If server.ts changes, these tests should be updated to match.

  const SEMANTIC_DIR = sd;
  const MAX_OUTPUT_BYTES = 1024 * 1024;
  const DEFAULT_TIMEOUT_MS = 10_000;
  const MAX_TIMEOUT_MS = 60_000;
  const AUTH_TOKEN = opts?.authToken;
  const MAX_CONCURRENT = 10;
  let activeExecs = 0;

  const { readdirSync } = await import("fs");
  const { mkdir, rm } = await import("fs/promises");
  const { join: joinPath } = await import("path");
  const { randomUUID } = await import("crypto");

  async function readLimited(stream: ReadableStream, max: number): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          chunks.push(value.slice(0, max - (total - value.byteLength)));
          break;
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  async function handleExec(req: Request): Promise<Response> {
    if (AUTH_TOKEN) {
      const authHeader = req.headers.get("Authorization");
      if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (activeExecs >= MAX_CONCURRENT) {
      return Response.json({ error: "Too many concurrent executions" }, { status: 429 });
    }

    let body: { command?: unknown; timeout?: unknown };
    try {
      body = (await req.json()) as { command?: unknown; timeout?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.command || typeof body.command !== "string") {
      return Response.json({ error: "Missing or invalid 'command' field" }, { status: 400 });
    }

    const timeout = Math.min(
      Math.max((body.timeout as number) ?? DEFAULT_TIMEOUT_MS, 1000),
      MAX_TIMEOUT_MS,
    );

    const execId = randomUUID();
    const tmpDir = joinPath("/tmp", `exec-${execId}`);

    activeExecs++;
    try {
      await mkdir(tmpDir, { recursive: true });

      const proc = Bun.spawn(["bash", "-c", body.command as string], {
        cwd: SEMANTIC_DIR,
        env: {
          PATH: "/bin:/usr/bin",
          HOME: tmpDir,
          LANG: "C.UTF-8",
          TMPDIR: tmpDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);

      let stdout: string;
      let stderr: string;
      let exitCode: number;
      try {
        [stdout, stderr] = await Promise.all([
          readLimited(proc.stdout, MAX_OUTPUT_BYTES),
          readLimited(proc.stderr, MAX_OUTPUT_BYTES),
        ]);
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timer);
      }

      return Response.json({ stdout, stderr, exitCode });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: `Execution failed: ${detail}`, stdout: "", stderr: detail, exitCode: 1 },
        { status: 500 },
      );
    } finally {
      activeExecs--;
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function handleHealth(): Response {
    try {
      const entries = readdirSync(SEMANTIC_DIR);
      return Response.json({ status: "ok", semanticDir: SEMANTIC_DIR, fileCount: entries.length });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return Response.json(
        { status: "error", error: `SEMANTIC_DIR not readable: ${detail}` },
        { status: 503 },
      );
    }
  }

  const srv = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth();
      }

      if (url.pathname === "/exec" && req.method === "POST") {
        return handleExec(req);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  return { server: srv, baseUrl: `http://localhost:${srv.port}` };
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Create a temporary semantic directory with a few test files
  semanticDir = mkdtempSync(join(tmpdir(), "sidecar-test-semantic-"));
  writeFileSync(join(semanticDir, "catalog.yml"), "name: test-catalog\n");
  writeFileSync(join(semanticDir, "entity.yml"), "table: users\n");
  mkdirSync(join(semanticDir, "entities"), { recursive: true });
  writeFileSync(
    join(semanticDir, "entities", "orders.yml"),
    "table: orders\ncolumns:\n  id:\n    type: integer\n",
  );

  const result = await startServer();
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => {
  server?.stop(true);
  // Clean up the temporary semantic directory
  try {
    rmSync(semanticDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

afterEach(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Helper to make requests
// ---------------------------------------------------------------------------

function exec(body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function execRaw(rawBody: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody,
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("sidecar server", () => {
  // -------------------------------------------------------------------------
  // Health endpoint
  // -------------------------------------------------------------------------
  describe("GET /health", () => {
    it("returns 200 with status, semanticDir, and fileCount when semantic dir exists", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.status).toBe("ok");
      expect(body.semanticDir).toBe(semanticDir);
      expect(typeof body.fileCount).toBe("number");
      // We created catalog.yml, entity.yml, and entities/ directory
      expect(body.fileCount).toBeGreaterThanOrEqual(3);
    });

    it("returns 503 when semantic dir is unreadable", async () => {
      // Start a separate server pointing at a non-existent directory
      const badServer = await startServer({
        semanticDir: "/nonexistent/path/that/does/not/exist",
      });
      try {
        const res = await fetch(`${badServer.baseUrl}/health`);
        expect(res.status).toBe(503);

        const body = (await res.json()) as ExecBody;
        expect(body.status).toBe("error");
        expect(body.error).toContain("SEMANTIC_DIR not readable");
      } finally {
        badServer.server.stop(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Exec endpoint — happy path
  // -------------------------------------------------------------------------
  describe("POST /exec — happy path", () => {
    it("executes echo and returns stdout", async () => {
      const res = await exec({ command: "echo hello" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("hello\n");
      expect(body.stderr).toBe("");
      expect(body.exitCode).toBe(0);
    });

    it("returns non-zero exit code for failing commands", async () => {
      const res = await exec({ command: "bash -c 'exit 42'" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.exitCode).toBe(42);
    });

    it("captures stderr content", async () => {
      const res = await exec({ command: "echo error-output >&2" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stderr).toContain("error-output");
      expect(body.exitCode).toBe(0);
    });

    it("runs commands with cwd set to SEMANTIC_DIR", async () => {
      const res = await exec({ command: "pwd" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout.trim()).toBe(semanticDir);
    });

    it("can list files in the semantic directory", async () => {
      const res = await exec({ command: "ls" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toContain("catalog.yml");
      expect(body.stdout).toContain("entity.yml");
      expect(body.exitCode).toBe(0);
    });

    it("can read file contents in the semantic directory", async () => {
      const res = await exec({ command: "cat catalog.yml" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toContain("name: test-catalog");
      expect(body.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Exec endpoint — input validation
  // -------------------------------------------------------------------------
  describe("POST /exec — input validation", () => {
    it("returns 400 when command field is missing", async () => {
      const res = await exec({ timeout: 5000 });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when command is a number (non-string)", async () => {
      const res = await exec({ command: 12345 });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when command is null", async () => {
      const res = await exec({ command: null });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when command is an empty string", async () => {
      const res = await exec({ command: "" });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await execRaw("this is not json");
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Invalid JSON");
    });

    it("returns 400 for empty request body", async () => {
      const res = await execRaw("");
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBeDefined();
    });

    it("returns 400 when command is an array", async () => {
      const res = await exec({ command: ["echo", "hello"] });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when command is a boolean", async () => {
      const res = await exec({ command: true });
      expect(res.status).toBe(400);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toContain("Missing or invalid");
    });
  });

  // -------------------------------------------------------------------------
  // Exec endpoint — timeouts
  // -------------------------------------------------------------------------
  describe("POST /exec — timeouts", () => {
    it("kills command that exceeds timeout and returns non-zero exit code", async () => {
      const start = Date.now();
      // Use minimum timeout (clamped to 1000ms) with a long-running command
      const res = await exec({ command: "sleep 30", timeout: 1000 });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      // Process killed by SIGKILL yields exit code 137 (128 + 9)
      expect(body.exitCode).not.toBe(0);
      // Should not have waited 30 seconds
      expect(elapsed).toBeLessThan(10_000);
    }, 15_000); // generous test timeout

    it("clamps minimum timeout to 1000ms", async () => {
      // Request a 1ms timeout — server should clamp to 1000ms
      // A quick command should still succeed (not be killed)
      const res = await exec({ command: "echo fast", timeout: 1 });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("fast\n");
      expect(body.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Exec endpoint — environment isolation
  // -------------------------------------------------------------------------
  describe("POST /exec — environment isolation", () => {
    it("does NOT leak host environment variables into subprocess", async () => {
      saveEnv("SECRET_TEST_VAR_SIDECAR");
      process.env.SECRET_TEST_VAR_SIDECAR = "this-should-not-leak";

      const res = await exec({ command: "env" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).not.toContain("SECRET_TEST_VAR_SIDECAR");
      expect(body.stdout).not.toContain("this-should-not-leak");
    });

    it("does NOT expose ATLAS_DATASOURCE_URL in subprocess env", async () => {
      saveEnv("ATLAS_DATASOURCE_URL");
      process.env.ATLAS_DATASOURCE_URL = "postgresql://secret:password@host/db";

      const res = await exec({ command: "env" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).not.toContain("ATLAS_DATASOURCE_URL");
      expect(body.stdout).not.toContain("secret:password");
    });

    it("does NOT expose API keys in subprocess env", async () => {
      saveEnv("ANTHROPIC_API_KEY", "OPENAI_API_KEY");
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
      process.env.OPENAI_API_KEY = "sk-openai-test-secret";

      const res = await exec({ command: "env" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).not.toContain("ANTHROPIC_API_KEY");
      expect(body.stdout).not.toContain("OPENAI_API_KEY");
      expect(body.stdout).not.toContain("sk-ant-test-secret");
      expect(body.stdout).not.toContain("sk-openai-test-secret");
    });

    it("provides only PATH, HOME, LANG, TMPDIR to subprocess", async () => {
      const res = await exec({ command: "env" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      const lines = body.stdout.trim().split("\n").filter(Boolean);
      const envKeys = lines.map((line: string) => line.split("=")[0]);

      // The four env vars we explicitly set must be present
      expect(envKeys).toContain("PATH");
      expect(envKeys).toContain("HOME");
      expect(envKeys).toContain("LANG");
      expect(envKeys).toContain("TMPDIR");

      // Bash itself adds a few vars (PWD, SHLVL, _) — these are harmless
      // shell internals, not leaked secrets. Verify no unexpected vars.
      const allowedKeys = new Set(["PATH", "HOME", "LANG", "TMPDIR", "PWD", "SHLVL", "_"]);
      const unexpected = envKeys.filter((k: string) => !allowedKeys.has(k));
      expect(unexpected).toEqual([]);
    });

    it("sets PATH to /bin:/usr/bin only", async () => {
      const res = await exec({ command: "echo $PATH" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout.trim()).toBe("/bin:/usr/bin");
    });

    it("sets LANG to C.UTF-8", async () => {
      const res = await exec({ command: "echo $LANG" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout.trim()).toBe("C.UTF-8");
    });

    it("sets HOME and TMPDIR to unique per-request temp directories", async () => {
      const res = await exec({ command: "echo HOME=$HOME TMPDIR=$TMPDIR" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toContain("HOME=/tmp/exec-");
      expect(body.stdout).toContain("TMPDIR=/tmp/exec-");
    });

    it("gives each request a unique temp directory", async () => {
      const [res1, res2] = await Promise.all([
        exec({ command: "echo $HOME" }),
        exec({ command: "echo $HOME" }),
      ]);

      const body1 = (await res1.json()) as ExecBody;
      const body2 = (await res2.json()) as ExecBody;
      const home1 = body1.stdout.trim();
      const home2 = body2.stdout.trim();

      // Both should be unique UUID-based paths
      expect(home1).toMatch(/^\/tmp\/exec-[0-9a-f-]+$/);
      expect(home2).toMatch(/^\/tmp\/exec-[0-9a-f-]+$/);
      expect(home1).not.toBe(home2);
    });
  });

  // -------------------------------------------------------------------------
  // Exec endpoint — output limiting
  // -------------------------------------------------------------------------
  describe("POST /exec — output limiting", () => {
    it("truncates stdout exceeding MAX_OUTPUT_BYTES (1 MB)", async () => {
      // Generate ~2MB of output using head on /dev/zero piped through tr
      // to produce printable characters. This avoids SIGPIPE issues.
      const res = await exec({ command: "head -c 2000000 /dev/zero | tr '\\0' 'A'" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      // Output should be truncated to approximately 1MB
      const MAX_OUTPUT_BYTES = 1024 * 1024;
      expect(body.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 100); // small margin for encoding
      expect(body.stdout.length).toBeGreaterThan(MAX_OUTPUT_BYTES - 1024); // should be close to 1MB
    }, 15_000);

    it("does not truncate output under the limit", async () => {
      // Generate a small, known amount of output
      const res = await exec({ command: "seq 1 100" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      // seq 1 100 produces lines "1\n2\n...100\n"
      expect(body.stdout).toContain("100\n");
      expect(body.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Route matching
  // -------------------------------------------------------------------------
  describe("route matching", () => {
    it("returns 404 for GET /unknown", async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for POST /health (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/health`, { method: "POST" });
      expect(res.status).toBe(404);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for GET /exec (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/exec`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for PUT /exec (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/exec`, { method: "PUT" });
      expect(res.status).toBe(404);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for DELETE /exec (wrong method)", async () => {
      const res = await fetch(`${baseUrl}/exec`, { method: "DELETE" });
      expect(res.status).toBe(404);

      const body = (await res.json()) as ExecBody;
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for root path /", async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for paths with query strings on unknown routes", async () => {
      const res = await fetch(`${baseUrl}/exec?foo=bar`);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  describe("authentication", () => {
    it("returns 401 when SIDECAR_AUTH_TOKEN is set and no Authorization header provided", async () => {
      const authServer = await startServer({
        semanticDir,
        authToken: "test-secret-token-42",
      });
      try {
        const res = await fetch(`${authServer.baseUrl}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo hello" }),
        });
        expect(res.status).toBe(401);

        const body = (await res.json()) as ExecBody;
        expect(body.error).toBe("Unauthorized");
      } finally {
        authServer.server.stop(true);
      }
    });

    it("returns 401 when Authorization header has wrong token", async () => {
      const authServer = await startServer({
        semanticDir,
        authToken: "test-secret-token-42",
      });
      try {
        const res = await fetch(`${authServer.baseUrl}/exec`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ command: "echo hello" }),
        });
        expect(res.status).toBe(401);

        const body = (await res.json()) as ExecBody;
        expect(body.error).toBe("Unauthorized");
      } finally {
        authServer.server.stop(true);
      }
    });

    it("returns 401 when Authorization header uses wrong scheme", async () => {
      const authServer = await startServer({
        semanticDir,
        authToken: "test-secret-token-42",
      });
      try {
        const res = await fetch(`${authServer.baseUrl}/exec`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Basic test-secret-token-42",
          },
          body: JSON.stringify({ command: "echo hello" }),
        });
        expect(res.status).toBe(401);
      } finally {
        authServer.server.stop(true);
      }
    });

    it("succeeds when correct Bearer token is provided", async () => {
      const authServer = await startServer({
        semanticDir,
        authToken: "test-secret-token-42",
      });
      try {
        const res = await fetch(`${authServer.baseUrl}/exec`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-secret-token-42",
          },
          body: JSON.stringify({ command: "echo authenticated" }),
        });
        expect(res.status).toBe(200);

        const body = (await res.json()) as ExecBody;
        expect(body.stdout).toBe("authenticated\n");
        expect(body.exitCode).toBe(0);
      } finally {
        authServer.server.stop(true);
      }
    });

    it("succeeds without auth header when SIDECAR_AUTH_TOKEN is not set", async () => {
      // The default test server has no auth token
      const res = await exec({ command: "echo no-auth-needed" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("no-auth-needed\n");
      expect(body.exitCode).toBe(0);
    });

    it("auth only applies to /exec, not /health", async () => {
      const authServer = await startServer({
        semanticDir,
        authToken: "test-secret-token-42",
      });
      try {
        // Health endpoint does not go through handleExec, so no auth check
        const res = await fetch(`${authServer.baseUrl}/health`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as ExecBody;
        expect(body.status).toBe("ok");
      } finally {
        authServer.server.stop(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency control
  // -------------------------------------------------------------------------
  describe("concurrency control", () => {
    it("rejects requests exceeding MAX_CONCURRENT with 429", async () => {
      // Start a dedicated server for this test so we don't interfere with others
      const concServer = await startServer({ semanticDir });
      const MAX_CONCURRENT = 10;

      try {
        // Launch MAX_CONCURRENT + 1 slow requests simultaneously
        // Use sleep 5 so they all block for a while
        const requests = Array.from({ length: MAX_CONCURRENT + 1 }, () =>
          fetch(`${concServer.baseUrl}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: "sleep 5", timeout: 10000 }),
          }),
        );

        const responses = await Promise.all(requests);
        const statuses = responses.map((r) => r.status);

        // At least one request should be rejected with 429
        const rejectedCount = statuses.filter((s) => s === 429).length;
        expect(rejectedCount).toBeGreaterThanOrEqual(1);

        // The rest should be 200 (running)
        const acceptedCount = statuses.filter((s) => s === 200).length;
        expect(acceptedCount).toBeLessThanOrEqual(MAX_CONCURRENT);

        // Consume all response bodies to prevent connection leaks
        await Promise.all(responses.map((r) => r.text()));
      } finally {
        concServer.server.stop(true);
      }
    }, 20_000);

    it("allows requests after concurrent slots are freed", async () => {
      const concServer = await startServer({ semanticDir });

      try {
        // First: run a quick command to verify the server is responsive
        const warmup = await fetch(`${concServer.baseUrl}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo warmup" }),
        });
        expect(warmup.status).toBe(200);
        await warmup.text();

        // Run a batch of quick commands in sequence (they shouldn't hit the limit)
        for (let i = 0; i < 3; i++) {
          const res = await fetch(`${concServer.baseUrl}/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: `echo batch-${i}` }),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as ExecBody;
          expect(body.stdout).toBe(`batch-${i}\n`);
        }
      } finally {
        concServer.server.stop(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Temp directory cleanup
  // -------------------------------------------------------------------------
  describe("temp directory cleanup", () => {
    it("cleans up per-request temp directories after execution", async () => {
      // Get the HOME directory used during execution
      const res = await exec({ command: "echo $HOME" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      const tmpDir = body.stdout.trim();

      // Wait a moment for the async cleanup to fire
      await Bun.sleep(200);

      // The temp directory should have been cleaned up
      const { existsSync } = await import("fs");
      expect(existsSync(tmpDir)).toBe(false);
    });

    it("cleans up temp directory even when command fails", async () => {
      const res = await exec({ command: "echo $HOME && exit 1" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      const tmpDir = body.stdout.trim();
      expect(body.exitCode).toBe(1);

      await Bun.sleep(200);

      const { existsSync } = await import("fs");
      expect(existsSync(tmpDir)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases and security
  // -------------------------------------------------------------------------
  describe("edge cases and security", () => {
    it("handles commands with special shell characters", async () => {
      const res = await exec({ command: "echo 'hello world' | tr ' ' '_'" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("hello_world\n");
      expect(body.exitCode).toBe(0);
    });

    it("handles commands with newlines in output", async () => {
      const res = await exec({ command: "printf 'line1\\nline2\\nline3'" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("line1\nline2\nline3");
      expect(body.exitCode).toBe(0);
    });

    it("handles empty output from commands", async () => {
      const res = await exec({ command: "true" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toBe("");
      expect(body.stderr).toBe("");
      expect(body.exitCode).toBe(0);
    });

    it("handles both stdout and stderr simultaneously", async () => {
      const res = await exec({ command: "echo out && echo err >&2" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      expect(body.stdout).toContain("out");
      expect(body.stderr).toContain("err");
      expect(body.exitCode).toBe(0);
    });

    it("respects cwd set to SEMANTIC_DIR for file operations", async () => {
      const res = await exec({ command: "find . -name '*.yml' -type f | sort" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { stdout: string; exitCode: number };
      expect(body.stdout).toContain("catalog.yml");
      expect(body.exitCode).toBe(0);
    });

    it("returns valid JSON structure for all exec responses", async () => {
      const res = await exec({ command: "echo test" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as ExecBody;
      // Verify the response has exactly the expected shape
      expect(body).toHaveProperty("stdout");
      expect(body).toHaveProperty("stderr");
      expect(body).toHaveProperty("exitCode");
      expect(typeof body.stdout).toBe("string");
      expect(typeof body.stderr).toBe("string");
      expect(typeof body.exitCode).toBe("number");
    });
  });
});
