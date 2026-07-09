/**
 * Python execution tool for data analysis and visualization.
 *
 * Runs Python code in an isolated sandbox — a sidecar container
 * (ATLAS_SANDBOX_URL), Vercel Sandbox (Firecracker microVM), or nsjail
 * (Linux namespace sandbox). Backend selection mirrors the explore tool's
 * priority chain.
 *
 * Security model:
 * - AST-based import guard runs first as defense-in-depth (catches obvious mistakes)
 * - The sandbox backend is the actual security boundary (no secrets, no network)
 * - Requires either a sidecar, Vercel sandbox, or nsjail — refuses to run without isolation
 */

import { tool } from "ai";
import { z } from "zod";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { withSpan } from "@atlas/api/lib/tracing";
import { getConfig } from "@atlas/api/lib/config";
import { getWorkspaceSandboxOverride } from "@atlas/api/lib/sandbox/workspace-override";
import { useVercelSandbox, useSidecar } from "./backends/detect";
import {
  planSandboxSelection,
  runSandboxPlan,
  formatSandboxPriorityFailure,
  assertNever,
  type SandboxSelectionEnv,
} from "./backends/selection";
import { getStreamWriter } from "./python-stream";
import type { PythonSandboxOptions } from "./python-sandbox";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";

const log = createLogger("python");

// --- Import guard (defense-in-depth) ---

/** Default blocked modules — the baseline when no config overrides are set. */
export const DEFAULT_BLOCKED_MODULES = new Set([
  "subprocess",
  "os",
  "socket",
  "shutil",
  "sys",
  "ctypes",
  "importlib",
  "code",
  "signal",
  "multiprocessing",
  "threading",
  "pty",
  "fcntl",
  "termios",
  "resource",
  "posixpath",
  // Network modules
  "http",
  "urllib",
  "requests",
  "httpx",
  "aiohttp",
  "webbrowser",
  // Dangerous serialization/filesystem
  "pickle",
  "tempfile",
  "pathlib",
]);

/**
 * Critical modules that can never be unblocked, even with `python.allowModules`.
 * These provide direct OS/process access that no sandbox config should override.
 */
export const CRITICAL_MODULES = new Set(["os", "subprocess", "sys", "shutil"]);

/**
 * Build the effective blocked module set from the default list + config overrides.
 * Called on each validation rather than cached at module load, so any config
 * singleton update (e.g. test mocking or future hot-reload) takes effect on
 * the next call.
 */
export function getEffectiveBlockedModules(): Set<string> {
  const config = getConfig();
  const pythonConfig = config?.python;

  if (!pythonConfig) return DEFAULT_BLOCKED_MODULES;

  const { blockedModules, allowModules } = pythonConfig;

  // Reject attempts to unblock critical modules
  const criticalViolations = allowModules.filter((m) => CRITICAL_MODULES.has(m));
  if (criticalViolations.length > 0) {
    throw new Error(
      `Cannot unblock critical Python modules: ${criticalViolations.join(", ")}. ` +
      `These modules (${[...CRITICAL_MODULES].join(", ")}) are blocked regardless of configuration.`,
    );
  }

  const allowSet = new Set(allowModules);
  const effective = new Set<string>();

  for (const mod of DEFAULT_BLOCKED_MODULES) {
    if (!allowSet.has(mod)) effective.add(mod);
  }
  for (const mod of blockedModules) {
    effective.add(mod);
  }

  return effective;
}

const BLOCKED_BUILTINS = new Set([
  "compile",
  "exec",
  "eval",
  "__import__",
  "open",
  "breakpoint",
  "getattr",
  "globals",
  "locals",
  "vars",
  "dir",
  "delattr",
  "setattr",
]);

/**
 * Validate Python code for blocked imports and dangerous builtins.
 *
 * Uses Python's own `ast` module to parse the code, then checks for:
 * - `import X` / `from X import ...` where X is in the effective blocked set
 *   (see {@link getEffectiveBlockedModules})
 * - Calls to blocked builtins (exec, eval, compile, __import__, open, getattr, etc.)
 *
 * This is defense-in-depth — the sidecar container is the security boundary.
 * Returns { safe: true } or { safe: false, reason: string }.
 */
export async function validatePythonCode(
  code: string,
): Promise<{ safe: true } | { safe: false; reason: string }> {
  // Build a Python script that uses ast to extract imports and dangerous calls
  const checkerScript = `
import ast, json, sys

code = sys.stdin.read()
try:
    tree = ast.parse(code)
except SyntaxError as e:
    json.dump({"error": f"SyntaxError: {e.msg} (line {e.lineno})"}, sys.stdout)
    sys.exit(0)

imports = []
calls = []

for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append(alias.name.split('.')[0])
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            imports.append(node.module.split('.')[0])
    elif isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name):
            calls.append(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            calls.append(node.func.attr)

json.dump({"imports": imports, "calls": calls}, sys.stdout)
`;

  let proc;
  try {
    proc = Bun.spawn(["python3", "-c", checkerScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: detail }, "python3 not available for AST validation — guard skipped, sandbox backend will enforce");
    // If python3 isn't available locally, skip the guard.
    // The sidecar is the security boundary, not this check.
    return { safe: true };
  }

  try {
    // fire-and-forget: Bun FileSink write/end return number|Promise; original code never awaited and relies on Bun's buffering
    void proc.stdin.write(code);
    void proc.stdin.end();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: detail }, "Failed to write to python3 stdin");
    return { safe: false, reason: `Code analysis failed: ${detail}` };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    log.warn({ stderr, exitCode }, "Python AST checker failed");
    return { safe: false, reason: `Code analysis failed: ${stderr.trim() || "unknown error"}` };
  }

  let result: { error?: string; imports?: string[]; calls?: string[] };
  try {
    result = JSON.parse(stdout);
  } catch {
    log.warn({ stdout: stdout.slice(0, 500) }, "Python AST checker produced unparseable output");
    return { safe: false, reason: "Code analysis produced invalid output" };
  }

  if (result.error) {
    return { safe: false, reason: result.error };
  }

  // Check imports
  let blockedModules: Set<string>;
  try {
    blockedModules = getEffectiveBlockedModules();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err: detail }, "Failed to compute effective blocked modules — likely a config error");
    return { safe: false, reason: detail };
  }

  for (const mod of result.imports ?? []) {
    if (blockedModules.has(mod)) {
      return { safe: false, reason: `Blocked import: "${mod}" is not allowed` };
    }
  }

  // Check dangerous builtins
  for (const call of result.calls ?? []) {
    if (BLOCKED_BUILTINS.has(call)) {
      return { safe: false, reason: `Blocked builtin: "${call}()" is not allowed` };
    }
  }

  return { safe: true };
}

// --- Output types ---

export interface PythonChart {
  base64: string;
  mimeType: "image/png";
}

export interface RechartsChart {
  type: "line" | "bar" | "pie";
  data: Record<string, unknown>[];
  categoryKey: string;
  valueKeys: string[];
}

export type PythonResult =
  | {
      success: true;
      output?: string;
      table?: { columns: string[]; rows: unknown[][] };
      charts?: PythonChart[];
      rechartsCharts?: RechartsChart[];
    }
  | {
      success: false;
      error: string;
      output?: string;
    };

// --- Progress events ---

/** Events emitted during streaming Python execution. */
export type PythonProgressEvent =
  | { type: "stdout"; content: string }
  | { type: "chart"; chart: PythonChart }
  | { type: "recharts"; chart: RechartsChart };

// --- Backend interface ---

/**
 * Python execution backend. Implementations handle isolation (sidecar, Vercel sandbox, nsjail).
 * Each backend receives validated code + optional data and returns a structured result.
 * Backends that support streaming implement the optional `execStream` method.
 */
export interface PythonBackend {
  exec(code: string, data?: { columns: string[]; rows: unknown[][] }): Promise<PythonResult>;
  execStream?(
    code: string,
    data: { columns: string[]; rows: unknown[][] } | undefined,
    onProgress: (event: PythonProgressEvent) => void,
  ): Promise<PythonResult>;
}

// --- Backend selection ---

/**
 * Derive the Vercel Python sandbox options for a resolved REST datasource:
 * the per-tenant egress allowlist (#2927 layer 0), or `{}` (deny-all) when no
 * datasource is active. Computed server-side from the resolved datasource's
 * base URL — never from the agent's `code`. Shared by the operator Vercel
 * branch in {@link getPythonBackend} and the BYOC Vercel path (#3410) so the
 * org's own sandbox gets the same egress bound as the platform one.
 */
async function vercelSandboxOptionsFor(
  restDatasource: RestDatasource | null,
): Promise<PythonSandboxOptions> {
  if (!restDatasource) return {};
  const { computeNetworkAllowlist, networkPolicyFromAllowlist } = await import(
    "./backends/network-allowlist"
  );
  const allowlist = computeNetworkAllowlist([restDatasource.baseUrl]);
  if (allowlist.length === 0) {
    // Honor network-allowlist.ts's "caller logs the drop" contract: a
    // configured datasource whose base URL doesn't parse to a host
    // collapses to deny-all (fail-closed) — surface why so the operator
    // isn't left guessing. Log the datasource id, not the URL (a base URL
    // could carry a token in a query param).
    log.warn(
      { datasource: restDatasource.id },
      "REST datasource base URL did not yield a reachable host — Python sandbox egress stays deny-all",
    );
  } else if (restDatasource.baseUrl.toLowerCase().startsWith("http://")) {
    // Vercel's sandbox domain allowlist matches hosts by SNI (TLS), so a
    // plain-http:// datasource host may not be reachable from the sandbox
    // even though it is listed. The policy is still applied (the boundary is
    // fail-closed either way — an unmatched host stays denied, not opened);
    // we warn so an operator on a non-TLS datasource isn't left wondering why
    // egress is blocked. Prefer https:// for REST datasources on SaaS. (#2975)
    log.warn(
      { datasource: restDatasource.id },
      "REST datasource base URL is plain http:// — the Vercel sandbox domain allowlist matches HTTPS hosts (by SNI), so sandbox egress to this host may stay blocked even though it is listed; prefer https://",
    );
  }
  return { networkPolicy: networkPolicyFromAllowlist(allowlist) };
}

/**
 * Snapshot the env + config inputs that drive backend selection into the shape
 * the shared pure planner ({@link planSandboxSelection}) consumes — the SAME
 * snapshot the explore tool builds, which is what makes the two tools resolve
 * the same backend for the same env/config (#4187).
 *
 * `nsjailFailed` is always `false`: unlike explore, the Python nsjail backend
 * has no exit-109 runtime-degradation callback, so it re-attempts nsjail each
 * turn (its prior behavior). The config priority (`sandbox.priority`, also fed
 * by `ATLAS_SANDBOX_PRIORITY`) is honored here for the first time — before
 * #4187 the Python tool ignored it entirely, a latent posture bug given SaaS
 * pins `["vercel-sandbox"]`.
 */
export async function snapshotPythonSandboxEnv(): Promise<SandboxSelectionEnv> {
  const { isNsjailAvailable } = await import("./backends/nsjail");
  return {
    atlasSandbox: process.env.ATLAS_SANDBOX,
    vercelAvailable: useVercelSandbox(),
    sidecarAvailable: useSidecar(),
    nsjailAvailable: isNsjailAvailable(),
    nsjailFailed: false,
    configPriority: getConfig()?.sandbox?.priority,
  };
}

/**
 * Resolve the Python execution backend through the shared selection policy
 * ({@link planSandboxSelection} + {@link runSandboxPlan}) so explore and Python
 * agree on the chosen backend and both honor `sandbox.priority` /
 * `ATLAS_SANDBOX_PRIORITY`. The default chain is Vercel > nsjail-explicit >
 * sidecar > nsjail-auto (there is no `just-bash` step — Python refuses to run
 * without process isolation).
 *
 * `resolveVercelOptions` is called ONLY if/when the Vercel step is actually
 * reached; it lazily resolves the per-request REST datasource and bounds the
 * sandbox egress to that host (#2927 layer 0). Absent datasource → deny-all.
 * The sidecar and nsjail backends ignore it — the sidecar's network is open and
 * nsjail has no network. NB: egress-open only; no credential is injected, so the
 * authenticated read path stays the host-side `executeRestOperation` tool.
 */
async function getPythonBackend(
  resolveVercelOptions: () => Promise<PythonSandboxOptions>,
): Promise<PythonBackend | { error: string }> {
  const { findNsjailBinary } = await import("./backends/nsjail");
  const plan = planSandboxSelection(await snapshotPythonSandboxEnv());
  if (plan.source === "config-priority") {
    log.info(
      { priority: plan.configPriority },
      "Using configured sandbox priority for Python: %s",
      plan.configPriority.join(" > "),
    );
  }

  const outcome = await runSandboxPlan<PythonBackend>(
    plan,
    async (step) => {
    switch (step.kind) {
      case "sidecar": {
        // Read into a null-checked local (no non-null assertion). The default
        // chain only reaches this step when ATLAS_SANDBOX_URL is set, but a
        // config pin can list "sidecar" with the URL unset — guard for it.
        const sidecarUrl = process.env.ATLAS_SANDBOX_URL;
        if (!sidecarUrl) {
          return { failure: { name: step.kind, reason: "not configured (set ATLAS_SANDBOX_URL)" } };
        }
        const { executePythonViaSidecar, executePythonViaSidecarStream } = await import(
          "./python-sidecar"
        );
        return {
          backend: {
            exec: (code, data) => executePythonViaSidecar(sidecarUrl, code, data),
            execStream: (code, data, onProgress) =>
              executePythonViaSidecarStream(sidecarUrl, code, data, onProgress),
          },
        };
      }

      case "vercel-sandbox": {
        if (!useVercelSandbox()) {
          return {
            failure: {
              name: step.kind,
              reason: "not configured (set ATLAS_RUNTIME=vercel, VERCEL=1, or VERCEL_* credentials)",
            },
          };
        }
        let createPythonSandboxBackend;
        try {
          ({ createPythonSandboxBackend } = await import("./python-sandbox"));
        } catch (err) {
          // Scrub via errorMessage (matches explore's tryCreateBackend) so an
          // operator-facing reason can never carry a connection string.
          const detail = errorMessage(err);
          log.error({ err: detail }, "Vercel Python sandbox module not available");
          return { failure: { name: step.kind, reason: `runtime unavailable: ${detail}` } };
        }
        // Bound egress to the datasource host (#2927 layer 0). Resolved lazily,
        // only now that the Vercel step is actually selected.
        return { backend: createPythonSandboxBackend(await resolveVercelOptions()) };
      }

      case "nsjail": {
        const nsjailPath = findNsjailBinary();
        if (!nsjailPath) {
          return { failure: { name: step.kind, reason: "nsjail binary not found" } };
        }
        const { createPythonNsjailBackend } = await import("./python-nsjail");
        return { backend: createPythonNsjailBackend(nsjailPath) };
      }

      case "just-bash":
        // Python has no unsandboxed mode; refuse rather than run without
        // isolation. A default-chain exhaustion surfaces as the "requires a
        // sandbox" error below; a config pin to just-bash fails the same way.
        return {
          failure: {
            name: step.kind,
            reason: "Python requires process isolation; the just-bash fallback cannot execute Python",
          },
        };

      default:
        return assertNever(step.kind);
    }
    },
    (step, reason) =>
      log.warn(
        { backend: step.kind, reason },
        "Python sandbox step threw during construction — treated as soft failure",
      ),
  );

  switch (outcome.kind) {
    case "backend":
      log.debug({ backend: outcome.selected, source: plan.source }, "Python backend selected");
      return outcome.backend;

    case "hard-fail":
      // Explicit nsjail (ATLAS_SANDBOX=nsjail) could not be initialized.
      return {
        error:
          `ATLAS_SANDBOX=nsjail but the nsjail Python backend could not be initialized: ${outcome.reason}. ` +
          "Python execution unavailable.",
      };

    case "fail-closed":
      // Config-priority pin with no fallback (the SaaS deny-all posture).
      // `fail-closed` only arises from the config-priority arm, which carries the pin.
      return {
        error: formatSandboxPriorityFailure(
          plan.source === "config-priority" ? plan.configPriority : [],
          outcome.failures,
          getConfig()?.deployMode,
        ),
      };

    case "exhausted": {
      // No isolation backend was available. Surface any attempted-backend
      // reasons (e.g. a Vercel/nsjail that was tried and failed) so the operator
      // can tell a missing binary from a crashing runtime — but keep the base
      // message (and its ATLAS_SANDBOX_URL hint) intact for empty-attempt cases.
      const attempted =
        outcome.failures.length > 0
          ? ` Attempted: ${outcome.failures.map((f) => `${f.name}: ${f.reason}`).join("; ")}.`
          : "";
      return {
        error:
          "Python execution requires a sandbox (ATLAS_SANDBOX_URL or nsjail). See deployment docs." +
          attempted,
      };
    }

    default:
      return assertNever(outcome);
  }
}

// --- Tool definition ---

/**
 * Dependencies for {@link createExecutePythonTool}. `resolveRestDatasource` is
 * a test seam (mirrors `executeRestOperation`'s `resolveDatasource`) — it lets
 * a security test prove the sandbox egress allowlist tracks the per-request
 * datasource, never the agent's `code`, and that tenant A's resolver cannot
 * widen tenant B's policy.
 */
export interface ExecutePythonDeps {
  readonly resolveRestDatasource?: () => Promise<RestDatasource | null>;
}

/**
 * Default resolver: the workspace's primary REST datasource (slice 2, #2926),
 * resolved from the ambient request context's org id — retires the slice-1
 * env-configured Twenty shortcut. Lazily imported so the SQL-only Python path
 * doesn't pull the OpenAPI layer into its load graph. The per-tenant network
 * allowlist follows automatically, since it is computed from whatever this
 * returns; resolving by the request's workspace keeps tenant A's egress from
 * ever seeing tenant B's datasource host.
 *
 * "Primary" = the earliest-installed datasource. A workspace with several REST
 * datasources gets the host-side `executeRestOperation` tool for all of them;
 * the in-sandbox Python egress is bounded to the primary for now (multi-host
 * sandbox egress is a follow-up — the read path the slice ACs exercise is the
 * host-side tool).
 */
export async function defaultResolveRestDatasource(): Promise<RestDatasource | null> {
  const reqCtx = getRequestContext();
  const orgId = reqCtx?.user?.activeOrganizationId;
  if (!orgId) return null;
  const { resolveWorkspacePrimaryRestDatasource } = await import(
    "@atlas/api/lib/openapi/workspace-datasource"
  );
  // #3067 — keep the sandbox egress allowlist in lockstep with a REST-only
  // focused conversation: the only reachable host is the focus target. Resolve
  // ONLY it and RETURN — including a `null` (focus uninstalled or transiently
  // unavailable), which DENIES egress for the turn. An egress allowlist must
  // fail CLOSED: falling through to the default scope here would silently widen
  // the sandbox's reachable hosts on a conversation the user narrowed to one
  // datasource (the wrong failure direction for a security guard). The agent
  // loop makes its own SQL/REST decision; Python egress stays focus-only.
  const focus = reqCtx?.restFocusDatasourceId;
  if (focus) {
    return resolveWorkspacePrimaryRestDatasource(orgId, { focus });
  }
  // #3044 — keep the sandbox egress allowlist in lockstep with the agent's
  // in-scope datasources: a datasource scoped to a different environment group
  // must not be reachable from Python either. Resolve the active environment the
  // same way the agent loop does — the explicit `connectionGroupId`, else the
  // group inferred from the pinned connection's membership — so an
  // environment-local REST API stays reachable for legacy connectionId-only
  // callers. `null` (no environment context) admits only workspace-global ones.
  let activeGroupId = reqCtx?.connectionGroupId ?? null;
  if (activeGroupId === null && reqCtx?.connectionId) {
    const { loadGroupRoutingContext } = await import("@atlas/api/lib/env-routing/lookup");
    const ctx = await loadGroupRoutingContext(orgId, reqCtx.connectionId);
    activeGroupId = ctx.groupId ?? null;
  }
  // #3066 — keep the sandbox egress allowlist in lockstep with the conversation's
  // REST exclude-set too: a datasource the conversation excluded must not be
  // reachable from Python either, or the agent could probe an excluded host's
  // network egress via `executePython`. Omitted ⇒ exclude nothing.
  // Treat an empty set as "exclude nothing" (omit the key), matching the chat
  // route's ALS stamping and `agent.ts` — `[]` is truthy in JS, so guard on
  // length, not truthiness, to keep all three threading sites consistent.
  const excluded = reqCtx?.restExcludedDatasourceIds;
  return resolveWorkspacePrimaryRestDatasource(orgId, {
    activeGroupId,
    ...(excluded && excluded.length > 0 ? { excluded } : {}),
  });
}

/**
 * Build the `executePython` tool. Exported as a factory (matching
 * `createExecuteRestOperationTool`) so tests can inject a per-tenant
 * {@link ExecutePythonDeps.resolveRestDatasource}; production uses the default
 * singleton {@link executePython}.
 */
export function createExecutePythonTool(deps: ExecutePythonDeps = {}) {
  const resolveRestDatasource =
    deps.resolveRestDatasource ?? defaultResolveRestDatasource;

  return tool({
    description: `Execute Python code for data analysis and visualization.

The code runs in an isolated Python sandbox with access to common data science libraries (pandas, numpy, matplotlib, scipy, scikit-learn, statsmodels).

When data is provided (from a previous SQL query), it is available as:
- \`df\`: a pandas DataFrame (if pandas is installed)
- \`data\`: the raw dict with "columns" and "rows" keys

Output options:
- Table: set \`_atlas_table = {"columns": [...], "rows": [...]}\`
- Interactive chart (Recharts): set \`_atlas_chart = {"type": "line", "data": [...], "categoryKey": "month", "valueKeys": ["revenue"]}\` (type can be line, bar, pie)
- PNG chart (matplotlib): save to \`chart_path(0)\`, \`chart_path(1)\`, etc.
- Text: use \`print()\` for narrative output

Blocked: subprocess, os, socket, shutil, sys, ctypes, importlib, exec(), eval(), open(), compile().`,

    inputSchema: z.object({
      code: z.string().describe("Python code to execute"),
      explanation: z.string().describe("Brief explanation of what this code does and why"),
      data: z
        .object({
          columns: z.array(z.string()),
          rows: z.array(z.array(z.unknown())),
        })
        .optional()
        .describe("Optional data payload from a previous SQL query (columns + rows)"),
    }),

    execute: async ({ code, explanation, data }, options) => {
      // 0a. BYOC workspace override (#3410): when the request's org selected
      // a BYOC provider that can run Python (currently vercel only — see
      // PYTHON_CAPABLE_PROVIDERS in sandbox/runtime.ts), build the backend
      // from the org's stored credentials, with the same engagement and
      // fail-closed semantics as the explore tool (#3370). Not engaged
      // (no/incomplete credentials, runtime not installed, provider without
      // Python support) falls through to the operator chain in 0b; engaged
      // failures surface as tool errors and never silently run the org's
      // workload on the operator's account.
      let resolvedBackend: PythonBackend | { error: string } | null = null;
      let restDatasource: RestDatasource | null = null;
      let restDatasourceResolved = false;

      const resolveRestDatasourceFailSoft = async () => {
        // Fail-soft: a resolve error leaves the sandbox at deny-all, never
        // breaks the tool call. NB: the allowlist derives from this resolved
        // datasource, NOT from `code` — the agent cannot widen it.
        try {
          restDatasource = await resolveRestDatasource();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "REST datasource resolve failed for Python sandbox — egress stays deny-all this turn",
          );
        }
        restDatasourceResolved = true;
      };

      const orgId = getRequestContext()?.user?.activeOrganizationId;
      const wsOverride = getWorkspaceSandboxOverride(orgId);
      if (orgId && wsOverride) {
        const { sandboxProviderForBackendId, providerSupportsPython, tryCreateByocPythonBackend } =
          await import("@atlas/api/lib/sandbox/runtime");
        const provider = sandboxProviderForBackendId(wsOverride);
        if (provider && providerSupportsPython(provider)) {
          try {
            // The options thunk runs only once BYOC is engaged, so a
            // selected-but-unusable override (e.g. incomplete credentials)
            // costs no datasource resolve. When it runs, the org's sandbox
            // gets the same per-request egress bound as the platform one
            // (#2927 layer 0).
            resolvedBackend = await tryCreateByocPythonBackend(orgId, wsOverride, async () => {
              await resolveRestDatasourceFailSoft();
              return vercelSandboxOptionsFor(restDatasource);
            });
          } catch (err) {
            // Engaged but unusable (runtime load failure / construction
            // error): fail closed — surface the error, never run the org's
            // Python on the operator chain. The message from the BYOC
            // runtime is already credential-scrubbed and generic.
            const detail = err instanceof Error ? err.message : String(err);
            log.error(
              { err: detail, orgId, backend: wsOverride },
              "BYOC Python backend failed — failing closed",
            );
            return { success: false, error: detail };
          }
        }
      }

      // 0b. Operator chain (BYOC not engaged). The REST datasource is resolved
      // lazily — only if the shared selector actually reaches the Vercel step
      // (the sidecar / nsjail backends have no network policy to narrow). This
      // replaces the old `useVercelSandbox() && !useSidecar()` heuristic with
      // the real selection decision, so the egress resolve tracks the backend
      // that is truly chosen (e.g. it is skipped when a config pin routes away
      // from Vercel).
      if (!resolvedBackend) {
        resolvedBackend = await getPythonBackend(async () => {
          if (!restDatasourceResolved) await resolveRestDatasourceFailSoft();
          return vercelSandboxOptionsFor(restDatasource);
        });
      }
      if ("error" in resolvedBackend) {
        log.error(resolvedBackend.error);
        return { success: false, error: resolvedBackend.error };
      }
      const backend: PythonBackend = resolvedBackend;

      // 1. Validate imports (defense-in-depth — sandbox is the real boundary)
      const validation = await validatePythonCode(code);
      if (!validation.safe) {
        log.warn({ reason: validation.reason }, "Python code rejected by import guard");
        return { success: false, error: validation.reason };
      }

      // 2. Build streaming progress callback if stream writer is available
      const writer = getStreamWriter();
      const toolCallId = options?.toolCallId;
      const canStream = writer && toolCallId && typeof backend.execStream === "function";

      const onProgress = canStream
        ? (event: PythonProgressEvent) => {
            try {
              // Custom data part — the AI SDK's typed data parts require compile-time
              // registration via UIMessage generics. We bypass with a cast because Atlas
              // uses dynamic data parts consumed via onData on the client.
              writer.write({
                type: "data-python-progress" as const,
                id: toolCallId,
                data: event,
              } as unknown as Parameters<typeof writer.write>[0]);
            } catch (err) {
              log.debug(
                { err: err instanceof Error ? err.message : String(err), toolCallId },
                "Stream writer closed, Python progress events will not be delivered",
              );
            }
          }
        : undefined;

      // 3. Execute via selected backend
      const start = performance.now();
      try {
        const result = await withSpan(
          "atlas.python.execute",
          { "code.length": code.length, streaming: !!onProgress },
          () =>
            onProgress && backend.execStream
              ? backend.execStream(code, data, onProgress)
              : backend.exec(code, data),
        );
        const durationMs = Math.round(performance.now() - start);

        log.debug(
          { durationMs, success: result.success, hasCharts: result.success && !!result.charts?.length, streaming: !!onProgress },
          "python execution",
        );

        return {
          ...result,
          explanation,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.error({ err: detail }, "Python execution failed");
        return { success: false, error: detail };
      }
    },
  });
}

/** Production tool instance, registered into the agent toolkit. */
export const executePython = createExecutePythonTool();
