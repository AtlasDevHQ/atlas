/**
 * Sandbox sidecar — minimal HTTP server for isolated command execution.
 *
 * Designed to run as a separate container with NO secrets and only semantic/
 * files mounted. Provides per-request subprocess isolation: each POST /exec
 * creates a temporary directory for HOME/TMPDIR scratch space, runs the
 * command with cwd set to SEMANTIC_DIR, and cleans up.
 *
 * Endpoints:
 *   GET  /health — { status: "ok" }
 *   POST /exec   — { command, timeout? } → { stdout, stderr, exitCode }
 */

import type { SidecarExecRequest, SidecarExecResponse } from "@atlas/api/lib/sidecar-types";
import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const SEMANTIC_DIR = process.env.SEMANTIC_DIR ?? "/semantic";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

const AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;

let activeExecs = 0;
const MAX_CONCURRENT = 10;

/** Read up to `max` bytes from a ReadableStream. */
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
    await reader.cancel().catch(() => { /* stream cancel errors are non-critical */ });
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function handleExec(req: Request): Promise<Response> {
  // Optional auth check — if SIDECAR_AUTH_TOKEN is set, require it
  if (AUTH_TOKEN) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Concurrency control
  if (activeExecs >= MAX_CONCURRENT) {
    return Response.json({ error: "Too many concurrent executions" }, { status: 429 });
  }

  let body: SidecarExecRequest;
  try {
    body = (await req.json()) as SidecarExecRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.command || typeof body.command !== "string") {
    return Response.json({ error: "Missing or invalid 'command' field" }, { status: 400 });
  }

  // Clamp timeout: minimum 1s (prevent abuse), maximum 60s (prevent resource exhaustion)
  const timeout = Math.min(
    Math.max(body.timeout ?? DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );

  // Per-request isolation: unique temp directory
  const execId = randomUUID();
  const tmpDir = join("/tmp", `exec-${execId}`);

  console.log(`[sandbox-sidecar] exec=${execId} command=${body.command.slice(0, 200)} timeout=${timeout}`);

  const startTime = Date.now();
  activeExecs++;
  try {
    await mkdir(tmpDir, { recursive: true });

    // Security: The sidecar does NOT validate commands. Isolation comes from
    // the container boundary — no secrets mounted, minimal PATH, cwd fixed
    // to the semantic directory. The calling API is responsible for scoping
    // commands to safe operations (explore tool restrictions).
    const proc = Bun.spawn(["bash", "-c", body.command], {
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

    // Timeout enforcement
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

    const duration = Date.now() - startTime;
    console.log(`[sandbox-sidecar] exec=${execId} exitCode=${exitCode} stdoutLen=${stdout.length} duration=${duration}ms`);

    const result: SidecarExecResponse = { stdout, stderr, exitCode };
    return Response.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox-sidecar] exec=${execId} error=${detail}`);
    return Response.json(
      { error: `Execution failed: ${detail}`, stdout: "", stderr: detail, exitCode: 1 },
      { status: 500 },
    );
  } finally {
    activeExecs--;
    // Cleanup temp directory — fire and forget
    rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[sandbox-sidecar] Failed to clean up ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
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

Bun.serve({
  port: PORT,
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

console.log(`[sandbox-sidecar] listening on :${PORT}`);
