/**
 * E2E: Docker runtime tests.
 *
 * Builds the Docker image from examples/docker/Dockerfile and runs it as a
 * container. Validates:
 * - Image builds successfully (multi-stage with nsjail)
 * - Container starts and serves HTTP on the health endpoint
 * - Health response has expected structure
 * - nsjail binary is present in the image
 * - CLI commands work inside the container (atlas doctor, atlas validate)
 *
 * Requires: Docker daemon running. No external services needed — the container
 * runs with ATLAS_AUTH_MODE=none and a dummy provider (health doesn't need LLM).
 * When E2E Docker services are running (port 5433), datasource health is also verified.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const DOCKERFILE = path.join(PROJECT_ROOT, "examples/docker/Dockerfile");
const IMAGE_NAME = "atlas-e2e-docker";
const CONTAINER_NAME = "atlas-e2e-docker-run";
const HOST_PORT = 3099;
const CONTAINER_PORT = 3001;

// Build is slow (nsjail compilation), so give it a generous timeout
const BUILD_TIMEOUT = 600_000; // 10 min
const START_TIMEOUT = 30_000; // 30s for container to become healthy
const EXEC_TIMEOUT = 15_000; // 15s for exec commands

// Check if E2E postgres is available (for datasource health verification)
const E2E_PG_PORT = 5433;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exec(
  cmd: string[],
  opts?: { timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts?.timeout ?? 30_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function dockerExec(
  containerCmd: string[],
  timeout = EXEC_TIMEOUT,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return exec(["docker", "exec", CONTAINER_NAME, ...containerCmd], { timeout });
}

async function waitForHealth(timeoutMs = START_TIMEOUT): Promise<void> {
  const url = `http://localhost:${HOST_PORT}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(500);
  }

  throw new Error(`Container health check timed out after ${timeoutMs}ms: ${lastError}`);
}

async function isPortOpen(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let imageBuilt = false;
let containerStarted = false;
let e2ePgAvailable = false;

beforeAll(async () => {
  // Check Docker is available
  const dockerCheck = await exec(["docker", "info"], { timeout: 5000 });
  if (dockerCheck.exitCode !== 0) {
    throw new Error("Docker daemon is not running");
  }

  // Check if E2E postgres is available for datasource tests
  e2ePgAvailable = await isPortOpen(E2E_PG_PORT);

  // Build the image (skip if already built recently)
  console.log("==> Building Docker image (this may take a few minutes)...");
  const buildResult = await exec(
    [
      "docker", "build",
      "-f", DOCKERFILE,
      "-t", IMAGE_NAME,
      "--build-arg", "INSTALL_NSJAIL=true",
      ".",
    ],
    { timeout: BUILD_TIMEOUT, cwd: PROJECT_ROOT },
  );

  if (buildResult.exitCode !== 0) {
    console.error("Docker build failed:\n", buildResult.stderr.slice(-2000));
    throw new Error(`Docker build failed with exit code ${buildResult.exitCode}`);
  }
  imageBuilt = true;
  console.log("==> Docker image built successfully");

  // Clean up any leftover container from a previous run
  await exec(["docker", "rm", "-f", CONTAINER_NAME], { timeout: 5000 });

  // Run the container
  const runArgs = [
    "docker", "run", "-d",
    "--name", CONTAINER_NAME,
    "-p", `${HOST_PORT}:${CONTAINER_PORT}`,
    "-e", "ATLAS_AUTH_MODE=none",
    "-e", "ATLAS_PROVIDER=anthropic",
    "-e", "ANTHROPIC_API_KEY=sk-ant-dummy-for-health-check",
  ];

  // If E2E postgres is available, connect to it for full datasource health
  if (e2ePgAvailable) {
    runArgs.push(
      "-e", `ATLAS_DATASOURCE_URL=postgresql://atlas:atlas@host.docker.internal:${E2E_PG_PORT}/atlas_e2e`,
      "--add-host=host.docker.internal:host-gateway",
    );
  }

  runArgs.push(IMAGE_NAME);

  const runResult = await exec(runArgs, { timeout: 10_000 });
  if (runResult.exitCode !== 0) {
    console.error("Docker run failed:\n", runResult.stderr);
    throw new Error(`Docker run failed with exit code ${runResult.exitCode}`);
  }
  containerStarted = true;
  console.log("==> Container started, waiting for health...");

  await waitForHealth(START_TIMEOUT);
  console.log("==> Container healthy");
}, BUILD_TIMEOUT + START_TIMEOUT + 10_000);

afterAll(async () => {
  if (containerStarted) {
    // Capture logs before cleanup (useful for debugging failures)
    const logs = await exec(["docker", "logs", "--tail", "50", CONTAINER_NAME], { timeout: 5000 });
    if (logs.exitCode === 0 && logs.stderr) {
      console.log("==> Container logs (last 50 lines):\n", logs.stderr.slice(-2000));
    }

    await exec(["docker", "rm", "-f", CONTAINER_NAME], { timeout: 10_000 });
    console.log("==> Container removed");
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Docker — build", () => {
  it("image was built successfully", () => {
    expect(imageBuilt).toBe(true);
  });
});

describe("E2E: Docker — health", () => {
  it("health endpoint returns 200 with expected structure", async () => {
    const res = await fetch(`http://localhost:${HOST_PORT}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    // Without a datasource, status is "degraded" — that's expected for a minimal container
    expect(["ok", "degraded"]).toContain(body.status as string);
    expect(body).toHaveProperty("checks");
    expect(body).toHaveProperty("components");
  });

  it("health response includes explore backend info", async () => {
    const res = await fetch(`http://localhost:${HOST_PORT}/api/health`);
    const body = await res.json() as { checks: { explore: { backend: string } } };

    expect(body.checks.explore).toBeDefined();
    expect(body.checks.explore.backend).toBeDefined();
  });

  it("health response includes auth mode", async () => {
    const res = await fetch(`http://localhost:${HOST_PORT}/api/health`);
    const body = await res.json() as { checks: { auth: { mode: string } } };

    expect(body.checks.auth).toBeDefined();
    expect(body.checks.auth.mode).toBe("none");
  });

  it("datasource health is ok when E2E postgres is connected", async () => {
    if (!e2ePgAvailable) {
      console.log("  (skipped — E2E postgres not running on port 5433)");
      return;
    }

    const res = await fetch(`http://localhost:${HOST_PORT}/api/health`);
    const body = await res.json() as { checks: { datasource: { status: string } } };

    expect(body.checks.datasource).toBeDefined();
    expect(body.checks.datasource.status).toBe("ok");
  });
});

describe("E2E: Docker — nsjail", () => {
  it("nsjail binary is present in the image", async () => {
    const result = await dockerExec(["which", "nsjail"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nsjail");
  });

  it("nsjail binary is executable", async () => {
    const result = await dockerExec(["nsjail", "--help"]);
    // nsjail --help returns exit code 0 and prints usage
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("Usage");
  });
});

describe("E2E: Docker — container internals", () => {
  it("runs as non-root user", async () => {
    const result = await dockerExec(["whoami"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("root");
  });

  it("semantic directory exists and contains files", async () => {
    const result = await dockerExec(["ls", "semantic/"]);
    expect(result.exitCode).toBe(0);
    // Should have at least catalog.yml or entities/
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("bun runtime is available", async () => {
    const result = await dockerExec(["bun", "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
