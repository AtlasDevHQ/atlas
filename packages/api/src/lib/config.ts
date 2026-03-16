/**
 * Declarative configuration for Atlas.
 *
 * Loads configuration from `atlas.config.ts` in the project root (if present),
 * falling back to environment variables for backward compatibility. The config
 * file is optional and additive — existing env-var-only deploys work without
 * changes.
 *
 * @example
 * ```typescript
 * // atlas.config.ts
 * import { defineConfig } from "@atlas/api/lib/config";
 *
 * export default defineConfig({
 *   datasources: {
 *     default: { url: process.env.ATLAS_DATASOURCE_URL! },
 *     warehouse: { url: "postgresql://...", schema: "analytics", description: "Data warehouse" },
 *   },
 *   tools: ["explore", "executeSQL"],
 *   auth: "auto",
 *   semanticLayer: "./semantic",
 * });
 * ```
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./logger";
import type { ConnectionRegistry } from "./db/connection";
import type { ToolRegistry } from "./tools/registry";
import { ACTION_APPROVAL_MODES, type ActionApprovalMode } from "@atlas/api/lib/action-types";
import { ATLAS_ROLES } from "@atlas/api/lib/auth/types";

// ---------------------------------------------------------------------------
// Sandbox backend names (used in config validation and explore backend selection)
// ---------------------------------------------------------------------------

/**
 * Backend names operators can use in `sandbox.priority`.
 * Plugin backends are always tried first and are not included here.
 */
export const SANDBOX_BACKEND_NAMES = ["vercel-sandbox", "nsjail", "sidecar", "just-bash"] as const;
export type SandboxBackendName = (typeof SANDBOX_BACKEND_NAMES)[number];

const log = createLogger("config");

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const RateLimitConfigSchema = z.object({
  /** Max queries per minute for this datasource. */
  queriesPerMinute: z.number().int().positive().default(60),
  /** Max concurrent queries for this datasource. */
  concurrency: z.number().int().positive().default(5),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

const DatasourceConfigSchema = z.object({
  /** Database connection string (postgresql:// or mysql:// for core; other schemes via plugins). */
  url: z.string().min(1, "Datasource URL must not be empty"),
  /** PostgreSQL schema name (sets search_path). Ignored for MySQL and plugin-managed connections. */
  schema: z.string().optional(),
  /** Human-readable description shown in the agent system prompt. */
  description: z.string().optional(),
  /** Max connections in the pool for this datasource. */
  maxConnections: z.number().int().positive().optional(),
  /** Idle timeout in milliseconds before a connection is closed. */
  idleTimeoutMs: z.number().int().positive().optional(),
  /** Per-source rate limiting configuration. */
  rateLimit: RateLimitConfigSchema.optional(),
});

export type DatasourceConfig = z.infer<typeof DatasourceConfigSchema>;

const AuthConfigSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("api-key"),
  z.literal("managed"),
  z.literal("byot"),
]);

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

const ActionApprovalSchema = z.enum(ACTION_APPROVAL_MODES);

const ActionDefaultsSchema = z.object({
  approval: ActionApprovalSchema.optional(),
  timeout: z.number().int().positive().optional(),
  maxPerConversation: z.number().int().positive().optional(),
});

export type ActionDefaults = z.infer<typeof ActionDefaultsSchema>;

const AtlasRoleSchema = z.enum(ATLAS_ROLES);

const PerActionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  approval: ActionApprovalSchema.optional(),
  /** Minimum role required to approve this action. Overrides the approval mode's default role mapping. */
  requiredRole: AtlasRoleSchema.optional(),
  /** Execution timeout in milliseconds. Overrides the global defaults.timeout. */
  timeout: z.number().int().positive().optional(),
  credentials: z.record(z.string(), z.object({ env: z.string() })).optional(),
  rateLimit: z.number().int().positive().optional(),
}).passthrough();

export type PerActionConfig = z.infer<typeof PerActionConfigSchema>;

const ActionsConfigSchema = z.object({
  defaults: ActionDefaultsSchema.optional(),
}).catchall(PerActionConfigSchema);

export type ActionsConfig = z.infer<typeof ActionsConfigSchema>;

const RLSConditionSchema = z.object({
  /** Column name to filter on. Must be a valid SQL identifier. */
  column: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Must be a valid column name"),
  /** Claim path to extract the filter value from the user's claims. Supports dot-delimited paths. */
  claim: z.string().min(1),
});

export type RLSCondition = z.infer<typeof RLSConditionSchema>;

const RLSPolicySchema = z.object({
  /** Tables this policy applies to. Use ["*"] for all tables. */
  tables: z.array(z.string().min(1)).min(1),
  /** Column name to filter on (single-condition shorthand). */
  column: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Must be a valid column name").optional(),
  /** Claim path (single-condition shorthand). */
  claim: z.string().min(1).optional(),
  /** Multiple column/claim conditions — ANDed together within this policy. */
  conditions: z.array(RLSConditionSchema).min(1).optional(),
}).refine(
  (p) => {
    const hasSingle = p.column !== undefined || p.claim !== undefined;
    const hasConditions = p.conditions !== undefined;
    if (hasSingle && hasConditions) return false;
    if (!hasSingle && !hasConditions) return false;
    if (hasSingle && (p.column === undefined || p.claim === undefined)) return false;
    return true;
  },
  { message: "Each policy must specify either { column, claim } or { conditions: [...] }, not both" },
);

export type RLSPolicy = z.infer<typeof RLSPolicySchema>;

const RLSConfigSchema = z.object({
  /** Whether RLS is active. When true, policies are enforced on every query. */
  enabled: z.boolean().default(false),
  /** RLS policies. Each policy maps a claim to a column on one or more tables. */
  policies: z.array(RLSPolicySchema).default([]),
  /** How to combine conditions from different policies. "and" (default) requires all policies to match. "or" requires at least one policy to match. */
  combineWith: z.enum(["and", "or"]).default("and"),
}).refine(
  (cfg) => !cfg.enabled || cfg.policies.length > 0,
  { message: "RLS is enabled but no policies are defined", path: ["policies"] },
);

export type RLSConfig = z.infer<typeof RLSConfigSchema>;

const SandboxConfigSchema = z.object({
  /**
   * Ordered list of explore backends to try. The first available backend is
   * used. Plugin backends are always tried first (not listed here).
   *
   * Valid values: "vercel-sandbox", "nsjail", "sidecar", "just-bash".
   *
   * @example ["sidecar", "nsjail", "just-bash"]
   */
  priority: z.array(z.enum(SANDBOX_BACKEND_NAMES)).min(1)
    .refine(
      (arr) => new Set(arr).size === arr.length,
      { message: "sandbox.priority must not contain duplicate backend names" },
    )
    .optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/** Modules that can never be unblocked via `allowModules`. */
const PYTHON_CRITICAL_MODULES = ["os", "subprocess", "sys", "shutil"];

const PythonConfigSchema = z.object({
  /** Additional modules to block (added to the default blocked list). */
  blockedModules: z.array(z.string().min(1, "Module name must not be empty")).default([]),
  /** Modules to remove from the default blocked list. Critical modules (os, subprocess, sys, shutil) cannot be unblocked. */
  allowModules: z.array(z.string().min(1, "Module name must not be empty")).default([]),
}).refine(
  (cfg) => !cfg.allowModules.some((m: string) => PYTHON_CRITICAL_MODULES.includes(m)),
  {
    message: `Cannot unblock critical Python modules (${PYTHON_CRITICAL_MODULES.join(", ")}). These are blocked regardless of configuration.`,
    path: ["allowModules"],
  },
);

export type PythonConfig = z.infer<typeof PythonConfigSchema>;

const AtlasConfigSchema = z.object({
  /**
   * Named datasource connections. The "default" key is used when no
   * connectionId is specified. At least one datasource should be defined.
   */
  datasources: z.record(z.string(), DatasourceConfigSchema).optional(),

  /**
   * Tool names to enable. When omitted, defaults to the two core tools
   * (explore, executeSQL).
   */
  tools: z.array(z.string()).optional(),

  /**
   * Auth mode. "auto" (default) auto-detects from env vars — same as the
   * current behavior. Other values pin the mode explicitly.
   */
  auth: AuthConfigSchema.optional().default("auto"),

  /**
   * Path to the semantic layer directory, relative to the project root.
   * Defaults to "./semantic".
   */
  semanticLayer: z.string().optional().default("./semantic"),

  /**
   * Action framework configuration. Per-action overrides use the action
   * type as the key (e.g. `"slack:send"`). The special `defaults` key
   * sets fallback values for all actions.
   */
  actions: ActionsConfigSchema.optional(),

  /**
   * Maximum total pool slots across all datasource pools.
   * When a new datasource registration would exceed this limit,
   * the least-recently-used datasource is evicted.
   */
  maxTotalConnections: z.number().int().positive().default(100),

  /**
   * Plugin instances to register at boot. Each element should satisfy
   * the `AtlasPlugin` interface from `@useatlas/plugin-sdk`.
   *
   * Zod validates structural shape (id, type, version) at config load
   * time. Plugin-level configSchema validation happens at factory call
   * time via `createPlugin()`.
   */
  plugins: z.array(z.unknown()).optional(),

  /**
   * Scheduler configuration for recurring scheduled tasks.
   * Requires ATLAS_SCHEDULER_ENABLED=true to activate.
   */
  scheduler: z.object({
    /** Execution backend: "bun" runs an in-process tick loop, "webhook" relies on external cron hitting POST /:id/run, "vercel" uses Vercel Cron hitting POST /tick. */
    backend: z.enum(["bun", "webhook", "vercel"]).default("bun"),
    /** Maximum concurrent task executions per tick. */
    maxConcurrentTasks: z.number().int().positive().default(5),
    /** Per-task execution timeout in milliseconds. */
    taskTimeout: z.number().int().positive().default(60_000),
    /** Tick interval in seconds (how often the scheduler checks for due tasks). */
    tickIntervalSeconds: z.number().int().positive().default(60),
  }).optional(),

  /**
   * Row-Level Security configuration. When enabled, every SQL query gets
   * automatic WHERE clause injection based on the authenticated user's claims.
   */
  rls: RLSConfigSchema.optional(),

  /**
   * Sandbox / explore backend configuration. Override the default backend
   * selection priority for the explore tool.
   */
  sandbox: SandboxConfigSchema.optional(),

  /**
   * Python tool import guard configuration. Customize which modules are
   * blocked or allowed in the defense-in-depth import checker.
   */
  python: PythonConfigSchema.optional(),

  /**
   * Session timeout configuration. Idle timeout invalidates sessions that
   * haven't been used within the specified duration. Absolute timeout
   * invalidates sessions after a fixed duration regardless of activity.
   * Values are in seconds. 0 means disabled.
   */
  session: z.object({
    /** Seconds of inactivity before a session is invalidated. 0 = disabled. */
    idleTimeout: z.number().int().nonnegative().default(0),
    /** Maximum session lifetime in seconds from creation. 0 = disabled. */
    absoluteTimeout: z.number().int().nonnegative().default(0),
  }).optional(),
});

/** The output type after Zod parsing (defaults applied, all fields present). */
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

/** The input type for user-authored config (optional fields allowed). */
export type AtlasConfigInput = z.input<typeof AtlasConfigSchema>;

/** Expose schemas and formatter for external validation (e.g. tests, CLI). */
export { AtlasConfigSchema, RateLimitConfigSchema, RLSConditionSchema, RLSPolicySchema, RLSConfigSchema, SandboxConfigSchema, PythonConfigSchema };

/**
 * The resolved config after merging the config file with env var defaults.
 * Guaranteed to have all fields populated.
 */
export interface ResolvedConfig {
  datasources: Record<string, DatasourceConfig>;
  tools: string[];
  auth: AuthConfig;
  semanticLayer: string;
  /** Action framework configuration (optional, only when actions are enabled). */
  actions?: ActionsConfig;
  /** Maximum total pool slots across all datasource pools. */
  maxTotalConnections: number;
  /** Plugin instances to register at boot. */
  plugins?: unknown[];
  /** Scheduler configuration (only when ATLAS_SCHEDULER_ENABLED=true). */
  scheduler?: {
    backend: "bun" | "webhook" | "vercel";
    maxConcurrentTasks: number;
    taskTimeout: number;
    tickIntervalSeconds: number;
  };
  /** Row-Level Security configuration. */
  rls?: RLSConfig;
  /** Sandbox / explore backend configuration. */
  sandbox?: SandboxConfig;
  /** Python tool import guard overrides. */
  python?: PythonConfig;
  /** Session timeout configuration. */
  session?: { idleTimeout: number; absoluteTimeout: number };
  /** Whether the config was loaded from a file or synthesized from env vars. */
  source: "file" | "env";
}

// ---------------------------------------------------------------------------
// defineConfig() — type-safe authoring helper
// ---------------------------------------------------------------------------

/**
 * Type-safe helper for authoring `atlas.config.ts`. Validates the config
 * at build time via TypeScript and at runtime via Zod.
 *
 * Accepts the input shape (optional fields allowed). Zod applies defaults
 * during `loadConfig()`.
 */
export function defineConfig(config: AtlasConfigInput): AtlasConfigInput {
  return config;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Resolved config singleton — populated by {@link loadConfig}.
 * Starts as null; after `loadConfig()` runs, this is always set.
 */
let _resolved: ResolvedConfig | null = null;

/**
 * Return the current resolved config, or null if {@link loadConfig} has
 * not been called yet.
 */
export function getConfig(): ResolvedConfig | null {
  return _resolved;
}

/**
 * Build a ResolvedConfig from environment variables alone.
 * This is the fallback path when no `atlas.config.ts` exists.
 */
export function configFromEnv(): ResolvedConfig {
  const datasources: Record<string, DatasourceConfig> = {};

  if (process.env.ATLAS_DATASOURCE_URL) {
    datasources.default = {
      url: process.env.ATLAS_DATASOURCE_URL,
      ...(process.env.ATLAS_SCHEMA ? { schema: process.env.ATLAS_SCHEMA } : {}),
    };
  }

  // Action framework config from env vars
  let actions: ActionsConfig | undefined;
  if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
    const defaults: ActionDefaults = {};
    const approval = process.env.ATLAS_ACTION_APPROVAL;
    if (approval) {
      if ((ACTION_APPROVAL_MODES as readonly string[]).includes(approval)) {
        defaults.approval = approval as ActionApprovalMode;
      } else {
        log.warn({ value: approval, valid: ACTION_APPROVAL_MODES }, "Invalid ATLAS_ACTION_APPROVAL — using default 'manual'");
      }
    }
    const timeout = parseInt(process.env.ATLAS_ACTION_TIMEOUT ?? "", 10);
    if (Number.isFinite(timeout) && timeout > 0) {
      defaults.timeout = timeout;
    }
    const maxPerConv = parseInt(process.env.ATLAS_ACTION_MAX_PER_CONVERSATION ?? "", 10);
    if (Number.isFinite(maxPerConv) && maxPerConv > 0) {
      defaults.maxPerConversation = maxPerConv;
    }
    actions = { defaults };
  }

  // Scheduler config from env vars
  let scheduler: ResolvedConfig["scheduler"];
  if (process.env.ATLAS_SCHEDULER_ENABLED === "true") {
    const rawBackend = process.env.ATLAS_SCHEDULER_BACKEND;
    const backend = rawBackend === "webhook" ? "webhook" as const : rawBackend === "vercel" ? "vercel" as const : "bun" as const;
    const maxConcurrent = parseInt(process.env.ATLAS_SCHEDULER_MAX_CONCURRENT ?? "", 10);
    const timeout = parseInt(process.env.ATLAS_SCHEDULER_TIMEOUT ?? "", 10);
    const tick = parseInt(process.env.ATLAS_SCHEDULER_TICK_INTERVAL ?? "", 10);
    scheduler = {
      backend,
      maxConcurrentTasks: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 5,
      taskTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
      tickIntervalSeconds: Number.isFinite(tick) && tick > 0 ? tick : 60,
    };
  }

  // RLS config from env vars (single-policy shorthand)
  let rls: RLSConfig | undefined;
  if (process.env.ATLAS_RLS_ENABLED === "true") {
    const column = process.env.ATLAS_RLS_COLUMN;
    const claim = process.env.ATLAS_RLS_CLAIM;
    if (!column || !claim) {
      throw new Error(
        `ATLAS_RLS_ENABLED=true requires both ATLAS_RLS_COLUMN and ATLAS_RLS_CLAIM to be set. ` +
        `Got: ATLAS_RLS_COLUMN=${column ?? "(unset)"}, ATLAS_RLS_CLAIM=${claim ?? "(unset)"}`,
      );
    }
    const rlsParseResult = RLSConfigSchema.safeParse({
      enabled: true,
      policies: [{ tables: ["*"], column, claim }],
      combineWith: "and",
    });
    if (!rlsParseResult.success) {
      throw new Error(
        `Invalid RLS environment variable configuration: ${rlsParseResult.error.issues.map((i) => i.message).join("; ")}. ` +
        `Check ATLAS_RLS_COLUMN (must be a valid SQL identifier) and ATLAS_RLS_CLAIM.`,
      );
    }
    rls = rlsParseResult.data;
  }

  // Sandbox priority from env var (comma-separated backend names)
  let sandbox: SandboxConfig | undefined;
  const rawPriority = process.env.ATLAS_SANDBOX_PRIORITY;
  if (rawPriority) {
    const names = rawPriority.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error(
        `ATLAS_SANDBOX_PRIORITY is set but empty after parsing. ` +
        `Expected comma-separated backend names: ${SANDBOX_BACKEND_NAMES.join(", ")}`,
      );
    }
    const parseResult = SandboxConfigSchema.safeParse({ priority: names });
    if (!parseResult.success) {
      throw new Error(
        `Invalid ATLAS_SANDBOX_PRIORITY: ${parseResult.error.issues.map((i) => i.message).join("; ")}. ` +
        `Valid backends: ${SANDBOX_BACKEND_NAMES.join(", ")}`,
      );
    }
    sandbox = parseResult.data;
  }

  return {
    datasources,
    tools: ["explore", "executeSQL"],
    auth: "auto",
    semanticLayer: "./semantic",
    ...(actions ? { actions } : {}),
    maxTotalConnections: 100,
    ...(scheduler ? { scheduler } : {}),
    ...(rls ? { rls } : {}),
    ...(sandbox ? { sandbox } : {}),
    // Session timeout from env vars
    ...((() => {
      const idle = parseInt(process.env.ATLAS_SESSION_IDLE_TIMEOUT ?? "", 10);
      const abs = parseInt(process.env.ATLAS_SESSION_ABSOLUTE_TIMEOUT ?? "", 10);
      const idleTimeout = Number.isFinite(idle) && idle > 0 ? idle : 0;
      const absoluteTimeout = Number.isFinite(abs) && abs > 0 ? abs : 0;
      return (idleTimeout > 0 || absoluteTimeout > 0) ? { session: { idleTimeout, absoluteTimeout } } : {};
    })()),
    source: "env",
  };
}

/**
 * Attempt to find and dynamically import `atlas.config.ts` (or `.js`, `.mjs`)
 * from the project root. Returns null when no config file is found.
 *
 * Uses a cache-busting query parameter on the import path so that the file
 * is always re-evaluated (important when the server restarts with a changed
 * config).
 */
async function tryLoadConfigFile(
  projectRoot: string,
): Promise<AtlasConfig | null> {
  const candidates = [
    "atlas.config.ts",
    "atlas.config.js",
    "atlas.config.mjs",
  ];

  for (const filename of candidates) {
    const filePath = path.resolve(projectRoot, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      log.info({ file: filePath }, "Loading config file");
      // Cache-bust: append timestamp so Bun re-evaluates the module
      const mod = await import(`${filePath}?t=${Date.now()}`);
      if (mod.default === undefined || mod.default === null) {
        throw new Error(
          `Config file "${filename}" does not have a default export. ` +
          `Use \`export default defineConfig({ ... })\` or \`module.exports = { ... }\`.`,
        );
      }
      const raw = mod.default;
      log.debug({ file: filePath }, "Config file loaded successfully");
      return raw;
    } catch (err) {
      // If the file exists but fails to parse/import, that is a hard error
      // that the user needs to fix — do not silently fall back to env vars.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load config file "${filename}": ${detail}`,
        { cause: err },
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

const VALID_PLUGIN_TYPES = new Set(["datasource", "context", "interaction", "action", "sandbox"]);

/**
 * Validate plugin array entries have the required structural shape:
 * `id` (non-empty string), `type` (valid PluginType), `version` (non-empty string).
 *
 * Also detects duplicate plugin IDs.
 *
 * This is the sole structural validation point for plugins in the config
 * pipeline — it must not be removed. Plugin-level configSchema validation
 * is handled by `createPlugin()` at factory call time (typically before
 * this runs, during config file evaluation).
 *
 * @throws {Error} When any plugin entry fails validation.
 */
function validatePlugins(plugins: unknown[]): void {
  const errors: string[] = [];
  const seenIds = new Map<string, number>();

  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];

    if (p === null || p === undefined || typeof p !== "object") {
      errors.push(`plugin at index ${i}: expected a plugin object, got ${p === null ? "null" : typeof p}`);
      continue;
    }

    const obj = p as Record<string, unknown>;

    // Build label upfront: use plugin id if available, otherwise index
    const hasId = "id" in obj && typeof obj.id === "string" && obj.id.trim();
    const label = hasId ? `plugin "${obj.id}" (index ${i})` : `plugin at index ${i}`;

    // id
    if (!("id" in obj) || typeof obj.id !== "string") {
      errors.push(`${label} is missing "id" (string)`);
    } else if (!obj.id.trim()) {
      errors.push(`${label} has an empty "id"`);
    } else {
      // Duplicate id check
      const prevIndex = seenIds.get(obj.id);
      if (prevIndex !== undefined) {
        errors.push(`${label} has duplicate id "${obj.id}" (first seen at index ${prevIndex})`);
      } else {
        seenIds.set(obj.id, i);
      }
    }

    // types
    if (!("types" in obj) || !Array.isArray(obj.types)) {
      errors.push(`${label} is missing "types" (array of plugin types)`);
    } else if (obj.types.length === 0) {
      errors.push(`${label} has an empty "types" array — must contain at least one plugin type`);
    } else {
      for (const t of obj.types) {
        if (typeof t !== "string" || !VALID_PLUGIN_TYPES.has(t)) {
          errors.push(`${label} has invalid type "${t}" in "types" — must be one of: ${[...VALID_PLUGIN_TYPES].join(", ")}`);
        }
      }
    }

    // version
    if (!("version" in obj) || typeof obj.version !== "string") {
      errors.push(`${label} is missing "version" (string)`);
    } else if (!obj.version.trim()) {
      errors.push(`${label} has an empty "version"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid plugin configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Zod error formatting
// ---------------------------------------------------------------------------

/** Loosely-typed Zod issue — works across Zod v3 and v4. */
type Issue = z.ZodError["issues"][number];

/**
 * Human-readable labels for config fields. Used to give context beyond
 * raw Zod type names (e.g. "connection URL" for datasources.*.url).
 */
const FIELD_HINTS: Record<string, string> = {
  "datasources.*.url": "connection URL",
  auth: "auth mode",
  semanticLayer: "path to the semantic layer directory",
  maxTotalConnections: "max total pool connections",
};

/** Map of common misspellings/variants to the correct value. */
const COMMON_SUGGESTIONS: Record<string, Record<string, string>> = {
  auth: {
    "apiKey": "api-key",
    "api_key": "api-key",
    "apikey": "api-key",
    "API-KEY": "api-key",
    "API_KEY": "api-key",
    "basic": "api-key",
    "bearer": "byot",
    "token": "byot",
    "bring-your-own-token": "byot",
    "true": "managed",
    "false": "none",
    "off": "none",
    "on": "auto",
    "default": "auto",
  },
};

/**
 * Look up a human-readable hint for a field path. Supports wildcards:
 * `datasources.mydb.url` matches `datasources.*.url`.
 */
function getFieldHint(fieldPath: string): string | undefined {
  if (FIELD_HINTS[fieldPath]) return FIELD_HINTS[fieldPath];
  // Try wildcard: replace middle segments with *
  const parts = fieldPath.split(".");
  if (parts.length >= 3) {
    const wildcard = `${parts[0]}.*.${parts.slice(2).join(".")}`;
    if (FIELD_HINTS[wildcard]) return FIELD_HINTS[wildcard];
  }
  return undefined;
}

/**
 * Extract the received value from the issue's message (Zod v4 encodes
 * it in the message string rather than a dedicated field).
 */
function extractReceived(issue: Issue): string | undefined {
  // Zod v4 invalid_type message: "Invalid input: expected string, received number"
  const match = issue.message.match(/received (\S+)/);
  if (match) return match[1];
  return undefined;
}

/**
 * Check if the received value for a field has a common suggestion.
 */
function getSuggestion(fieldPath: string, input: unknown): string | undefined {
  const topField = fieldPath.split(".")[0];
  const suggestions = COMMON_SUGGESTIONS[topField];
  if (!suggestions || typeof input !== "string") return undefined;
  const correct = suggestions[input];
  if (correct) return `Did you mean "${correct}"?`;
  return undefined;
}

/**
 * Format a single Zod issue into a human-readable line.
 */
function formatIssue(issue: Issue, rawInput: unknown): string {
  const fieldPath = issue.path.length > 0
    ? issue.path.map(String).join(".")
    : "(root)";
  const hint = getFieldHint(fieldPath);

  // Resolve the value that was actually passed for this path
  let inputAtPath: unknown = rawInput;
  for (const segment of issue.path) {
    if (inputAtPath != null && typeof inputAtPath === "object") {
      inputAtPath = (inputAtPath as Record<string, unknown>)[String(segment)];
    } else {
      inputAtPath = undefined;
      break;
    }
  }

  let line: string;
  // Use unknown-typed accessor to handle Zod v4 issue shapes safely
  const issueObj = issue as unknown as Record<string, unknown>;

  switch (issue.code) {
    case "invalid_type": {
      const expected = String(issueObj.expected ?? "unknown");
      const received = extractReceived(issue) ?? typeof inputAtPath;
      const expectedLabel = hint ? `${expected} (${hint})` : expected;
      line = `Config error at ${fieldPath}: expected ${expectedLabel}, got ${received}`;
      break;
    }
    case "invalid_union": {
      // Zod v4: `errors` is an array of issue arrays
      const unionErrors = issueObj.errors as unknown[][] | undefined;
      const validOptions: string[] = [];
      if (unionErrors) {
        for (const errGroup of unionErrors) {
          const issues = Array.isArray(errGroup) ? errGroup : [];
          for (const sub of issues) {
            const subObj = sub as Record<string, unknown>;
            // Zod v4 uses "invalid_value" with a "values" array
            if (subObj.code === "invalid_value" && Array.isArray(subObj.values)) {
              for (const v of subObj.values) {
                const opt = `"${v}"`;
                if (!validOptions.includes(opt)) validOptions.push(opt);
              }
            }
            // Zod v3 uses "invalid_literal" with "expected"
            if (subObj.code === "invalid_literal" && subObj.expected !== undefined) {
              const opt = `"${subObj.expected}"`;
              if (!validOptions.includes(opt)) validOptions.push(opt);
            }
          }
        }
      }
      if (validOptions.length > 0) {
        line = `Config error at ${fieldPath}: invalid value. Valid options: ${validOptions.join(", ")}`;
      } else {
        line = `Config error at ${fieldPath}: ${issue.message}`;
      }
      break;
    }
    case "invalid_value": {
      // Zod v4 uses "invalid_value" for enums and literals
      const values = issueObj.values as unknown[] | undefined;
      if (values && values.length > 0) {
        line = `Config error at ${fieldPath}: invalid value. Valid options: ${values.map((o) => `"${o}"`).join(", ")}`;
      } else {
        line = `Config error at ${fieldPath}: ${issue.message}`;
      }
      break;
    }
    default: {
      line = `Config error at ${fieldPath}: ${issue.message}`;
    }
  }

  // Append suggestion for common mistakes
  const suggestion = getSuggestion(fieldPath, inputAtPath);
  if (suggestion) {
    line += ` — ${suggestion}`;
  }

  return line;
}

/**
 * Format a ZodError into human-readable, multi-line error messages.
 *
 * Each line shows the field path, expected type, and received value.
 * Common mistakes get targeted suggestions (e.g. "did you mean 'api-key'?").
 * All errors are shown, not just the first one.
 *
 * @param error - The ZodError to format.
 * @param rawInput - The original input that was validated (used to resolve
 *   actual received values and to generate suggestions).
 */
export function formatZodErrors(error: z.ZodError, rawInput?: unknown): string {
  return error.issues.map((issue) => `  - ${formatIssue(issue, rawInput)}`).join("\n");
}

/**
 * Validate a raw config object against the Zod schema and return a
 * ResolvedConfig. Throws on validation failure with human-readable errors.
 */
export function validateAndResolve(raw: unknown): ResolvedConfig {
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(
      `atlas.config.ts must export a plain object. Got ${Array.isArray(raw) ? "array" : typeof raw}.`,
    );
  }

  const parseResult = AtlasConfigSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(`Invalid atlas.config.ts:\n${formatZodErrors(parseResult.error, raw)}`);
  }

  const config = parseResult.data;

  // Structural validation of plugin entries (id, type, version)
  if (config.plugins?.length) {
    validatePlugins(config.plugins);
  }

  return {
    datasources: config.datasources ?? {},
    tools: config.tools ?? ["explore", "executeSQL"],
    auth: config.auth ?? "auto",
    semanticLayer: config.semanticLayer ?? "./semantic",
    ...(config.actions ? { actions: config.actions } : {}),
    maxTotalConnections: config.maxTotalConnections ?? 100,
    ...(config.plugins?.length ? { plugins: config.plugins } : {}),
    ...(config.scheduler ? { scheduler: config.scheduler } : {}),
    ...(config.rls ? { rls: config.rls } : {}),
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
    ...(config.python ? { python: config.python } : {}),
    ...(config.session ? { session: config.session } : {}),
    source: "file",
  };
}

/**
 * Load and validate Atlas configuration.
 *
 * Resolution order:
 * 1. Look for `atlas.config.ts` (or .js/.mjs) in the project root.
 * 2. If found, parse and validate with Zod.
 * 3. If not found, build a config from environment variables.
 *
 * The resolved config is cached as a module-level singleton accessible
 * via {@link getConfig}.
 *
 * @param projectRoot - The directory to search for config files. Defaults
 *   to `process.cwd()`.
 * @throws {Error} When the config file exists but is invalid (Zod errors
 *   are formatted into a human-readable message).
 */
export async function loadConfig(
  projectRoot: string = process.cwd(),
): Promise<ResolvedConfig> {
  const raw = await tryLoadConfigFile(projectRoot);

  if (raw === null) {
    log.info("No atlas.config.ts found — using environment variables");
    const resolved = configFromEnv();
    _resolved = resolved;
    return resolved;
  }

  const resolved = validateAndResolve(raw);

  log.info(
    {
      datasources: Object.keys(resolved.datasources),
      tools: resolved.tools,
      auth: resolved.auth,
      semanticLayer: resolved.semanticLayer,
    },
    "Config loaded from file",
  );

  _resolved = resolved;
  return resolved;
}

// ---------------------------------------------------------------------------
// Wiring helpers — apply config to ConnectionRegistry and ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Register datasources from the resolved config into the ConnectionRegistry.
 * Skips if no datasources are defined (the registry will lazy-init from
 * ATLAS_DATASOURCE_URL on first access, preserving backward compat).
 *
 * @param config - The resolved configuration.
 * @param registry - The ConnectionRegistry to register into. When omitted,
 *   uses the global singleton from `./db/connection`.
 */
export async function applyDatasources(
  config: ResolvedConfig,
  registry?: ConnectionRegistry,
): Promise<void> {
  if (Object.keys(config.datasources).length === 0) {
    log.debug("No datasources in config — ConnectionRegistry will use env var fallback");
    return;
  }

  const connRegistry = registry ?? (await import("./db/connection")).connections;

  connRegistry.setMaxTotalConnections(config.maxTotalConnections);

  for (const [id, ds] of Object.entries(config.datasources)) {
    try {
      log.info({ connectionId: id }, "Registering datasource from config");
      connRegistry.register(id, {
        url: ds.url,
        schema: ds.schema,
        description: ds.description,
        maxConnections: ds.maxConnections,
        idleTimeoutMs: ds.idleTimeoutMs,
      });

      // Fire initial health check — logs on failure but does not block startup.
      // A degraded connection is still usable (the DB may recover).
      connRegistry.healthCheck(id).then((result) => {
        if (result.status !== "healthy") {
          log.warn(
            { connectionId: id, status: result.status, message: result.message },
            "Datasource registered but initial health check failed — connection may be misconfigured",
          );
        }
      }).catch((healthErr) => {
        log.warn(
          { err: healthErr instanceof Error ? healthErr.message : String(healthErr), connectionId: id },
          "Initial health check failed after registration",
        );
      });

      if (ds.rateLimit) {
        const { registerSourceRateLimit } = await import("./db/source-rate-limit");
        registerSourceRateLimit(id, {
          queriesPerMinute: ds.rateLimit.queriesPerMinute,
          concurrency: ds.rateLimit.concurrency,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to register datasource "${id}": ${detail}`,
        { cause: err },
      );
    }
  }
}

/**
 * Validate that the tool names in the config match registered tools in the
 * default registry. Throws if any tool names are unrecognized.
 *
 * @param config - The resolved configuration.
 * @param registry - The ToolRegistry to validate against. When omitted,
 *   uses the default registry from `./tools/registry`.
 * @throws {Error} When config references tool names not in the registry.
 */
export async function validateToolConfig(
  config: ResolvedConfig,
  registry?: ToolRegistry,
): Promise<void> {
  const toolRegistry = registry ?? (await import("./tools/registry")).defaultRegistry;

  const unknownTools: string[] = [];
  for (const toolName of config.tools) {
    if (!toolRegistry.get(toolName)) {
      unknownTools.push(toolName);
    }
  }
  if (unknownTools.length > 0) {
    const available = Object.keys(toolRegistry.getAll());
    throw new Error(
      `Unknown tool(s) in config: ${unknownTools.join(", ")}. ` +
      `Available: ${available.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Startup integration — single entry point for server boot
// ---------------------------------------------------------------------------

/**
 * Load config, wire datasources, and validate tool names.
 * Call this once during server startup (e.g. in server.ts).
 *
 * @param projectRoot - Directory to search for config files.
 * @param opts - Optional dependency injection for registries (used in tests).
 * @throws {Error} When the config file is present but invalid.
 */
export async function initializeConfig(
  projectRoot?: string,
  opts?: {
    connectionRegistry?: ConnectionRegistry;
    toolRegistry?: ToolRegistry;
  },
): Promise<ResolvedConfig> {
  const config = await loadConfig(projectRoot);
  const connRegistry = opts?.connectionRegistry;
  await applyDatasources(config, connRegistry);
  await validateToolConfig(config, opts?.toolRegistry);

  // Start periodic health checks when datasources are registered
  const registry = connRegistry ?? (await import("./db/connection")).connections;
  if (registry.list().length > 0) {
    registry.startHealthChecks();
  }

  return config;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset the cached config. For testing only. */
export function _resetConfig(): void {
  _resolved = null;
}

/** Set the cached config directly. For testing only. */
export function _setConfigForTest(config: ResolvedConfig | null): void {
  _resolved = config;
}
