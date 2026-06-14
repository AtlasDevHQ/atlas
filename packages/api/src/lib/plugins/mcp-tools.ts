/**
 * Plugin MCP tool registry — collects MCP tools contributed by plugins
 * via `AtlasPluginBase.mcpTools()` so the MCP server can expose them in
 * `tools/list` alongside Atlas's own (`executeSQL`, `explore`, the typed
 * semantic tools).
 *
 * Architecture (#2078): plugins return `AtlasMcpTool[]` from `mcpTools()`.
 * Each tool's local `name` is namespaced as `<plugin-id>.<name>` to avoid
 * collisions with native tools. The registry validates name shape and
 * rejects duplicate qualified names. Atlas's own tools register first
 * via `packages/mcp/src/tools.ts`; plugin tools register on top via
 * `packages/mcp/src/plugin-tools.ts`.
 *
 * The structural mirror types here intentionally avoid a runtime
 * dependency on `@useatlas/plugin-sdk` (mirrors how `lib/plugins/registry.ts`
 * defines `PluginLike` locally). The plugin SDK's `AtlasMcpTool` /
 * `McpToolContext` are the canonical authoring contract; this file is
 * the host-side projection.
 */

import { createLogger, getRequestContext, withRequestContext } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { enforceClientRateLimit } from "@atlas/api/lib/rate-limit/middleware";
import {
  type McpToolAnnotationsShape,
  type McpDispatchGateContext,
  type McpDispatchGateRequirements,
  mcpToolMutates,
  writeScopeDenied,
} from "@atlas/api/lib/mcp/dispatch-gate-contract";
import type { PluginRegistry, PluginLike } from "./registry";

// Re-export the shared gate primitives so existing importers (and the
// `plugin-mcp-tools.test.ts` unit tests) reach them from this module. The
// CANONICAL definitions live in `@atlas/api/lib/mcp/dispatch-gate-contract`
// (#3599) — `packages/mcp` imports the SAME `McpDispatchGate*` shapes, so the
// plugin path no longer hand-maintains a structural mirror of them.
export { mcpToolMutates };
export type { McpToolAnnotationsShape };

const log = createLogger("plugins:mcp-tools");

// ---------------------------------------------------------------------------
// Structural type mirrors (no runtime dep on @useatlas/plugin-sdk)
// ---------------------------------------------------------------------------

/**
 * Structural mirror of `PluginZodSchema` from the SDK. Either a real Zod
 * schema or anything exposing `safeParse` will satisfy this; the registry
 * only calls `safeParse` to bridge to the AI SDK's tool-input validation.
 */
export interface ZodSchemaLike {
  parse(input: unknown): unknown;
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<PropertyKey>;
            message: string;
          }>;
          message: string;
        };
      };
  /**
   * Zod's internal definition. Required so a `{ parse, safeParse }`
   * impostor cannot pass `register()` and break the MCP SDK's JSON-
   * Schema derivation downstream. See `PluginZodSchema._def` in the SDK.
   */
  readonly _def: unknown;
}

export interface McpToolAuditEntry {
  readonly event: string;
  readonly success: boolean;
  readonly durationMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface McpToolContextShape {
  readonly workspaceId: string;
  readonly userId: string;
  readonly clientId?: string;
  readonly requestId: string;
  readonly pluginId: string;
  /**
   * #2345 — group-aware routing. See {@link McpToolContext} in the
   * public plugin-sdk for the contract. The internal shape mirrors the
   * public one verbatim; keeping the fields optional preserves the
   * existing plugin contract (plugins authored before #2345 keep
   * compiling and continue to receive a context without these fields
   * when the dispatch is not chat-routed).
   */
  readonly connectionId?: string;
  readonly connectionGroupId?: string;
  readonly logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    info(msg: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    warn(msg: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    error(msg: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
    debug(msg: string): void;
  };
  audit(entry: McpToolAuditEntry): void;
}

// `McpToolAnnotationsShape` + the `mcpToolMutates` predicate (the single
// "does this tool mutate?" notion, #3599) are imported from the shared
// dispatch-gate contract above and re-exported. The native datasource tools
// and these plugin tools now resolve the gate's `requiresWrite` through the
// SAME predicate, so there is exactly one mutation rule across both paths.

export interface AtlasMcpToolLike<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly errorCodes?: ReadonlyArray<string>;
  readonly inputSchema: ZodSchemaLike;
  readonly outputSchema?: ZodSchemaLike;
  /**
   * MCP tool annotations (#3520 keys on `readOnlyHint`/`destructiveHint` for
   * the `mcp:write` gate). Optional — absence means "read-only" for gating.
   */
  readonly annotations?: McpToolAnnotationsShape;
  /**
   * ADR-0016 governance declarations (#3571). Optional and backward-compatible.
   * See `AtlasMcpTool` in `@useatlas/plugin-sdk` for full documentation.
   * Safe defaults: actionCategory 'integration', minRole 'member', destructive false.
   */
  readonly actionCategory?: "datasource" | "integration" | "policy";
  readonly minRole?: "member" | "admin" | "owner";
  readonly destructive?: boolean;
  handler(args: TInput, ctx: McpToolContextShape): Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A plugin-contributed MCP tool that has been validated and namespaced.
 * The `qualifiedName` is what shows up in MCP `tools/list` and in
 * `audit_log.tool_name`.
 */
export interface RegisteredPluginMcpTool {
  readonly pluginId: string;
  /** `<plugin-id>.<localName>` — globally unique. */
  readonly qualifiedName: string;
  /** The un-namespaced name as returned by the plugin. */
  readonly localName: string;
  readonly description: string;
  readonly errorCodes?: ReadonlyArray<string>;
  readonly inputSchema: ZodSchemaLike;
  readonly outputSchema?: ZodSchemaLike;
  /** MCP annotations carried from the authored tool — see {@link mcpToolMutates}. */
  readonly annotations?: McpToolAnnotationsShape;
  /** ADR-0016 governance declarations (#3571) carried from the authored tool. */
  readonly actionCategory?: "datasource" | "integration" | "policy";
  readonly minRole?: "member" | "admin" | "owner";
  readonly destructive?: boolean;
  handler(args: unknown, ctx: McpToolContextShape): Promise<unknown>;
}

/**
 * Local-name shape: starts with a letter, then letters / digits /
 * underscore / dash, max 64 chars. Dots are reserved for the
 * `<plugin-id>.<name>` separator and are explicitly disallowed in the
 * local segment so `pluginA.foo.bar` cannot ambiguously match
 * `<pluginA>.<foo.bar>` vs `<pluginA.foo>.<bar>`.
 */
const LOCAL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const PLUGIN_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export class PluginMcpToolRegistry {
  private tools = new Map<string, RegisteredPluginMcpTool>();
  private frozen = false;

  register(pluginId: string, tool: AtlasMcpToolLike): RegisteredPluginMcpTool {
    if (this.frozen) {
      throw new Error("PluginMcpToolRegistry is frozen — cannot register more tools");
    }
    if (!pluginId || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(
        `Invalid plugin id "${pluginId}" — must match ${PLUGIN_ID_PATTERN}`,
      );
    }
    if (!tool || typeof tool !== "object") {
      throw new Error(`Plugin "${pluginId}" returned a non-object MCP tool`);
    }
    if (typeof tool.name !== "string" || !LOCAL_NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Plugin "${pluginId}" tool name "${tool.name}" is invalid — must match ${LOCAL_NAME_PATTERN} (letters, digits, _, -; no dots)`,
      );
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new Error(
        `Plugin "${pluginId}" tool "${tool.name}" is missing a non-empty description`,
      );
    }
    if (
      !tool.inputSchema ||
      typeof (tool.inputSchema as ZodSchemaLike).safeParse !== "function"
    ) {
      throw new Error(
        `Plugin "${pluginId}" tool "${tool.name}" inputSchema must expose safeParse() (Zod-shaped)`,
      );
    }
    if (!("_def" in (tool.inputSchema as object))) {
      // The MCP SDK derives JSON Schema from `_def`. A structural
      // impostor without it would pass `safeParse` but break tools/list.
      throw new Error(
        `Plugin "${pluginId}" tool "${tool.name}" inputSchema must expose _def (Zod-shaped — required for tools/list JSON Schema derivation)`,
      );
    }
    if (typeof tool.handler !== "function") {
      throw new Error(
        `Plugin "${pluginId}" tool "${tool.name}" handler must be a function`,
      );
    }

    const qualifiedName = `${pluginId}.${tool.name}`;
    if (this.tools.has(qualifiedName)) {
      throw new Error(
        `Plugin MCP tool "${qualifiedName}" is already registered — namespace collision`,
      );
    }

    const entry: RegisteredPluginMcpTool = {
      pluginId,
      qualifiedName,
      localName: tool.name,
      description: tool.description,
      errorCodes: tool.errorCodes,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      // #3520 — carry the read/write annotation through so the dispatch
      // wrapper can decide whether a hosted call needs `mcp:write`.
      ...(tool.annotations && { annotations: tool.annotations }),
      // #3571 — carry governance declarations (actionCategory, minRole,
      // destructive) through to the dispatch wrapper. These are optional;
      // the wrapper applies safe defaults for unmarked tools.
      ...(tool.actionCategory !== undefined && { actionCategory: tool.actionCategory }),
      ...(tool.minRole !== undefined && { minRole: tool.minRole }),
      ...(tool.destructive !== undefined && { destructive: tool.destructive }),
      handler: tool.handler as RegisteredPluginMcpTool["handler"],
    };
    this.tools.set(qualifiedName, entry);
    return entry;
  }

  get(qualifiedName: string): RegisteredPluginMcpTool | undefined {
    return this.tools.get(qualifiedName);
  }

  getAll(): RegisteredPluginMcpTool[] {
    return Array.from(this.tools.values());
  }

  freeze(): this {
    this.frozen = true;
    return this;
  }

  get size(): number {
    return this.tools.size;
  }

  /** Reset registry state. For testing only. */
  _reset(): void {
    this.tools.clear();
    this.frozen = false;
  }
}

/**
 * Global registry. Populated at boot by `wireMcpToolPlugins`; consumed by
 * the MCP server via `packages/mcp/src/plugin-tools.ts`.
 */
export const pluginMcpToolRegistry = new PluginMcpToolRegistry();

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface PluginWithMcpTools extends PluginLike {
  mcpTools(): readonly AtlasMcpToolLike[];
}

function hasMcpTools(p: PluginLike): p is PluginWithMcpTools {
  return typeof (p as Record<string, unknown>).mcpTools === "function";
}

export interface WireMcpToolsResult {
  readonly wired: ReadonlyArray<{ pluginId: string; qualifiedName: string }>;
  readonly failed: ReadonlyArray<{ pluginId: string; tool?: string; error: string }>;
}

/**
 * Walk every healthy plugin's `mcpTools()` and register the returned
 * tools in the plugin MCP registry. Atlas's own tools register on the
 * MCP server through `packages/mcp/src/tools.ts` first; this loader runs
 * after, mirroring `wireActionPlugins` ordering.
 *
 * Per-plugin failures (a thrown `mcpTools()` factory, a malformed tool,
 * a namespace collision) are collected in `failed` and logged — they do
 * not abort other plugins. The registry is frozen by the caller after
 * all wire functions return.
 */
export function wireMcpToolPlugins(
  pluginRegistry: PluginRegistry,
  registry: PluginMcpToolRegistry = pluginMcpToolRegistry,
): WireMcpToolsResult {
  const wired: Array<{ pluginId: string; qualifiedName: string }> = [];
  const failed: Array<{ pluginId: string; tool?: string; error: string }> = [];

  for (const plugin of pluginRegistry.getAllHealthy()) {
    if (!hasMcpTools(plugin)) continue;

    let tools: readonly AtlasMcpToolLike[];
    try {
      const result = plugin.mcpTools();
      if (!Array.isArray(result)) {
        const msg = `mcpTools() returned non-array (${typeof result})`;
        failed.push({ pluginId: plugin.id, error: msg });
        log.error({ pluginId: plugin.id }, msg);
        continue;
      }
      tools = result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Plugin mcpTools() factory threw",
      );
      continue;
    }

    for (const tool of tools) {
      try {
        const entry = registry.register(plugin.id, tool);
        wired.push({ pluginId: plugin.id, qualifiedName: entry.qualifiedName });
        log.info(
          { pluginId: plugin.id, qualifiedName: entry.qualifiedName },
          "Plugin MCP tool registered",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const toolName = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
        failed.push({
          pluginId: plugin.id,
          tool: typeof toolName === "string" ? toolName : undefined,
          error: msg,
        });
        log.error(
          {
            pluginId: plugin.id,
            tool: typeof toolName === "string" ? toolName : undefined,
            err: err instanceof Error ? err : new Error(String(err)),
          },
          "Failed to register plugin MCP tool",
        );
      }
    }
  }

  return { wired, failed };
}

// ---------------------------------------------------------------------------
// MCP server registration — transport-agnostic dispatch wrapping
// ---------------------------------------------------------------------------

/** Structural mirror of the bits of `@modelcontextprotocol/sdk`'s `McpServer` that we touch. */
export interface McpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    },
    handler: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
  ): unknown;
}

export interface McpCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * The ADR-0016 gate runner, typed against the SHARED gate contract
 * (`McpDispatchGateContext` / `McpDispatchGateRequirements` from
 * `@atlas/api/lib/mcp/dispatch-gate-contract`, #3599) — no longer a
 * hand-maintained structural mirror. `packages/mcp` still owns the
 * IMPLEMENTATION (`runMcpDispatchGate`) and the MCP-side bridge
 * (`plugin-tools.ts`) injects it here; tests inject a stub. The return type
 * stays the locally-projected {@link McpCallToolResult} so `@atlas/api` takes
 * no runtime dependency on `@modelcontextprotocol/sdk`.
 */
export type PluginDispatchGateRunner = (
  ctx: McpDispatchGateContext,
  reqs: McpDispatchGateRequirements,
) => Promise<McpCallToolResult | null>;

/**
 * Dispatch options for `registerPluginMcpTools`. The host wires `actor`,
 * `transport`, `workspaceId`, `deployMode`, and `clientId` from the same
 * MCP server boot path that powers `tools.ts` / `semantic-tools.ts`. The
 * optional `traceWrap` injects OTel coverage (#2029) — stdio MCP can pass
 * `traceMcpToolCall` from `packages/mcp/src/telemetry.ts`; tests pass
 * passthrough.
 */
export interface RegisterPluginMcpToolsOptions {
  registry: PluginMcpToolRegistry;
  actor: AtlasUser;
  transport: "stdio" | "sse";
  workspaceId: string;
  deployMode: "self-hosted" | "saas";
  clientId?: string;
  /**
   * #3504 — OAuth token scopes, threaded onto the dispatch RequestContext
   * so a write-gated plugin tool can enforce `mcp:write`. Undefined for
   * stdio MCP (exempt).
   */
  scopes?: readonly string[];
  /** OTel wrapper. Default is passthrough. */
  traceWrap?: <T>(
    spanCtx: {
      readonly toolName: string;
      readonly workspaceId: string;
      readonly transport: "stdio" | "sse";
      readonly deployMode: "self-hosted" | "saas";
      readonly attributes?: Readonly<Record<string, string | number | boolean>>;
    },
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** Logger factory for the plugin's `McpToolContext`. */
  loggerFor?: (
    pluginId: string,
    qualifiedName: string,
  ) => McpToolContextShape["logger"];
  /**
   * #3571 — ADR-0016 gate runner (gates 1, 3, 4). Injected by
   * `packages/mcp/src/plugin-tools.ts` which imports `runMcpDispatchGate`
   * from `dispatch-gate.ts`. Tests inject a stub. When undefined (no injector
   * provided), gates 1/3/4 are skipped and the tool proceeds — this preserves
   * backward-compat for callers that only wire gate 2 (mcp:write check above).
   * Production callers (plugin-tools.ts) MUST inject this.
   */
  runDispatchGate?: PluginDispatchGateRunner;
}

/** Append the standard error contract to a plugin tool description. */
function withPluginErrorContract(
  base: string,
  codes: ReadonlyArray<string>,
): string {
  return `${base}

Error contract: failures return an \`{ code, message, hint?, request_id?, retry_after? }\` JSON envelope as the tool result text with \`isError: true\`. Possible codes: ${codes.map((c) => `\`${c}\``).join(", ")}. Branch on \`code\`; never pattern-match \`message\`.`;
}

const DEFAULT_PLUGIN_ERROR_CODES = ["validation_failed", "internal_error"] as const;

function envelope(
  code: string,
  message: string,
  extras?: { hint?: string; request_id?: string; retry_after?: number },
): { code: string; message: string; hint?: string; request_id?: string; retry_after?: number } {
  return {
    code,
    message,
    ...(extras?.hint !== undefined && { hint: extras.hint }),
    ...(extras?.request_id !== undefined && { request_id: extras.request_id }),
    ...(extras?.retry_after !== undefined && { retry_after: extras.retry_after }),
  };
}

function envelopeResult(
  code: string,
  message: string,
  extras?: { hint?: string; request_id?: string; retry_after?: number },
): McpCallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope(code, message, extras)) }],
    isError: true,
  };
}

function dispatchId(): string {
  return `mcp-plugin-${crypto.randomUUID()}`;
}

function defaultLogger(pluginId: string, qualifiedName: string): McpToolContextShape["logger"] {
  const child = createLogger(`plugin:${pluginId}:${qualifiedName}`);
  return child as unknown as McpToolContextShape["logger"];
}

/**
 * Register every plugin MCP tool in `opts.registry` on the given MCP
 * server. The dispatch wrapper, in execution order:
 *
 * 1. Generates a per-call `request_id` (`mcp-plugin-<uuid>`).
 * 2. Wraps everything below in `withRequestContext({ user: actor,
 *    agentOrigin: "mcp", actor: { kind: "mcp", clientId, toolName:
 *    qualifiedName } })` so any nested `executeSQL` audit_log row inherits
 *    the plugin tool's `tool_name`, `client_id`, and `actor_kind`
 *    consistently with native tools, AND so origin-scoped approval rules
 *    (#3507 / ADR-0016) match plugin-tool calls — without the `mcp` origin
 *    stamp, an `origin='mcp'` rule would silently skip them. The wrap is
 *    the OUTERMOST step — every subsequent step runs inside the binding.
 * 3. Per-OAuth-client rate-limit gate (#2071). Hosted MCP threads
 *    `clientId`; stdio MCP leaves it undefined and is exempt.
 *    A denied bucket short-circuits with the limiter's `rate_limited`
 *    envelope; a limiter throw surfaces as `internal_error`.
 * 4. Validates the LLM-supplied arguments against the plugin's
 *    `inputSchema` — a parse failure short-circuits with a
 *    `validation_failed` envelope (handler is never invoked).
 * 5. Applies the optional `traceWrap` (OTel) — stdio/SSE pass
 *    `traceMcpToolCall`; tests pass identity.
 * 6. Builds the `McpToolContext` and invokes the plugin handler inside
 *    the trace wrap.
 * 7. On a handler throw, returns an `internal_error` envelope carrying
 *    `request_id` so an LLM agent can correlate with server logs.
 */
export function registerPluginMcpTools(
  server: McpServerLike,
  opts: RegisterPluginMcpToolsOptions,
): void {
  const {
    registry,
    actor,
    transport,
    workspaceId,
    deployMode,
    clientId,
    scopes,
    traceWrap,
    loggerFor = defaultLogger,
    runDispatchGate,
  } = opts;

  for (const tool of registry.getAll()) {
    const codes = tool.errorCodes ?? DEFAULT_PLUGIN_ERROR_CODES;
    const description = withPluginErrorContract(tool.description, codes);

    const dispatchHandler = async (
      args: Record<string, unknown>,
    ): Promise<McpCallToolResult> => {
      const requestId = dispatchId();
      const mcpActor = {
        kind: "mcp" as const,
        ...(clientId ? { clientId } : {}),
        toolName: tool.qualifiedName,
      };

      return withRequestContext(
        // #3507 — stamp `mcp` as the agent origin so origin-scoped approval
        // rules (ADR-0016) match plugin-tool dispatches, parity with the
        // built-in MCP tools in packages/mcp/src/{tools,semantic-tools}.ts.
        // #3504 — `scopes` is threaded onto the context here; #3520 enforces
        // the `mcp:write` gate (gate 2 of the ADR-0016 order) on it for
        // *mutating* plugin tools, keyed on the MCP `readOnlyHint` /
        // `destructiveHint` annotation (see {@link mcpToolMutates}).
        { requestId, user: actor, agentOrigin: "mcp", actor: mcpActor, ...(scopes ? { scopes } : {}) },
        async () => {
          // ── ADR-0016 gates 1–4 (#3571) ──
          // When a gate runner is injected (production: plugin-tools.ts injects
          // `runMcpDispatchGate`), ALL four gates fire in order:
          //   gate 1 — action-policy kill-switch (actionCategory, defaults 'integration')
          //   gate 2 — mcp:write scope (requiresWrite, derived from annotations)
          //   gate 3 — RBAC minRole (defaults 'member')
          //   gate 4 — approval for destructive actions (defaults false)
          // Runs BEFORE the rate-limit gate so denied calls don't consume quota.
          // When no runner is injected (backward-compat callers / unit tests that
          // don't wire the gate), we fall back to the inline gate-2 check below.
          if (runDispatchGate) {
            const gateBlock = await runDispatchGate(
              {
                actor,
                ...(clientId ? { clientId } : {}),
                ...(scopes ? { scopes } : {}),
                orgId: actor.activeOrganizationId,
                requesterId: actor.id,
                requesterEmail: actor.label,
                requestId,
              },
              {
                toolName: tool.qualifiedName,
                // Safe defaults for unmarked tools: integration category, member
                // role, non-destructive. A tool that doesn't declare stays
                // member-callable + non-destructive but now honors a workspace
                // `integration`-category kill-switch (gate 1) and RBAC (gate 3).
                actionCategory: tool.actionCategory ?? "integration",
                requiresWrite: mcpToolMutates(tool.annotations),
                minRole: tool.minRole ?? "member",
                ...(tool.destructive === true
                  ? {
                      destructive: {
                        resource: `plugin:${tool.qualifiedName}`,
                        description: `Plugin tool ${tool.qualifiedName} (destructive action via MCP)`,
                      },
                    }
                  : {}),
              },
            );
            if (gateBlock) return gateBlock;
          } else {
            // ── fallback: inline gate 2 only (#3520, backward-compat) ──
            // Only reached when NO gate runner is injected (unit tests /
            // legacy callers); production wires `runMcpDispatchGate` above, so
            // this is the documented no-runner fallback, NOT a parallel gate
            // implementation. It reuses the SHARED gate-2 primitive
            // (`mcpToolMutates` + `writeScopeDenied`, #3599) so the `mcp:write`
            // decision has one source of truth: a mutating plugin tool on a
            // HOSTED dispatch (clientId set) needs the `mcp:write` scope; stdio
            // (no clientId) is exempt. Runs BEFORE the rate-limit gate so a
            // forbidden call doesn't consume the client's rate budget.
            if (mcpToolMutates(tool.annotations) && writeScopeDenied({ clientId, scopes })) {
              log.warn(
                { qualifiedName: tool.qualifiedName, clientId, requestId },
                "Mutating plugin MCP tool denied — token lacks mcp:write",
              );
              return envelopeResult(
                "forbidden",
                "This tool mutates data and requires the 'mcp:write' OAuth scope, which this token does not carry.",
                {
                  hint: "Re-authorize the MCP client with the mcp:write scope (the workspace admin controls which scopes a client may request).",
                },
              );
            }
          }

          // Per-OAuth-client rate-limit gate (#2071). Hosted MCP threads
          // `clientId`; stdio MCP leaves it undefined and is intentionally
          // exempt — the limiter scopes hosted-tenant abuse, not local
          // bench testing. Lives INSIDE the request context so any audit
          // emission picks up the bound actor.
          if (clientId) {
            try {
              const outcome = await enforceClientRateLimit({
                orgId: workspaceId,
                clientId,
                userId: actor.id,
                toolName: tool.qualifiedName,
              });
              if (outcome.kind !== "ok") {
                return {
                  content: [
                    { type: "text" as const, text: JSON.stringify(outcome.envelope) },
                  ],
                  isError: true,
                };
              }
            } catch (err) {
              // Limiter failure is not the plugin's fault — surface as
              // internal_error rather than failing closed silently.
              const message = err instanceof Error ? err.message : String(err);
              log.error(
                {
                  err: err instanceof Error ? err : new Error(String(err)),
                  qualifiedName: tool.qualifiedName,
                },
                "Plugin MCP rate-limit gate threw — wrapping as internal_error",
              );
              return envelopeResult("internal_error", message, {
                request_id: requestId,
              });
            }
          }

          const parse = tool.inputSchema.safeParse(args ?? {});
          if (!parse.success) {
            const issue = parse.error.issues[0];
            const path =
              issue?.path && issue.path.length > 0
                ? issue.path.map((p) => String(p)).join(".")
                : "(root)";
            const message = issue?.message ?? parse.error.message;
            return envelopeResult(
              "validation_failed",
              `Input validation failed at ${path}: ${message}`,
            );
          }

          const trace =
            traceWrap ??
            (async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn());

          const tlogger = loggerFor(tool.pluginId, tool.qualifiedName);
          // #2345 — surface group-aware routing additively. Both fields
          // are read from RequestContext (chat routes stamp them in
          // AsyncLocalStorage before invoking the agent) and only
          // attached when present so the plugin contract for legacy
          // call sites (scheduler, stdio MCP) is byte-identical.
          const routingCtx = getRequestContext();
          const ctx: McpToolContextShape = {
            workspaceId,
            userId: actor.id,
            ...(clientId ? { clientId } : {}),
            requestId,
            pluginId: tool.pluginId,
            ...(routingCtx?.connectionId !== undefined && {
              connectionId: routingCtx.connectionId,
            }),
            ...(routingCtx?.connectionGroupId !== undefined && {
              connectionGroupId: routingCtx.connectionGroupId,
            }),
            logger: tlogger,
            audit(entry) {
              try {
                const logFn =
                  entry.success ? tlogger.info.bind(tlogger) : tlogger.warn.bind(tlogger);
                logFn(
                  {
                    pluginId: tool.pluginId,
                    qualifiedName: tool.qualifiedName,
                    requestId,
                    workspaceId,
                    ...(clientId ? { clientId } : {}),
                    success: entry.success,
                    ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
                    ...(entry.metadata && { metadata: entry.metadata }),
                  },
                  `plugin_audit:${entry.event}`,
                );
              } catch (err) {
                // Audit must never propagate. The plugin's logger threw —
                // fall back to the host module logger (independent of
                // tlogger), wrapped in a final swallow guard so a broken
                // sink at *both* levels still cannot escape audit().
                try {
                  log.warn(
                    {
                      err: err instanceof Error ? err.message : String(err),
                      pluginId: tool.pluginId,
                      qualifiedName: tool.qualifiedName,
                      requestId,
                    },
                    "Plugin audit() write failed via plugin logger — event dropped",
                  );
                } catch {
                  // intentionally ignored: last-resort sink when both
                  // the plugin logger and the host module logger fail.
                }
              }
            },
          };

          try {
            return await trace(
              {
                toolName: tool.qualifiedName,
                workspaceId,
                transport,
                deployMode,
              },
              async () => {
                const result = await tool.handler(parse.data, ctx);
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            tlogger.error(
              {
                pluginId: tool.pluginId,
                qualifiedName: tool.qualifiedName,
                requestId,
                err: err instanceof Error ? err : new Error(String(err)),
              },
              "Plugin MCP tool handler threw — wrapping in internal_error envelope",
            );
            return envelopeResult("internal_error", message || `${tool.qualifiedName} failed`, {
              request_id: requestId,
            });
          }
        },
      );
    };

    server.registerTool(
      tool.qualifiedName,
      {
        title: tool.qualifiedName,
        description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
      },
      dispatchHandler,
    );
  }
}
