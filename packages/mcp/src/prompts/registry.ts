/**
 * MCP prompt templates — exposes curated query patterns via the MCP
 * `prompts/list` and `prompts/get` protocol.
 *
 * Four sources, in registration order (matters because the SDK's
 * `prompts/list` is order-preserving and prompt pickers in agent
 * clients render top-down):
 *
 *   1. Built-in templates    — generic analytical patterns
 *                              (revenue, top-N, compare, breakdown,
 *                              anomaly-detection). Always present.
 *   2. Canonical eval prompts — the 20 NovaMart questions from #2025
 *                              (#2076). Workspace-gated — see
 *                              `gating.ts` — and the gate is re-evaluated
 *                              per request so flipping the admin toggle
 *                              takes effect on the next call without a
 *                              process restart. Same-instance writes
 *                              propagate immediately (the in-process
 *                              settings `_cache` updates synchronously
 *                              on `setSetting`); cross-replica SaaS
 *                              propagation is bounded by the periodic
 *                              settings refresh (`ATLAS_SETTINGS_REFRESH_INTERVAL`,
 *                              default 30s).
 *   3. Semantic-layer query patterns — `query_patterns` field from
 *                              entity YAML files. Per-workspace by
 *                              construction (semantic root scoped to
 *                              the workspace).
 *   4. Prompt library         — admin-curated rows from the internal
 *                              DB's `prompt_items` table. Optional
 *                              (skipped when no internal DB).
 *
 * Every dispatch (`list` and `get`) emits:
 *   - An OTel counter increment on `atlas.mcp.prompts.calls` so
 *     operators can see which prompts agents actually pull.
 *   - An `audit_log` row (when an internal DB is available) so
 *     compliance can scope agent activity by prompt name. The DB write
 *     is fire-and-forget — `internalExecute` returns void and routes
 *     async rejections to its internal circuit-breaker error handler
 *     (see `packages/api/src/lib/db/internal.ts:648`), so the prompts
 *     response never blocks on audit latency or fails on audit error.
 *
 * Failures in instrumentation never mask the underlying response.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListPromptsRequestSchema,
  ErrorCode,
  McpError,
  type GetPromptResult,
  type Prompt,
  type PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthMode } from "@useatlas/types/auth";
import { hasInternalDB, internalExecute } from "@atlas/api/lib/db/internal";
import { mcpPromptCalls } from "@atlas/api/lib/metrics";
import {
  loadCanonicalPrompts,
  type CanonicalPrompt,
} from "./canonical.js";
import { shouldExposeCanonicalPrompts } from "./gating.js";
import {
  BUILTIN_TEMPLATES,
  loadSemanticPrompts,
  loadLibraryPrompts,
} from "./listing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptResult(text: string, description?: string): GetPromptResult {
  return {
    description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function substituteArgs(
  template: string,
  args: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => args[key] ?? match);
}

// ---------------------------------------------------------------------------
// Source-tagged descriptor — discriminated union so the canonical-only
// per-call gate is a typed contract rather than a hidden side effect of
// each resolver's closure.
// ---------------------------------------------------------------------------

export type PromptSource = "builtin" | "semantic" | "library" | "canonical";

/**
 * Synthetic source label used by `prompts/list` telemetry — the dispatch
 * spans many sources at once, so we tag the counter / audit row with
 * `(mixed)` rather than picking one. Kept distinct from `PromptSource`
 * so the closed union for per-prompt sources stays clean for `prompts/get`.
 */
export type PromptSourceLabel = PromptSource | "(mixed)";

interface PromptDescriptorBase {
  readonly name: string;
  readonly description?: string;
  /**
   * Argument metadata used to build the `arguments` field on the
   * `prompts/list` response. Kept alongside the registered prompt so we
   * don't need to introspect the SDK's internal Zod schema in the list
   * override.
   */
  readonly args: ReadonlyArray<{ name: string; description: string }>;
}

/**
 * Built-in / semantic / library descriptors — visibility doesn't depend
 * on per-request state, so there's no gate. `resolve` takes the agent's
 * argument map (built-ins substitute; semantic/library ignore it).
 */
type StaticDescriptor = PromptDescriptorBase & {
  readonly source: "builtin" | "semantic" | "library";
  readonly resolve: (args: Record<string, string>) => GetPromptResult;
};

/**
 * Canonical descriptor — workspace-gated. The `gate` field is the
 * single source of truth for visibility: the list handler calls it
 * once per request to decide inclusion, and the dispatch wrapper calls
 * it again before invoking `resolve` so an agent that cached a stale
 * list can't sneak through. Encoding the gate as a typed field (rather
 * than burying it inside `resolve`'s closure) means a future canonical
 * descriptor that forgot the check would fail to type-check rather
 * than silently ship.
 */
type CanonicalDescriptor = PromptDescriptorBase & {
  readonly source: "canonical";
  readonly gate: () => Promise<boolean>;
  readonly resolve: () => GetPromptResult;
};

type PromptDescriptor = StaticDescriptor | CanonicalDescriptor;

// ---------------------------------------------------------------------------
// Audit + OTel
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "sse";
export type McpDeployMode = "self-hosted" | "saas";

interface InstrumentationContext {
  readonly workspaceId: string | undefined;
  readonly clientId: string | undefined;
  readonly transport: McpTransport;
  readonly deployMode: McpDeployMode;
  /**
   * Resolved auth mode of the bound actor — one of the canonical
   * `AuthMode` values (`simple-key` / `managed` / `byot`) or `none` when
   * MCP runs without a bound user. Written to `audit_log.auth_mode`
   * the same way `logQueryAudit` does so a column-level audit
   * dashboard sees a single value-space across surfaces.
   *
   * Note the freshness asymmetry vs. `logQueryAudit`: that function
   * reads `getRequestContext().user.mode` per-call, while this one
   * captures `actor.mode` once at `registerPrompts()` time. Fine for
   * stdio (one actor per process) and for hosted SSE where each session
   * owns its own server instance; if session re-binding is ever
   * introduced, this needs to flip to per-call resolution.
   */
  readonly authMode: AuthMode;
}

/**
 * Increment the prompts dispatch counter. Defensive try/catch so an OTel
 * SDK fault never bubbles into a `prompts/list` failure.
 */
function recordPromptCounter(
  method: "list" | "get",
  name: string,
  source: PromptSourceLabel,
  ctx: InstrumentationContext,
): void {
  try {
    mcpPromptCalls.add(1, {
      method,
      prompt: name,
      source,
      transport: ctx.transport,
      "deploy.mode": ctx.deployMode,
    });
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] prompt counter failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Write an `audit_log` row for a prompts surface call. Fire-and-forget —
 * the inner `internalExecute` already swallows async rejections; we
 * additionally guard against synchronous throws (no internal DB pool,
 * etc.) so the prompts response never hinges on audit success.
 *
 * `sql` is NOT NULL on `audit_log`, so we pack the method + name into
 * a `mcp:` prefixed pseudo-statement. Forensic queries scoped to
 * `actor_kind = 'mcp'` and `tool_name LIKE 'prompts.%'` filter cleanly
 * even if the column-name alignment looks odd at a glance.
 */
function writePromptAudit(
  method: "list" | "get",
  name: string | null,
  source: PromptSourceLabel,
  durationMs: number,
  rowCount: number | null,
  success: boolean,
  ctx: InstrumentationContext,
): void {
  if (!hasInternalDB()) return;
  try {
    const syntheticSql =
      method === "list"
        ? `mcp:prompts.list (source=${source})`
        : `mcp:prompts.get name=${name ?? "?"} (source=${source})`;
    internalExecute(
      `INSERT INTO audit_log (sql, duration_ms, row_count, success, org_id, actor_kind, client_id, tool_name, auth_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        syntheticSql,
        Math.max(0, Math.round(durationMs)),
        rowCount,
        success,
        ctx.workspaceId ?? null,
        "mcp",
        ctx.clientId ?? null,
        `prompts.${method}`,
        ctx.authMode,
      ],
    );
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] prompt audit insert failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterPromptsOptions {
  /** Active workspace id (`actor.activeOrganizationId`). Drives canonical gating. */
  readonly workspaceId?: string;
  /** Hosted-MCP OAuth client_id, threaded into `audit_log.client_id`. */
  readonly clientId?: string;
  /** Carrier transport for OTel attribution. Defaults to `stdio`. */
  readonly transport?: McpTransport;
  /** Resolved deploy mode, read once at registration time. Defaults to `self-hosted`. */
  readonly deployMode?: McpDeployMode;
  /**
   * Auth mode of the bound actor (`actor.mode`). Mirrors the
   * `audit_log.auth_mode` value `logQueryAudit` writes for SQL
   * dispatches so a single dashboard query covers both surfaces.
   * Defaults to `none` when stdio MCP boots without a bound user.
   */
  readonly authMode?: AuthMode;
}

/**
 * Convert a `CanonicalPrompt` into a typed canonical descriptor —
 * captured here (not in `canonical.ts`) so the canonical loader stays
 * free of the MCP SDK types and can be tested as a pure function.
 *
 * The `gate` field is what the dispatch layer calls — both at list
 * time (to decide inclusion) and at get time (to refuse stale-listed
 * canonicals). Both call sites delegate here to keep the visibility
 * policy in one place.
 */
function canonicalDescriptor(
  cp: CanonicalPrompt,
  workspaceId: string | undefined,
): CanonicalDescriptor {
  return {
    name: cp.name,
    description: cp.description,
    source: "canonical",
    args: [],
    gate: () => shouldExposeCanonicalPrompts({ workspaceId }),
    resolve: () => promptResult(cp.question, cp.description),
  };
}

export async function registerPrompts(
  server: McpServer,
  opts: RegisterPromptsOptions = {},
): Promise<void> {
  const ctx: InstrumentationContext = {
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    transport: opts.transport ?? "stdio",
    deployMode: opts.deployMode ?? "self-hosted",
    authMode: opts.authMode ?? "none",
  };

  const descriptors: PromptDescriptor[] = [];

  // 1. Built-in templates (always present)
  for (const tmpl of BUILTIN_TEMPLATES) {
    descriptors.push({
      name: tmpl.name,
      description: tmpl.description,
      source: "builtin",
      args: Object.entries(tmpl.args).map(([name, description]) => ({
        name,
        description,
      })),
      resolve: (args) =>
        promptResult(substituteArgs(tmpl.template, args), tmpl.description),
    });
  }

  // 2. Canonical eval prompts (gated per-request — see canonicalDescriptor)
  for (const cp of loadCanonicalPrompts()) {
    descriptors.push(canonicalDescriptor(cp, ctx.workspaceId));
  }

  // 3. Semantic layer query patterns
  for (const sp of loadSemanticPrompts()) {
    descriptors.push({
      name: sp.name,
      description: sp.description,
      source: "semantic",
      args: [],
      resolve: () => promptResult(sp.text, sp.description),
    });
  }

  // 4. Prompt library
  for (const lp of await loadLibraryPrompts()) {
    descriptors.push({
      name: lp.name,
      description: lp.description,
      source: "library",
      args: [],
      resolve: () => promptResult(lp.question, lp.description),
    });
  }

  // Register every descriptor with the SDK so `prompts/get` routes to
  // our resolver. We wrap the resolver to attach OTel + audit on every
  // dispatch — instrumentation never masks the underlying result.
  for (const d of descriptors) {
    const argsSchema: Record<string, z.ZodString> = {};
    for (const arg of d.args) {
      argsSchema[arg.name] = z.string().describe(arg.description);
    }

    server.registerPrompt(
      d.name,
      Object.keys(argsSchema).length > 0
        ? { description: d.description, argsSchema }
        : { description: d.description },
      async (args: Record<string, string> = {}) => {
        const start = performance.now();
        let success = true;
        try {
          // Canonical descriptors carry a typed `gate` — invoke it at
          // dispatch time so a stale-listed canonical can't be retrieved.
          // Mirrors the SDK's "prompt not found" path (mcp.js:423) so
          // an agent's error handler can't distinguish a closed gate
          // from a name typo.
          if (d.source === "canonical") {
            const allowed = await d.gate();
            if (!allowed) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Prompt ${d.name} not found`,
              );
            }
            return d.resolve();
          }
          return d.resolve(args);
        } catch (err) {
          success = false;
          throw err;
        } finally {
          recordPromptCounter("get", d.name, d.source, ctx);
          writePromptAudit(
            "get",
            d.name,
            d.source,
            performance.now() - start,
            null,
            success,
            ctx,
          );
        }
      },
    );
  }

  // Override the SDK's default `prompts/list` handler so we can
  //   (a) hide canonical prompts when the gate is closed (per request,
  //       so the toggle takes effect on the next call), and
  //   (b) emit an audit row + counter increment for every list call.
  // We re-implement the listing from our local descriptors rather than
  // reading the SDK's internal `_registeredPrompts` — that's stable
  // public-shape behavior and keeps the override resilient against SDK
  // refactors.
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const start = performance.now();
    // Single gate evaluation per list call — every canonical descriptor
    // shares the same workspaceId + toggle, so per-descriptor gating
    // would be wasteful. The first canonical descriptor's `gate` is the
    // canonical (heh) source; if there are zero canonicals registered
    // (e.g. the YAML file is missing), nothing to gate and we skip the
    // probe entirely.
    const firstCanonical = descriptors.find(isCanonicalDescriptor);
    const allowCanonical = firstCanonical
      ? await firstCanonical.gate()
      : false;
    const visible = descriptors.filter(
      (d) => d.source !== "canonical" || allowCanonical,
    );

    const prompts: Prompt[] = visible.map((d) => {
      const out: Prompt = { name: d.name };
      if (d.description !== undefined) out.description = d.description;
      if (d.args.length > 0) {
        out.arguments = d.args.map<PromptArgument>((a) => ({
          name: a.name,
          description: a.description,
          required: true,
        }));
      }
      return out;
    });

    recordPromptCounter("list", "(none)", "(mixed)", ctx);
    writePromptAudit(
      "list",
      null,
      "(mixed)",
      performance.now() - start,
      prompts.length,
      true,
      ctx,
    );

    return { prompts };
  });
}

function isCanonicalDescriptor(
  d: PromptDescriptor,
): d is CanonicalDescriptor {
  return d.source === "canonical";
}
