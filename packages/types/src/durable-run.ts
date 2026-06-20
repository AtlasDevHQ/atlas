/**
 * Durable agent-run status wire types (#3749, ADR-0020).
 *
 * The web chat reads a conversation's latest run status on load/reconnect to
 * decide which durability affordance to render: an "interrupted — resume" banner
 * (`running`), a "waiting on approval" state (`parked`), or nothing for a
 * terminal run (`done`/`failed`) or a conversation with no run to surface
 * (`none`). The runtime values mirror the `agent_runs.status` lifecycle plus the
 * client-only `none` sentinel for "no run / not available".
 */

/** The four `agent_runs.status` lifecycle values (mirrors `AGENT_RUN_STATUS`). */
export type AgentRunLifecycleStatus = "running" | "parked" | "done" | "failed";

/**
 * The latest run's status for a conversation, as surfaced to the chat client.
 * `running` is interrupted-and-resumable; `parked` is suspended awaiting a human
 * approval decision; `done`/`failed` are terminal (no affordance); `none` means
 * there is no run to surface (no internal DB, durability off, no row, or a
 * fail-soft read blip — all collapse to "render nothing").
 */
export type RunStatusValue = AgentRunLifecycleStatus | "none";

/**
 * Response of the latest-run-status probe
 * (`GET /api/v1/chat/{conversationId}/run-status`). When `status` is `none` the
 * run identifiers are absent. For a real run, `runId` is the durable run's id
 * (the same id the resume endpoint surfaces as `x-run-id`), and `parkedReason`
 * carries the approval-queue reference for a `parked` run (null otherwise).
 */
export interface RunStatusResponse {
  status: RunStatusValue;
  /** The latest run's id — absent when `status` is `none`. */
  runId?: string;
  /** The approval-queue ref a `parked` run is waiting on; null for non-parked runs, absent when `none`. */
  parkedReason?: string | null;
}
