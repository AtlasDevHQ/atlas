/**
 * Scheduled task executor — bridges the scheduler to executeAgentQuery().
 *
 * Fetches the task, runs the agent, delivers results, records delivery status,
 * and returns execution metadata. The executor does NOT update the run record
 * (status/completedAt) — callers (engine.ts) own run completion to avoid
 * double-writes. Delivery status is written here because only the executor
 * knows the delivery outcome.
 *
 * F-54: scheduled tasks now bind the original creator's identity into the
 * agent's RequestContext before invoking the agent. Without this, the
 * approval gate in `lib/tools/sql.ts` short-circuits because
 * `checkApprovalRequired(undefined, ...)` returns "not required" — the gate
 * silently disables and any approval-rule-matching query runs without ever
 * reaching the queue. See `.claude/research/security-audit-1-2-3.md` Phase 7.
 *
 * Effect migration (P3): Promise.race timeout replaced with Effect.timeout.
 */

import { Effect, Duration, Exit, Cause } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { getScheduledTask, updateRunDeliveryStatus } from "@atlas/api/lib/scheduled-tasks";
import { executeAgentQuery, type AgentQueryResult } from "@atlas/api/lib/agent-query";
import { BillingBlockedError } from "@atlas/api/lib/billing/agent-gate";
import { ClaimRequiredError } from "@atlas/api/lib/billing/claim-gate";
import { loadActorUser } from "@atlas/api/lib/auth/actor";
import { SchedulerTaskTimeoutError, SchedulerExecutionError } from "@atlas/api/lib/effect/errors";
import { causeToError } from "@atlas/api/lib/audit/error-scrub";
import { deliverResult } from "./delivery";
import { NoScheduledTaskGroupMembersError, resolveScheduledTaskConnection } from "./group-resolve";

const log = createLogger("scheduler-executor");

export interface ExecutionResult {
  tokensUsed: number;
  deliveryAttempted: number;
  deliverySucceeded: number;
  deliveryFailed: number;
}

/**
 * Build an Effect program that runs the agent query with a timeout.
 * Fails with SchedulerTaskTimeoutError on timeout, SchedulerExecutionError
 * on any other failure.
 */
function agentQueryEffect(
  question: string,
  requestId: string,
  taskId: string,
  timeoutMs: number,
  options: Parameters<typeof executeAgentQuery>[2],
) {
  return Effect.tryPromise({
    try: () => executeAgentQuery(question, requestId, options),
    // #3420 — a billing-enforcement block from the seam in
    // `executeAgentQuery` is recorded on the run row verbatim (engine.ts
    // calls `completeTaskRun(runId, "failed", { error: message })`), so
    // the message must name billing enforcement AND carry the user-safe
    // reason for the task owner's run history. Never a silent skip: the
    // seam already logged the block with org context.
    catch: (err) =>
      new SchedulerExecutionError({
        message:
          err instanceof BillingBlockedError
            ? `Blocked by billing enforcement [${err.errorCode}]: ${err.message}`
            : // ADR-0018 / #3651 — an unclaimed (metered) workspace blocks
              // scheduler Atlas-token runs too; record the claim reason + URL
              // on the run row so the owner knows to claim on the web.
              err instanceof ClaimRequiredError
              ? `Workspace not yet claimed [${err.errorCode}]: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        taskId,
      }),
  }).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(
        new SchedulerTaskTimeoutError({
          message: `Task execution timed out after ${timeoutMs}ms`,
          taskId,
          timeoutMs,
        }),
      ),
    ),
  );
}

/**
 * Format the failure message engine.ts records on the run row when the agent
 * surfaces an approval-required result. The run is marked as `failed` with
 * this message — the F-54 audit recommended a new `delivery_status =
 * "pending_approval"` value, but adding to `DELIVERY_STATUSES` in
 * `@useatlas/types/scheduled-task` is a wire-format bump to a published
 * package and out of scope for this fix. The message is unambiguous in
 * run-history UI and audit exports, and the queued approval request has
 * its own row in `approval_requests` for the admin to act on.
 */
function approvalFailureMessage(approval: NonNullable<AgentQueryResult["pendingApproval"]>): string {
  const ruleSummary = approval.matchedRules.length > 1
    ? `${approval.matchedRules[0]} (+${approval.matchedRules.length - 1} more)`
    : approval.ruleName;
  const idSuffix = approval.requestId !== null && approval.requestId !== ""
    ? ` Request ${approval.requestId}.`
    : "";
  return `Approval required: ${ruleSummary}.${idSuffix} Approve via the Atlas admin console before this task can deliver results.`;
}

/**
 * Execute a scheduled task: run the agent query and deliver results.
 * Returns execution metadata on success. Throws on failure.
 * Callers are responsible for updating the run record.
 */
export async function executeScheduledTask(
  taskId: string,
  runId: string,
  timeoutMs: number,
): Promise<ExecutionResult> {
  const taskResult = await getScheduledTask(taskId);
  if (!taskResult.ok) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const task = taskResult.data;
  const requestId = `sched-${taskId}-${runId}`;
  let resolvedConnectionId: string | null;
  try {
    resolvedConnectionId = await resolveScheduledTaskConnection({
      taskId,
      orgId: task.orgId,
      connectionGroupId: task.connectionGroupId,
    });
  } catch (err) {
    // #2416 — when the tenant's group has zero non-archived members,
    // group-resolve refuses to widen the org filter into __global__.
    // Skip the tick (don't fire the agent blind) and surface a clear
    // run-row error. The next admin action — add a member, archive the
    // task, or unarchive a member — recovers automatically.
    if (err instanceof NoScheduledTaskGroupMembersError) {
      log.warn(
        {
          taskId,
          runId,
          groupId: err.groupId,
          orgId: err.orgId,
        },
        "Scheduled task group has no non-archived members — skipping tick",
      );
      throw new Error(
        `Connection group ${err.groupId} has no non-archived members. ` +
          `Add a connection to the group or unarchive an existing member before this task can run.`,
        { cause: err },
      );
    }
    throw err;
  }

  // F-54: resolve the task creator so approval rules apply. If the user no
  // longer exists (account deleted, removed from org), fail-loud rather than
  // run as an anonymous actor — the audit trail must always have a real
  // requester. Operators can either restore the user or recreate the task
  // under a current owner. This is intentionally stricter than the previous
  // silent bypass.
  const actor = await loadActorUser(task.ownerId, task.orgId);
  if (!actor) {
    throw new Error(
      `Scheduled task owner ${task.ownerId} could not be resolved — ` +
        `pause this task or recreate it under a current user`,
    );
  }

  log.info(
    {
      taskId,
      runId,
      actorId: actor.id,
      orgId: task.orgId,
      connectionGroupId: task.connectionGroupId,
      connectionId: resolvedConnectionId,
      question: task.question.slice(0, 100),
    },
    "Executing scheduled task",
  );

  // Convert tagged errors to plain Errors at the Effect→Promise boundary.
  // Using `runPromiseExit` + manual cause extraction (instead of
  // `runPromise` + `Effect.die`) keeps the engine's `err.message` capture
  // free of the `(FiberFailure)` wrapper that `runPromise` adds when an
  // Effect dies — operators see "Task execution timed out after 30000ms"
  // not "(FiberFailure) Error: Task execution timed out…" in the run row.
  const exit = await Effect.runPromiseExit(
    // #2072 — stamp 'scheduler' so scheduler-scoped approval rules
    // fire only on scheduled runs, leaving chat / mcp queries against
    // the same tables unaffected. (Approval rules are additive; they
    // can only require approval, never waive it — to exempt the
    // scheduler from a broad rule, narrow that rule's origin.)
    agentQueryEffect(task.question, requestId, taskId, timeoutMs, {
      actor,
      // #3615 — scheduled runs execute outside any route-level
      // `withRequestContext`, so stamp the audit discriminator explicitly;
      // executeSQL audit rows then record actor_kind='scheduler'.
      actorKind: "scheduler",
      agentOrigin: "scheduler",
      ...(resolvedConnectionId ? { connectionId: resolvedConnectionId } : {}),
      ...(task.connectionGroupId ? { connectionGroupId: task.connectionGroupId } : {}),
    }),
  );
  if (Exit.isFailure(exit)) {
    if (Cause.isInterruptedOnly(exit.cause)) {
      throw new Error("Scheduled task interrupted");
    }
    const inner = causeToError(exit.cause);
    if (inner instanceof SchedulerTaskTimeoutError || inner instanceof SchedulerExecutionError) {
      throw new Error(inner.message);
    }
    throw inner instanceof Error ? inner : new Error(String(inner));
  }
  const agentResult = exit.value;

  // F-54: any approval-required tool result short-circuits delivery. The
  // approval request is already persisted by `executeSQL`; the engine marks
  // the run as failed with a message that names the rule and request id so
  // operators see exactly what happened in the run history.
  if (agentResult.pendingApproval) {
    log.info(
      {
        taskId,
        runId,
        approvalRequestId: agentResult.pendingApproval.requestId,
        rule: agentResult.pendingApproval.ruleName,
      },
      "Scheduled task held for approval — skipping delivery",
    );
    throw new Error(approvalFailureMessage(agentResult.pendingApproval));
  }

  // Only attempt delivery when recipients are configured
  const delivery = await deliverResult(task, agentResult);

  if (delivery.attempted === 0) {
    // No recipients configured — skip delivery status entirely (leave null)
  } else {
    // Mark delivery as pending, then update with outcome
    updateRunDeliveryStatus(runId, "pending");

    if (delivery.failed > 0) {
      log.warn(
        { taskId, runId, ...delivery },
        "Partial delivery failure — some recipients did not receive results",
      );
    }

    if (delivery.failed === 0) {
      updateRunDeliveryStatus(runId, "sent");
    } else {
      const baseMsg = delivery.succeeded > 0
        ? `Partial failure: ${delivery.failed}/${delivery.attempted} deliveries failed`
        : `All ${delivery.failed} deliveries failed`;
      // Surface the first permanent error so the admin sees WHAT to fix
      // (e.g. "No email delivery backend configured"), not just a count.
      const errorMsg = delivery.firstPermanentError
        ? `${baseMsg} — ${delivery.firstPermanentError}`
        : baseMsg;
      // #3379 — when every failure is permanent (misconfiguration: no email
      // sender, no Slack token, blocked webhook URL), record
      // "failed_permanent" so the run history distinguishes "fix your
      // config" from a transient outage. The task is deliberately NOT
      // auto-paused: the admin may configure the sender at any moment and
      // the next run should then deliver without further intervention.
      const allPermanent =
        delivery.permanentFailures === delivery.failed && delivery.permanentFailures > 0;
      updateRunDeliveryStatus(runId, allPermanent ? "failed_permanent" : "failed", errorMsg);
    }
  }

  return {
    tokensUsed: agentResult.usage.totalTokens,
    deliveryAttempted: delivery.attempted,
    deliverySucceeded: delivery.succeeded,
    deliveryFailed: delivery.failed,
  };
}
