/**
 * MCP action policy store — the per-workspace kill-switch (#3509, ADR-0016).
 *
 * Gate 1 of the MCP dispatch order: a customer admin can disable whole MCP
 * action *categories* (e.g. "no datasource creation via MCP at all") for their
 * workspace. `packages/mcp/src/dispatch-gate.ts` consults `loadMcpActionPolicy`
 * and short-circuits a blocked category BEFORE scope / RBAC / approval —
 * distinct from the non-configurable origin ceiling. The decision is the
 * customer admin's, never the operator's (no env var); the customer-admin
 * dashboard (#3510) drives the setters.
 *
 * Default posture: a category is `allowed` unless an explicit `blocked` row
 * exists. Absence of a row means default-allowed, NOT "unknown" — a deployment
 * with no internal DB simply has no kill-switch configured, so everything is
 * allowed (the trusted-transport actor has no per-workspace policy to enforce).
 * A genuine *error* reading the policy is the dispatch gate's responsibility to
 * fail closed on; this store lets the error propagate so the caller can.
 *
 * This is core (AGPL), not EE: the action policy exists in both deploy modes —
 * SaaS-first, self-host inherits it (ADR-0016 "SaaS-first principle").
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  McpActionCategory,
  McpActionPolicyEntry,
  McpActionPolicyStatus,
} from "@useatlas/types/mcp";

const log = createLogger("mcp:action-policy");

/**
 * Canonical runtime tuple of MCP action categories. Mirrors the type-only
 * `McpActionCategory` union in `@useatlas/types/mcp` — the value tuple lives
 * here (not exported from `@useatlas/types`) so adding a category never breaks
 * the scaffold smoke tests that pull the published `@useatlas/types`. The
 * `satisfies` catches tuple→union drift (a bogus tuple element); the
 * `_AssertCategoriesComplete` check below catches union→tuple drift (a category
 * added to the wire union but forgotten here). Together they keep the two in
 * lockstep in BOTH directions, so a security-relevant kill-switch category can't
 * silently exist in the wire type without runtime enforcement.
 */
export const MCP_ACTION_CATEGORIES = [
  "datasource",
  "integration",
  "policy",
  "raw_sql",
] as const satisfies readonly McpActionCategory[];

// Compile-time check: every `McpActionCategory` must appear in the tuple above.
// `satisfies` alone only proves tuple ⊆ union; this proves union ⊆ tuple. If a
// category is added to `McpActionCategory` but not appended here, this resolves
// to `never` and the assignment fails to compile. Mirrors the
// `ATLAS_ERROR_TAG_LIST` precedent in `lib/effect/errors.ts`.
type _AssertCategoriesComplete = McpActionCategory extends (typeof MCP_ACTION_CATEGORIES)[number]
  ? true
  : never;
const _assertCategoriesComplete: _AssertCategoriesComplete = true;
void _assertCategoriesComplete;

/** Server-authoritative label + description per category for the dashboard. */
export interface McpActionCategoryMeta {
  readonly category: McpActionCategory;
  readonly label: string;
  readonly description: string;
}

/**
 * Customer-facing copy for each category. Lives server-side so the web
 * dashboard renders the category set straight off the policy API response
 * and never hardcodes (or drifts from) the canonical list.
 */
export const MCP_ACTION_CATEGORY_META: readonly McpActionCategoryMeta[] = [
  {
    category: "datasource",
    label: "Datasource management",
    description:
      "Creating, testing, profiling, and deleting datasources (Postgres, MySQL, ClickHouse, Snowflake, Elasticsearch/OpenSearch, REST) via MCP.",
  },
  {
    category: "integration",
    label: "Integration connections",
    description:
      "Connecting delivery integrations (Slack, GitHub, Linear, Email) via MCP.",
  },
  {
    category: "policy",
    label: "Governance policy",
    description:
      "Raising governance via MCP — adding approval rules and PII classifications. MCP can only tighten controls, never loosen them (the origin ceiling).",
  },
  {
    category: "raw_sql",
    label: "Raw SQL execution",
    description:
      "Running caller-authored SQL directly over the programmatic surfaces — the CLI (`atlas sql`) and the MCP `executeSQL` tool. Disable to restrict members to the natural-language `atlas query` path. The Atlas agent, chat, and `atlas query` are never affected.",
  },
];

/**
 * Denial copy for a blocked category, transport-neutral so the CLI/REST and MCP
 * enforcement points surface identical wording (no per-surface drift, #4095).
 * `raw_sql` points members at the NL `atlas query` path; the mutation categories
 * share the generic copy the gate has always used. Single-sourced here alongside
 * the category labels rather than inlined at each gate.
 */
export function mcpActionDenialCopy(category: McpActionCategory): {
  message: string;
  hint: string;
} {
  if (category === "raw_sql") {
    return {
      message:
        "Raw SQL execution is disabled for this workspace by an administrator. Use the natural-language `atlas query` command instead.",
      hint: "A workspace admin can re-enable raw SQL under Admin → MCP action policy.",
    };
  }
  return {
    message: `MCP '${category}' actions are disabled for this workspace by an administrator.`,
    hint: "A workspace admin can re-enable this category under Admin → MCP action policy.",
  };
}

/** Type guard — narrows an arbitrary string to a known category. */
export function isMcpActionCategory(value: string): value is McpActionCategory {
  return (MCP_ACTION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Resolved per-workspace policy. `isBlocked` is the only thing gate 1 needs —
 * a closure over the blocked set so the dispatch gate stays decoupled from the
 * row shape.
 */
export interface McpActionPolicy {
  /** True when the category is explicitly blocked for this workspace. */
  isBlocked(category: McpActionCategory): boolean;
}

/**
 * Minimal query seam — the exact subset of `internalQuery` this module needs.
 */
export type ActionPolicyQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * Injectable store dependencies, so the row→policy mapping + setter SQL are
 * unit-testable without a real DB (and without `mock.module`). Both default to
 * the live internal-DB helpers.
 */
export interface ActionPolicyStoreDeps {
  readonly query?: ActionPolicyQuery;
  readonly hasInternalDb?: () => boolean;
}

interface PolicyRow extends Record<string, unknown> {
  category: string;
  status: string;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * Load the workspace's blocked-category set. Returns an all-allowed policy when
 * no internal DB is configured (no store ⇒ no kill-switch). Lets a genuine DB
 * error propagate so the dispatch gate can fail closed on it.
 */
export async function loadMcpActionPolicy(
  orgId: string,
  deps: ActionPolicyStoreDeps = {},
): Promise<McpActionPolicy> {
  const hasDb = deps.hasInternalDb ?? hasInternalDB;
  const query = deps.query ?? internalQuery;
  if (!hasDb()) {
    return { isBlocked: () => false };
  }
  const rows = await query<PolicyRow>(
    `SELECT category, status FROM mcp_action_policy WHERE org_id = $1 AND status = 'blocked'`,
    [orgId],
  );
  const blocked = new Set<string>(rows.map((r) => r.category));
  return { isBlocked: (category) => blocked.has(category) };
}

/**
 * Full per-category view for the dashboard — every canonical category merged
 * with its stored row (default `allowed` when no row exists).
 */
export async function getMcpActionPolicyEntries(
  orgId: string,
  deps: ActionPolicyStoreDeps = {},
): Promise<McpActionPolicyEntry[]> {
  const hasDb = deps.hasInternalDb ?? hasInternalDB;
  const query = deps.query ?? internalQuery;
  const stored = hasDb()
    ? await query<PolicyRow>(
        `SELECT category, status, updated_at::text AS updated_at, updated_by
           FROM mcp_action_policy WHERE org_id = $1`,
        [orgId],
      )
    : [];
  const byCategory = new Map(stored.map((r) => [r.category, r]));

  return MCP_ACTION_CATEGORY_META.map((meta) => {
    const row = byCategory.get(meta.category);
    const status: McpActionPolicyStatus = row?.status === "blocked" ? "blocked" : "allowed";
    return {
      category: meta.category,
      label: meta.label,
      description: meta.description,
      status,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

/**
 * Set one category's status for a workspace (upsert). An explicit `allowed`
 * row is kept rather than deleted so a re-enable carries an audit trail
 * (`updated_by` / `updated_at`); gate 1 only ever blocks on `blocked` rows, so
 * an `allowed` row is functionally identical to no row.
 *
 * Throws when no internal DB is configured — the dashboard never reaches this
 * path without one (the route 404s first), but fail loud rather than silently
 * no-op a security toggle.
 */
export async function setMcpActionCategoryStatus(
  orgId: string,
  category: McpActionCategory,
  status: McpActionPolicyStatus,
  updatedBy: string | null,
  deps: ActionPolicyStoreDeps = {},
): Promise<void> {
  const hasDb = deps.hasInternalDb ?? hasInternalDB;
  const query = deps.query ?? internalQuery;
  if (!hasDb()) {
    throw new Error("Internal database required to persist MCP action policy");
  }
  await query(
    `INSERT INTO mcp_action_policy (org_id, category, status, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (org_id, category)
       DO UPDATE SET status = $3, updated_at = now(), updated_by = $4`,
    [orgId, category, status, updatedBy],
  );
  log.info({ orgId, category, status, updatedBy }, "MCP action category status set");
}
