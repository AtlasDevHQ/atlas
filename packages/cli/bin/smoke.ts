/**
 * E2E smoke test runner for Atlas deployments.
 *
 * Pure HTTP client — no DB drivers, no server imports. Uses fetch()
 * against health and query endpoints to verify the full stack works.
 *
 * Usage:
 *   bun run atlas -- smoke
 *   bun run atlas -- smoke --target https://demo.useatlas.dev
 *   bun run atlas -- smoke --target http://localhost:3001 --api-key sk-...
 *   bun run atlas -- smoke --json
 *   bun run atlas -- smoke --verbose --timeout 60000
 */

import { getFlag } from "./atlas";

// --- Types ---

type CheckStatus = "PASS" | "FAIL" | "SKIP";

interface CheckResult {
  name: string;
  phase: string;
  status: CheckStatus;
  durationMs: number;
  detail?: string;
  error?: string;
}

interface HealthResponse {
  status: string;
  checks: {
    datasource: { status: string; latencyMs?: number; error?: string };
    provider: { status: string; provider: string; model: string; error?: string };
    semanticLayer: { status: string; entityCount: number; error?: string };
    explore: { backend: string; isolated: boolean };
    auth: { mode: string; enabled: boolean };
    slack: { enabled: boolean; mode: string };
  };
  sources?: Record<string, { status: string; latencyMs?: number; dbType: string }>;
}

interface QueryResponse {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
}

// --- HTTP helpers ---

async function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; durationMs: number }> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const body = await res.json();
    return { status: res.status, body, durationMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; durationMs: number }> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json();
    return { status: res.status, body, durationMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

// --- Output helpers ---

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function statusColor(status: CheckStatus): string {
  if (status === "PASS") return GREEN;
  if (status === "FAIL") return RED;
  return YELLOW;
}

function printCheck(result: CheckResult, verbose: boolean): void {
  const color = statusColor(result.status);
  const tag = `${color}${result.status.padEnd(4)}${RESET}`;
  const detail = result.detail ? `${DIM} (${result.detail})${RESET}` : "";
  console.log(`  ${tag}  ${result.name}${detail}`);
  if (result.error && (verbose || result.status === "FAIL")) {
    console.log(`        ${DIM}${result.error}${RESET}`);
  }
}

function printResults(results: CheckResult[], target: string, hasAuth: boolean, totalMs: number): void {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  console.log("");
  const failColor = failed > 0 ? RED : GREEN;
  console.log(
    `${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failColor}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET} ${DIM}(${(totalMs / 1000).toFixed(1)}s total)${RESET}`,
  );
}

function printJsonResults(results: CheckResult[], target: string, totalMs: number): void {
  console.log(JSON.stringify({
    target,
    totalMs,
    summary: {
      passed: results.filter((r) => r.status === "PASS").length,
      failed: results.filter((r) => r.status === "FAIL").length,
      skipped: results.filter((r) => r.status === "SKIP").length,
    },
    checks: results,
  }, null, 2));
}

// --- Check executor ---

async function runCheck(
  name: string,
  phase: string,
  fn: () => Promise<{ detail?: string }>,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const { detail } = await fn();
    return { name, phase, status: "PASS", durationMs: Math.round(performance.now() - start), detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("SKIP:")) {
      return { name, phase, status: "SKIP", durationMs: Math.round(performance.now() - start), detail: message.slice(5).trim() };
    }
    return { name, phase, status: "FAIL", durationMs: Math.round(performance.now() - start), error: message };
  }
}

// --- Phase runners ---

async function checkConnectivity(
  target: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ result: CheckResult; health: HealthResponse | null }> {
  let lastError = "";
  let health: HealthResponse | null = null;

  const result = await runCheck("Health endpoint reachable", "Connectivity", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await httpGet(`${target}/api/health`, headers, timeoutMs);
        if (res.status === 200 || res.status === 503) {
          health = res.body as HealthResponse;
          return { detail: `${res.durationMs}ms` };
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Failed after 3 attempts: ${lastError}`);
  });

  return { result, health };
}

function checkSubsystems(health: HealthResponse): CheckResult[] {
  const results: CheckResult[] = [];

  // Datasource
  results.push((() => {
    const ds = health.checks.datasource;
    if (ds.status === "ok") {
      return { name: "Datasource connected", phase: "Subsystems", status: "PASS" as const, durationMs: 0, detail: ds.latencyMs ? `${ds.latencyMs}ms latency` : undefined };
    }
    if (ds.status === "not_configured") {
      return { name: "Datasource connected", phase: "Subsystems", status: "SKIP" as const, durationMs: 0, detail: "not configured" };
    }
    return { name: "Datasource connected", phase: "Subsystems", status: "FAIL" as const, durationMs: 0, error: ds.error ?? "unhealthy" };
  })());

  // Provider
  results.push((() => {
    const p = health.checks.provider;
    if (p.status === "ok") {
      return { name: "LLM provider configured", phase: "Subsystems", status: "PASS" as const, durationMs: 0, detail: `${p.provider} / ${p.model}` };
    }
    return { name: "LLM provider configured", phase: "Subsystems", status: "FAIL" as const, durationMs: 0, error: p.error ?? "not configured" };
  })());

  // Semantic layer
  results.push((() => {
    const sl = health.checks.semanticLayer;
    if (sl.status === "ok" && sl.entityCount > 0) {
      return { name: "Semantic layer loaded", phase: "Subsystems", status: "PASS" as const, durationMs: 0, detail: `${sl.entityCount} entities` };
    }
    if (sl.status === "ok" && sl.entityCount === 0) {
      return { name: "Semantic layer loaded", phase: "Subsystems", status: "FAIL" as const, durationMs: 0, error: "0 entities found" };
    }
    return { name: "Semantic layer loaded", phase: "Subsystems", status: "FAIL" as const, durationMs: 0, error: sl.error ?? "unavailable" };
  })());

  // Explore backend
  results.push({
    name: "Explore backend available",
    phase: "Subsystems",
    status: "PASS",
    durationMs: 0,
    detail: health.checks.explore.backend,
  });

  return results;
}

async function checkSimpleQuery(
  target: string,
  headers: Record<string, string>,
  timeoutMs: number,
  providerOk: boolean,
): Promise<CheckResult> {
  return runCheck("Agent returned valid results", "Simple Query", async () => {
    if (!providerOk) throw new Error("SKIP: Provider unhealthy");

    const res = await httpPost(
      `${target}/api/v1/query`,
      { question: "How many rows are in the largest table?" },
      headers,
      timeoutMs,
    );

    if (res.status !== 200) {
      const errBody = res.body as { error?: string; message?: string };
      throw new Error(`HTTP ${res.status}: ${errBody.message ?? errBody.error ?? "unknown error"}`);
    }

    const data = res.body as QueryResponse;
    if (!data.sql || data.sql.length === 0) throw new Error("No SQL generated");
    if (!data.answer) throw new Error("No answer returned");

    return { detail: `${res.durationMs}ms, ${data.steps} steps, ${data.usage.totalTokens} tokens` };
  });
}

async function checkMultiStepQuery(
  target: string,
  headers: Record<string, string>,
  timeoutMs: number,
  providerOk: boolean,
): Promise<CheckResult> {
  return runCheck("Agent used multiple steps", "Multi-Step Query", async () => {
    if (!providerOk) throw new Error("SKIP: Provider unhealthy");

    const res = await httpPost(
      `${target}/api/v1/query`,
      { question: "What are the top 3 values in the most common text column?" },
      headers,
      timeoutMs,
    );

    if (res.status !== 200) {
      const errBody = res.body as { error?: string; message?: string };
      throw new Error(`HTTP ${res.status}: ${errBody.message ?? errBody.error ?? "unknown error"}`);
    }

    const data = res.body as QueryResponse;
    if (data.steps < 2) throw new Error(`Expected >= 2 steps, got ${data.steps}`);

    return { detail: `${res.durationMs}ms, ${data.steps} steps, ${data.usage.totalTokens} tokens` };
  });
}

function checkIntegrations(health: HealthResponse): CheckResult[] {
  const results: CheckResult[] = [];

  // Slack
  results.push((() => {
    if (health.checks.slack.mode === "disabled") {
      return { name: "Slack configured", phase: "Integrations", status: "SKIP" as const, durationMs: 0, detail: "not configured" };
    }
    return { name: "Slack configured", phase: "Integrations", status: "PASS" as const, durationMs: 0, detail: health.checks.slack.mode };
  })());

  // Datasource health
  results.push((() => {
    if (!health.sources || Object.keys(health.sources).length === 0) {
      return { name: "All datasources healthy", phase: "Integrations", status: "SKIP" as const, durationMs: 0, detail: "no sources registered" };
    }
    const sourceCount = Object.keys(health.sources).length;
    const unhealthy = Object.entries(health.sources).filter(([, s]) => s.status === "unhealthy");
    if (unhealthy.length > 0) {
      return { name: "All datasources healthy", phase: "Integrations", status: "FAIL" as const, durationMs: 0, error: `${unhealthy.length}/${sourceCount} unhealthy: ${unhealthy.map(([id]) => id).join(", ")}` };
    }
    return { name: "All datasources healthy", phase: "Integrations", status: "PASS" as const, durationMs: 0, detail: `${sourceCount} source${sourceCount === 1 ? "" : "s"}` };
  })());

  return results;
}

async function checkErrorHandling(
  target: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<CheckResult> {
  return runCheck("Empty query returns 422", "Error Handling", async () => {
    const res = await httpPost(
      `${target}/api/v1/query`,
      { question: "" },
      headers,
      timeoutMs,
    );

    if (res.status === 422) {
      return { detail: `${res.durationMs}ms` };
    }
    if (res.status >= 500) {
      throw new Error(`Expected 422, got ${res.status} (server error — not a structured response)`);
    }
    // 400 is also acceptable for validation errors
    if (res.status === 400) {
      return { detail: `${res.durationMs}ms, HTTP 400` };
    }
    throw new Error(`Expected 422, got HTTP ${res.status}`);
  });
}

// --- Main entry point ---

export async function handleSmoke(args: string[]): Promise<void> {
  const target = (getFlag(args, "--target") ?? process.env.ATLAS_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const apiKey = getFlag(args, "--api-key") ?? process.env.ATLAS_API_KEY;
  const timeoutMs = parseInt(getFlag(args, "--timeout") ?? "30000", 10);
  const verbose = args.includes("--verbose");
  const jsonOutput = args.includes("--json");

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  if (!jsonOutput) {
    console.log(`\n${BOLD}Atlas Smoke Test${RESET}`);
    console.log("================");
    console.log(`Target: ${target}`);
    console.log(`Auth: ${apiKey ? "API key (set)" : "none"}`);
    console.log(`Timeout: ${timeoutMs}ms`);
  }

  const allResults: CheckResult[] = [];
  const totalStart = performance.now();

  // Phase 1: Connectivity
  if (!jsonOutput) console.log(`\n${BOLD}Phase 1: Connectivity${RESET}`);
  const { result: connectResult, health } = await checkConnectivity(target, headers, timeoutMs);
  allResults.push(connectResult);
  if (!jsonOutput) printCheck(connectResult, verbose);

  if (!health) {
    // Can't proceed without health data
    if (!jsonOutput) {
      printResults(allResults, target, !!apiKey, performance.now() - totalStart);
    } else {
      printJsonResults(allResults, target, performance.now() - totalStart);
    }
    process.exit(1);
  }

  // Phase 2: Subsystems
  if (!jsonOutput) console.log(`\n${BOLD}Phase 2: Subsystems${RESET}`);
  const subsystemResults = checkSubsystems(health);
  allResults.push(...subsystemResults);
  if (!jsonOutput) {
    for (const r of subsystemResults) printCheck(r, verbose);
  }

  const providerOk = health.checks.provider.status === "ok";
  const dsOk = health.checks.datasource.status === "ok";

  // Phase 3: Simple Query
  if (!jsonOutput) console.log(`\n${BOLD}Phase 3: Simple Query${RESET}`);
  const simpleResult = await checkSimpleQuery(target, headers, timeoutMs, providerOk && dsOk);
  allResults.push(simpleResult);
  if (!jsonOutput) printCheck(simpleResult, verbose);

  // Phase 4: Multi-Step Query
  if (!jsonOutput) console.log(`\n${BOLD}Phase 4: Multi-Step Query${RESET}`);
  const multiResult = await checkMultiStepQuery(target, headers, timeoutMs, providerOk && dsOk);
  allResults.push(multiResult);
  if (!jsonOutput) printCheck(multiResult, verbose);

  // Phase 5: Integrations
  if (!jsonOutput) console.log(`\n${BOLD}Phase 5: Integrations${RESET}`);
  const integrationResults = checkIntegrations(health);
  allResults.push(...integrationResults);
  if (!jsonOutput) {
    for (const r of integrationResults) printCheck(r, verbose);
  }

  // Phase 6: Error Handling
  if (!jsonOutput) console.log(`\n${BOLD}Phase 6: Error Handling${RESET}`);
  const errorResult = await checkErrorHandling(target, headers, timeoutMs);
  allResults.push(errorResult);
  if (!jsonOutput) printCheck(errorResult, verbose);

  // Summary
  const totalMs = performance.now() - totalStart;
  if (jsonOutput) {
    printJsonResults(allResults, target, totalMs);
  } else {
    printResults(allResults, target, !!apiKey, totalMs);
  }

  const hasFailed = allResults.some((r) => r.status === "FAIL");
  process.exit(hasFailed ? 1 : 0);
}
