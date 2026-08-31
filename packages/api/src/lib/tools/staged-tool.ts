/**
 * The staging half of the staged-write gate, as the two brain-write TOOLS need
 * it (#5571).
 *
 * `lib/brain/staged-write.ts` owns the sequence — is there a brain, is there a
 * workspace, does this actor resolve — and answers with a tagged result that
 * knows nothing about surfaces. This module turns that result into the
 * `{ error, reason }` shape an agent tool returns, which is the OTHER thing the
 * two tools were each writing out by hand: the first pass of #5571 deduplicated
 * the two confirm ROUTES and left the same four-arm `switch` copied verb to
 * verb here, differing only in its reason codes and its log label.
 *
 * It lives in `lib/tools/` rather than beside the seam because the shape it
 * produces is the agent-tool contract (`searchBrain` set it: machine-readable
 * `reason` beside user-facing prose, so a caller branches without
 * pattern-matching English), and because `withRequestId` lives here — see
 * `tool-message.ts` for why that is not in the gate.
 *
 * The reason CODES stay with their tools. `proposeFact`'s set is
 * `correct_fact`'s minus `refused`, because staging a proposal runs no
 * authority gate to be refused BY, and a reason nothing can emit is exactly the
 * stale contract those objects exist to keep honest. So this function is
 * generic in the code type and each tool passes its own four.
 */
import type { createLogger } from "@atlas/api/lib/logger";
import type { StagedActorResolution, StagedVerb } from "@atlas/api/lib/brain/staged-write";
import { withRequestId } from "@atlas/api/lib/tools/tool-message";

/** One tool's `reason` code per rung of the staging preamble. */
export interface StagedStagingReasons<TReason> {
  /** No internal database — this deployment has no brain. */
  readonly storeUnavailable: TReason;
  /** No workspace bound to this session. */
  readonly noWorkspace: TReason;
  /** The actor's identity could not be resolved. */
  readonly readerUnresolved: TReason;
  /** Resolving the actor failed some other way. */
  readonly actorFailed: TReason;
}

export interface StagedToolRefusal<TReason> {
  readonly error: string;
  readonly reason: TReason;
}

export interface StagedToolRefusalInput<TBinding, TReason> {
  /** The verb whose staging copy answers. */
  readonly verb: StagedVerb<TBinding>;
  /** The refusal arm from {@link import("@atlas/api/lib/brain/staged-write").resolveStagedActor}. */
  readonly failure: Extract<StagedActorResolution, { ok: false }>;
  readonly reasons: StagedStagingReasons<TReason>;
  /** The tool's name as it appears in a log line, e.g. `"proposeFact"`. */
  readonly toolName: string;
  readonly log: ReturnType<typeof createLogger>;
  readonly workspaceId: string | undefined;
  readonly requestId: string | undefined;
  /** Extra log fields, e.g. a correction's `factId` and `verb`. */
  readonly logFields?: Readonly<Record<string, unknown>>;
}

/**
 * Map a staging-preamble refusal onto the tool result, once.
 *
 * Two rules are enforced here rather than remembered at each call site:
 *
 * **Which arms log.** The two deployment-shape refusals do not: they are decided
 * before anything is attempted and are identical for every request against that
 * deployment, so a log line per agent turn would be noise. The two actor arms do,
 * because each describes one specific failed attempt an operator has to be able
 * to find.
 *
 * **Which arms carry the request id.** The same split, for the same reason — an
 * id correlates a failure with its server-side log line, and the deployment-shape
 * arms have no log line to correlate with. This mirrors the confirm side, where
 * the client-caused 400s carry no `requestId` and every 500/503 does.
 */
export function stagedToolRefusal<TBinding, TReason>(
  input: StagedToolRefusalInput<TBinding, TReason>,
): StagedToolRefusal<TReason> {
  const { verb, failure, reasons, toolName, log, workspaceId, requestId } = input;
  const copy = verb.copy.staging;
  const fields = { workspaceId, requestId, ...(input.logFields ?? {}) };

  switch (failure.failure) {
    case "store-unavailable":
      return { error: copy.storeUnavailable, reason: reasons.storeUnavailable };
    case "no-workspace":
      return { error: copy.noWorkspace, reason: reasons.noWorkspace };
    case "reader-unresolved":
      log.error(
        { err: failure.message, ...fields },
        `${toolName} refused: actor identity could not be resolved`,
      );
      return {
        error: withRequestId(copy.readerUnresolved, requestId),
        reason: reasons.readerUnresolved,
      };
    case "actor-failed":
      log.error(
        { err: failure.message, ...fields },
        `${toolName} could not resolve the actor for staging`,
      );
      return { error: withRequestId(copy.actorFailed, requestId), reason: reasons.actorFailed };
    default: {
      // Fail closed. Unreachable by construction — the assignment below is what
      // makes a new `StagedActorResolution` arm a compile error rather than a
      // silent fall-through — but a THROW here would surface as an unhandled
      // tool error the model cannot act on, where the refusal shape is exactly
      // what it knows how to read.
      const unexpected: never = failure;
      log.error(
        { ...fields, failure: String(unexpected) },
        `${toolName} refused: unhandled staging-preamble arm (fail-closed)`,
      );
      return { error: withRequestId(copy.actorFailed, requestId), reason: reasons.actorFailed };
    }
  }
}
