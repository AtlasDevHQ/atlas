/**
 * Shared metric-run resolver (#4048 / ADR-0027 shared gate-parity contract).
 *
 * `runMetric` executes a canonical metric by id using the metric's
 * authoritative SQL. Two transports reach it — the MCP `runMetric` tool
 * (`packages/mcp/src/semantic-tools.ts`) and the `POST /api/v1/metrics/{id}/run`
 * REST route (`atlas metric run`). Both share the SAME two steps:
 *
 *   1. resolve the metric by id  → its authoritative SQL (used exactly as
 *      defined; the semantic layer is the source of truth, never the caller)
 *   2. route the SQL to the metric's own group's connection — honoring
 *      group routing (#3274/#3281) so a grouped metric never runs against the
 *      wrong datasource and returns silently-wrong rows
 *
 * This module owns step 1 + step 2 as a pure-ish resolver so the route does
 * not re-derive the routing the MCP tool already encodes. The actual SQL
 * execution (validation → whitelist → RLS → auto-LIMIT → audit) is delegated
 * by the caller to the shared `runUserQueryPipeline` (REST) / `executeSQL`
 * (MCP) pipeline — this resolver never executes SQL itself.
 *
 * `filters` pass-through is not yet supported on either transport (a non-empty
 * filter set is rejected, mirroring the MCP tool), so it is surfaced here as a
 * typed outcome rather than silently ignored.
 */

import { findMetricById, type MetricDefinition } from "./lookups";
import { loadGroupRoutingContext } from "@atlas/api/lib/env-routing/lookup";

/**
 * The semantic group name for the flat/default semantic root — mirrors the
 * scanner's `"default"` group for root `metrics/` (see `scanner.ts`). A metric
 * whose `source` is this value runs against the default connection; any other
 * `source` is a named group whose id IS the connection id SQL routes on.
 */
export const DEFAULT_SEMANTIC_GROUP = "default";

/** A resolved metric run: the metric + the connection its SQL should target. */
export interface ResolvedMetricRun {
  readonly kind: "ok";
  readonly metric: MetricDefinition;
  /**
   * The connection id to execute the metric's SQL against, or `undefined` to
   * use the default connection. A default-group metric resolves to `undefined`
   * (default routing); a grouped metric resolves to its group id (or the
   * explicit member connection the caller passed, once validated).
   */
  readonly targetConnectionId: string | undefined;
}

/** The metric id does not exist in the workspace's semantic layer. */
export interface UnknownMetric {
  readonly kind: "unknown_metric";
  readonly id: string;
}

/** `filters` pass-through is requested but not yet supported (parity with MCP). */
export interface FiltersUnsupported {
  readonly kind: "filters_unsupported";
}

/**
 * An explicit `connectionId` targets a datasource outside the metric's group —
 * running the metric there would query the wrong data, so it is rejected.
 */
export interface WrongConnection {
  readonly kind: "wrong_connection";
  readonly metricId: string;
  readonly group: string;
  /** The canonical connection token for the metric's group (the value to pass instead). */
  readonly metricConnectionId: string;
  readonly connectionId: string;
}

/**
 * The routing lookup that validates an explicit member `connectionId` against
 * the metric's group could not complete — the internal DB faulted. This is a
 * retryable SERVER-side condition, not a user-input error: with the lookup
 * down we can neither prove nor disprove membership, so we refuse to
 * masquerade it as {@link WrongConnection} (a confident 400). The route maps
 * it to a retryable 503 (CLAUDE.md "prefer errors over silent fallbacks").
 */
export interface RoutingUnavailable {
  readonly kind: "routing_unavailable";
  readonly metricId: string;
  /** The explicit connection id whose group membership could not be verified. */
  readonly connectionId: string;
}

export type MetricRunResolution =
  | ResolvedMetricRun
  | UnknownMetric
  | FiltersUnsupported
  | WrongConnection
  | RoutingUnavailable;

export interface ResolveMetricRunOpts {
  readonly id: string;
  /** Reserved filter pass-through; a non-empty object is rejected (parity with MCP). */
  readonly filters?: Readonly<Record<string, unknown>>;
  /** Optional explicit connection id; validated against the metric's group. */
  readonly connectionId?: string;
  /** The bound workspace org id — used to resolve group membership for an explicit connection. */
  readonly orgId?: string;
  /** Test seam: override the semantic root the metric is looked up in. */
  readonly semanticRoot?: string;
}

/**
 * Resolve a metric id (+ optional explicit connection) to `{ metric,
 * targetConnectionId }`, honoring group routing. Never executes SQL.
 *
 * Routing rules (identical to the MCP `runMetric` tool):
 *  - A default-group metric runs against the default connection
 *    (`targetConnectionId = undefined`).
 *  - A grouped metric runs against its group id, unless the caller passes an
 *    explicit `connectionId` that is either the group id itself or a member of
 *    that group — then it routes to that specific connection.
 *  - An explicit `connectionId` that resolves to a different group (or any
 *    non-default connection for an ungrouped metric) is rejected as
 *    `wrong_connection` rather than silently re-routed.
 */
export async function resolveMetricRun(
  opts: ResolveMetricRunOpts,
): Promise<MetricRunResolution> {
  // Filters are not supported yet on either transport — reject loudly rather
  // than silently dropping a non-empty filter set (which would return rows the
  // caller didn't ask for).
  if (opts.filters && Object.keys(opts.filters).length > 0) {
    return { kind: "filters_unsupported" };
  }

  const metric = findMetricById(opts.id, { semanticRoot: opts.semanticRoot });
  if (!metric) {
    return { kind: "unknown_metric", id: opts.id };
  }

  // The metric's resolved semantic group IS the connection id SQL routes on
  // (search.ts surfaces a grouped entity's `connection` as that same group).
  // The default group maps to the default connection — passed through as an
  // unset connection id so the pipeline keeps its existing default routing.
  const groupConnectionId =
    metric.source === DEFAULT_SEMANTIC_GROUP ? undefined : metric.source;
  // Canonical connection token for the metric's group — `"default"` (not unset)
  // for the default group — so an explicit connectionId can be compared to it.
  const metricConnectionId =
    metric.source === DEFAULT_SEMANTIC_GROUP ? "default" : metric.source;

  const { connectionId } = opts;
  if (connectionId !== undefined && connectionId !== metricConnectionId) {
    // The connectionId isn't the group id itself, but for a multi-member group
    // it may be a legitimate MEMBER (a group `prod` with members `us-prod` /
    // `eu-prod` registers each under its own install id). Resolve the passed
    // connection's group and accept iff it matches the metric's group. A
    // default-source (ungrouped) metric has no members, so any explicit
    // non-default connectionId is rejected (#3281).
    let isGroupMember = false;
    if (metric.source !== DEFAULT_SEMANTIC_GROUP) {
      const routing = await loadGroupRoutingContext(opts.orgId, connectionId);
      if (routing.degraded) {
        // Fault-induced fallback: `groupId: undefined` is the ABSENCE of an
        // answer, not a "not a member" verdict, so we can't decide membership.
        // Surface it as {@link RoutingUnavailable} (see there for why not a 400)
        // rather than reading the fallback as a definitive mismatch (#4109).
        return { kind: "routing_unavailable", metricId: metric.id, connectionId };
      }
      isGroupMember = routing.groupId === metric.source;
    }
    if (!isGroupMember) {
      return {
        kind: "wrong_connection",
        metricId: metric.id,
        group: metric.source,
        metricConnectionId,
        connectionId,
      };
    }
  }

  return {
    kind: "ok",
    metric,
    targetConnectionId: connectionId ?? groupConnectionId,
  };
}
