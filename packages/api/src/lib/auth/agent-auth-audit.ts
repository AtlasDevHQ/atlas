/**
 * Agent Auth Protocol → admin-action audit bridge (#4412 / #2058, Slice 4).
 *
 * The `@better-auth/agent-auth` plugin exposes a single `onEvent(event)` hook
 * that fires after every significant mutation in the agent lifecycle (§12 of the
 * protocol). This module is the one place that hook is turned into rows in the
 * existing `admin_action_log` catalog (`ADMIN_ACTIONS.agent.*`), so the
 * register → enroll → request → approve/deny → execute → revoke trail is
 * queryable next to every other admin surface — no bespoke agent-audit table.
 *
 * Three things this bridge is careful about:
 *
 *  1. **Fail-closed on the master switch.** Every call first consults the
 *     platform-tier `ATLAS_AGENT_AUTH_ENABLED` gate (`isAgentAuthEnabled()`, no
 *     orgId ⇒ platform tier — the master kill-switch). When off, NOTHING is
 *     emitted. In practice the HTTP surface already 404s when off so no event
 *     fires, but a direct `auth.api.*` server call would bypass that gate; this
 *     check makes "no rows when off" a guaranteed, directly-testable contract
 *     (issue AC #4) rather than an emergent property of the HTTP layer.
 *
 *  2. **Execute is summarized, never per-call.** `capability.executed` is the
 *     high-volume verb — a single agent session can drive thousands. Successful
 *     executes are counted per `(agentId, capability)` and only every
 *     {@link EXECUTE_SUMMARY_INTERVAL}-th one emits a row, which records how many
 *     it stands for (`metadata.representedExecuteCount`) and that it is a summary
 *     (`metadata.sampled: true`). Execute FAILURES skip the sampler and always
 *     emit (`status: "failure"`) — rare and forensically load-bearing.
 *
 *  3. **No sensitive payloads, honest attribution.** `logAdminAction` resolves
 *     the `actor_id` / `org_id` COLUMNS only from the ambient Atlas request
 *     context, which is absent on the Better Auth catch-all — so those columns
 *     are `unknown`/`null` here regardless of what the event carries. The real
 *     forensic identifiers travel in `metadata` instead: `actorId`, `actorType`,
 *     `agentId`, `hostId`, and `orgId` when the event carries one (it is optional
 *     on the event and not always present); execute rows add `userId`. Same shape
 *     `mcp_session.*` uses. Capability `arguments` / `output` are never recorded
 *     (they can hold customer SQL / PII), and the plugin's per-event `metadata` is
 *     allowlisted into `detail` (not copied wholesale) so an upstream version bump
 *     can't silently start persisting a new sensitive field. A failure's `error`
 *     string is run through {@link errorMessage} (connection-string scrub +
 *     truncation) before it lands in the row.
 *
 * Reversibility: like the rest of the agent-auth seam, only this file, the
 * plugin factory, the verifier and the gate know the agent-auth event shape.
 * Nothing downstream learns it.
 */

import type {
  AgentAuthEvent,
  AgentAuthAuditEvent,
  AgentAuthAuditEventType,
  AgentAuthCapabilityExecutionEvent,
} from "@better-auth/agent-auth";

import {
  ADMIN_ACTIONS,
  errorMessage,
  logAdminAction,
  type AdminActionEntry,
  type AdminActionType,
} from "@atlas/api/lib/audit";
import { isAgentAuthEnabled } from "@atlas/api/lib/auth/agent-auth-gate";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:agent-auth-audit");

/**
 * One `agent.capability.execute` audit row is written per this many SUCCESSFUL
 * executes of the same `(agentId, capability)` pair. Chosen to keep a high-QPS
 * agent from flooding the admin trail while still leaving a periodic breadcrumb
 * that execution is happening. A plain constant (not a settings key) — it is a
 * fine-grained sampling knob, not an operator-facing control. Injectable via
 * {@link createAgentAuthAuditor} for deterministic tests.
 */
export const EXECUTE_SUMMARY_INTERVAL = 25;

/**
 * Coarse memory bound on the per-`(agentId, capability)` success counters. A
 * counter is deleted the moment it flushes, so the live set is normally just the
 * currently-active agent×capability pairs; this cap only matters under a flood of
 * distinct pairs that each execute fewer than {@link EXECUTE_SUMMARY_INTERVAL}
 * times and never again. On overflow the counters are cleared wholesale (a few
 * pending summaries are lost — acceptable for a sampled trail).
 */
export const EXECUTE_TRACKED_KEYS_CAP = 5000;

/** How an audited event maps onto the catalog + which id is the audit target. */
interface AuditMapping {
  readonly action: AdminActionType;
  /** Whether the row's `targetId` is the host id or the agent id. */
  readonly target: "agent" | "host";
}

/**
 * The audited subset of `AgentAuthAuditEventType`. The plugin emits many more
 * event types (`agent.updated`, `agent.claimed`, `host.created`,
 * `capability.granted`, `approval.created`, key-rotations, …); those are
 * deliberately NOT in the catalog for this slice and fall through unaudited.
 * `capability.executed` is handled by its own sampled path, not here.
 */
const AUDIT_MAPPINGS: Partial<Record<AgentAuthAuditEventType, AuditMapping>> = {
  "agent.created": { action: ADMIN_ACTIONS.agent.register, target: "agent" },
  "agent.revoked": { action: ADMIN_ACTIONS.agent.revoke, target: "agent" },
  "host.enrolled": { action: ADMIN_ACTIONS.agent.hostEnroll, target: "host" },
  "host.revoked": { action: ADMIN_ACTIONS.agent.hostRevoke, target: "host" },
  "capability.requested": { action: ADMIN_ACTIONS.agent.capabilityRequest, target: "agent" },
  "capability.approved": { action: ADMIN_ACTIONS.agent.capabilityApprove, target: "agent" },
  "capability.denied": { action: ADMIN_ACTIONS.agent.capabilityDeny, target: "agent" },
  "capability.revoked": { action: ADMIN_ACTIONS.agent.capabilityRevoke, target: "agent" },
};

/**
 * The plugin per-event `metadata` keys we copy into the audit row's `detail`.
 * An ALLOWLIST, not a blanket spread: every key here is a known-benign label /
 * count / id-list (`name`, capability names, grant ids, revoked counts, a
 * decision `reason`). A future `@better-auth/agent-auth` version that adds a new
 * field to `event.metadata` (rotated key material, a raw claim set, …) is dropped
 * by construction rather than silently persisted into `admin_action_log`.
 */
const DETAIL_ALLOWLIST: ReadonlySet<string> = new Set([
  "name",
  "mode",
  "capabilities",
  "pendingCapabilities",
  "forceApproval",
  "autoApproved",
  "pending",
  "reason",
  "grantIds",
  "agentsRevoked",
]);

/** Project the plugin's per-event metadata down to the {@link DETAIL_ALLOWLIST}. Returns undefined when nothing survives. */
function allowlistedDetail(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (DETAIL_ALLOWLIST.has(key)) detail[key] = value;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** Pick the audit row's `targetId` — the host or agent id per the mapping, with a total fallback chain. */
function pickTargetId(event: AgentAuthAuditEvent, target: "agent" | "host"): string {
  const preferred = target === "host" ? event.hostId : event.agentId;
  return preferred ?? event.agentId ?? event.hostId ?? event.targetId ?? "unknown";
}

/**
 * The trustworthy identity fields, lifted into metadata under stable keys so
 * forensic queries can pivot (`metadata->>'agentId'`, …). The plugin's own
 * per-event metadata (`name`, `capabilities`, `reason`, `agentsRevoked`, …) is
 * nested under `detail` so it can never clobber these keys.
 */
function auditMetadata(event: AgentAuthAuditEvent): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (event.actorId) metadata.actorId = event.actorId;
  if (event.actorType) metadata.actorType = event.actorType;
  if (event.agentId) metadata.agentId = event.agentId;
  if (event.hostId) metadata.hostId = event.hostId;
  if (event.orgId) metadata.orgId = event.orgId;
  if (event.targetType) metadata.eventTargetType = event.targetType;
  const detail = allowlistedDetail(event.metadata);
  if (detail) metadata.detail = detail;
  return metadata;
}

/** Build the metadata for a `capability.executed` row — identity + capability + outcome, never args/output. */
function executeMetadata(
  event: AgentAuthCapabilityExecutionEvent,
  representedExecuteCount: number,
  sampled: boolean,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    capability: event.capability,
    executeStatus: event.status,
    representedExecuteCount,
    sampled,
  };
  if (event.agentId) metadata.agentId = event.agentId;
  if (event.hostId) metadata.hostId = event.hostId;
  if (event.userId) metadata.userId = event.userId;
  if (event.agentName) metadata.agentName = event.agentName;
  if (event.provider) metadata.provider = event.provider;
  if (typeof event.durationMs === "number") metadata.durationMs = event.durationMs;
  // Scrub + truncate before persisting: a driver/proxy error string can echo a
  // connection string (password) or overflow the JSONB column. `errorMessage` is
  // the same audit-metadata hygiene the rest of the catalog uses.
  if (event.error) metadata.error = errorMessage(event.error);
  // NB: event.arguments / event.output are intentionally omitted — they can
  // carry customer SQL and query results (PII). Only the capability name and the
  // outcome are auditable.
  return metadata;
}

/** Injected seams — real in production, stubbed in tests. */
export interface AgentAuthAuditorOptions {
  /** Sink for finished rows. Defaults to the fire-and-forget {@link logAdminAction}. */
  readonly emit?: (entry: AdminActionEntry) => void;
  /** Master-switch resolver. Defaults to the platform-tier {@link isAgentAuthEnabled}. */
  readonly isEnabled?: () => Promise<boolean>;
  /** Successful executes per emitted summary row. Defaults to {@link EXECUTE_SUMMARY_INTERVAL}. */
  readonly executeSummaryInterval?: number;
  /** Coarse cap on live per-key counters. Defaults to {@link EXECUTE_TRACKED_KEYS_CAP}. */
  readonly maxTrackedKeys?: number;
}

export interface AgentAuthAuditor {
  /**
   * The `onEvent` callback. Never rejects — every failure path (gate resolver,
   * emit, enrichment) is caught internally and logged, so it is safe to run
   * fire-and-forget / in the background.
   */
  handleEvent(event: AgentAuthEvent): Promise<void>;
}

/**
 * Build an auditor with its own encapsulated sampler state. Kept a factory (not a
 * bare module function) so the per-`(agentId, capability)` counters stay private
 * and tests can drive a fresh instance with injected seams — no top-level
 * singleton mutation (CLAUDE.md testing rule).
 */
export function createAgentAuthAuditor(options: AgentAuthAuditorOptions = {}): AgentAuthAuditor {
  const emit = options.emit ?? logAdminAction;
  const isEnabled = options.isEnabled ?? (() => isAgentAuthEnabled());
  const interval = Math.max(1, Math.floor(options.executeSummaryInterval ?? EXECUTE_SUMMARY_INTERVAL));
  const maxKeys = Math.max(1, Math.floor(options.maxTrackedKeys ?? EXECUTE_TRACKED_KEYS_CAP));

  /** count of successful executes since the last emitted summary, per `${agentId}::${capability}`. */
  const executeCounts = new Map<string, number>();

  function handleExecute(event: AgentAuthCapabilityExecutionEvent): void {
    // Failures bypass the sampler — rare and load-bearing. Always one row.
    if (event.status === "error") {
      emit({
        actionType: ADMIN_ACTIONS.agent.capabilityExecute,
        targetType: "agent",
        targetId: event.agentId ?? "unknown",
        status: "failure",
        metadata: executeMetadata(event, 1, false),
      });
      return;
    }

    // Summarize successes: one row per `interval` executes of the same pair.
    const key = `${event.agentId ?? "unknown"}::${event.capability}`;
    const next = (executeCounts.get(key) ?? 0) + 1;
    if (next >= interval) {
      executeCounts.delete(key);
      emit({
        actionType: ADMIN_ACTIONS.agent.capabilityExecute,
        targetType: "agent",
        targetId: event.agentId ?? "unknown",
        status: "success",
        metadata: executeMetadata(event, interval, true),
      });
      return;
    }
    executeCounts.set(key, next);

    // Coarse memory bound — see EXECUTE_TRACKED_KEYS_CAP.
    if (executeCounts.size > maxKeys) {
      log.debug(
        { trackedKeys: executeCounts.size, cap: maxKeys },
        "agent-auth execute audit: tracked-key cap exceeded — clearing sampler counters",
      );
      executeCounts.clear();
    }
  }

  return {
    async handleEvent(event: AgentAuthEvent): Promise<void> {
      // Honor the "never throws" contract in this module rather than leaning on
      // the plugin's generic console.error swallow — a future enrichment that
      // throws (or a rejecting gate resolver) stays inside Atlas's structured
      // logging and drops just this one event.
      try {
        // AC #4 — fail-closed master gate. No agent-auth rows when the platform
        // switch is off, independent of how the event reached us.
        if (!(await isEnabled())) return;

        if (event.type === "capability.executed") {
          handleExecute(event);
          return;
        }

        const mapping = AUDIT_MAPPINGS[event.type];
        if (!mapping) return; // an unaudited lifecycle event — no catalog action

        // A deny is a normal decision outcome (like `approval.deny`), not an
        // operation failure — status stays the default "success".
        emit({
          actionType: mapping.action,
          targetType: "agent",
          targetId: pickTargetId(event, mapping.target),
          metadata: auditMetadata(event),
        });
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), eventType: event.type },
          "agent-auth audit bridge failed — event dropped",
        );
      }
    },
  };
}

/**
 * The process-wide auditor wired into the `agentAuth()` plugin. Constructed once
 * at module load (never mutated at test top level — tests build their own via
 * {@link createAgentAuthAuditor}).
 */
const defaultAuditor = createAgentAuthAuditor();

/** The `onEvent` callback passed to `agentAuth({ onEvent })` in the plugin factory. */
export function auditAgentAuthEvent(event: AgentAuthEvent): Promise<void> {
  return defaultAuditor.handleEvent(event);
}
