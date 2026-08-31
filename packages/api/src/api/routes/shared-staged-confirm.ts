/**
 * The staged-write confirm ladder — the transport half of #5571's one gate.
 *
 * `POST /api/v1/brain-proposals/confirm` and `POST /api/v1/brain-corrections/confirm`
 * are the confirm-before-write execution points for the two staged brain verbs.
 * Before this module they were two ~480-line handlers whose no_workspace /
 * brain_unavailable / re-resolve / verify / burn / vocabulary / error ladders
 * were the same nine rungs written twice, with the security-critical ordering
 * comment copy-pasted into both. {@link runStagedConfirm} is that ladder, once.
 *
 * ## Why the ladder is here and its ordering is in `lib/`
 *
 * `lib/brain/staged-write.ts` owns the sequence — the degradation preamble,
 * actor re-resolution, and the verify→burn gate — and knows nothing about HTTP.
 * This module owns only the mapping from its tagged refusals onto status codes
 * and bodies, which is a transport decision. That is the split
 * `shared-correction.ts`'s header already makes for correction refusals, and the
 * layering note in CLAUDE.md: `lib/` does not hold status codes.
 *
 * ## What a verb still decides
 *
 * The binding it re-derives, the write it runs, and how its OUTCOME projects
 * onto a response. The last one is deliberately not here: a proposal's outcomes
 * are `proposed` / `corroborated` / `refused`, a correction's are `corrected` /
 * `not-found` / `refused` at three different statuses, and flattening two
 * genuinely different result vocabularies into one would be the copy this
 * refactor is removing, wearing a different hat. {@link runStagedConfirm} hands
 * back the outcome; the route projects it.
 */
import type { Context } from "hono";

import type { createLogger } from "@atlas/api/lib/logger";
import { VocabularyClosureError, loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
// Type-only, so neither `identity.ts` nor `acl.ts` enters a mocked route test's
// module graph.
import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  resolveStagedActor,
  verifyAndBurnStagedConfirm,
  type StagedVerb,
} from "@atlas/api/lib/brain/staged-write";
import type { AuthEnv } from "./middleware";

/**
 * A refusal as status + body, rather than a `Response`.
 *
 * The route calls `c.json(refusal.body, refusal.status)` itself, so each
 * endpoint's declared OpenAPI `responses` still type-check the bodies it can
 * actually emit — a helper returning an opaque `Response` would take that
 * checking away, and these are exactly the bodies worth having checked.
 *
 * `requestId` is present on the correlated failures and ABSENT on the three
 * client-side 400s, which is the contract both routes already had: a 400 the
 * caller caused (no workspace, a bad token, a spent token) carries nothing to
 * correlate and nothing to leak, while every 500/503 is a server event an
 * operator has to find in a log.
 */
export type StagedConfirmRefusal =
  | { readonly status: 400; readonly body: { readonly error: string; readonly message: string } }
  | {
      readonly status: 500 | 503;
      readonly body: {
        readonly error: string;
        readonly message: string;
        readonly requestId: string;
      };
    };

/** The gate's answer: the actor and the verb's outcome, or the refusal to return. */
export type StagedConfirmResult<TOutcome> =
  | { readonly ok: true; readonly ctx: BrainPrincipalContext; readonly outcome: TOutcome }
  | { readonly ok: false; readonly refusal: StagedConfirmRefusal };

export interface StagedConfirmDeps<TBinding, TOutcome> {
  /** The verb's descriptor — its token identity, binding projection and copy. */
  readonly verb: StagedVerb<TBinding>;
  readonly log: ReturnType<typeof createLogger>;
  /**
   * Fields added to every server-side log line, e.g. a correction's `factId`
   * and `verb`. Read off the VALIDATED request body, never off the token.
   */
  readonly logFields?: Readonly<Record<string, unknown>>;
  /** The single-use confirm token from the request body. */
  readonly token: string;
  /**
   * Re-derive the token binding from THIS request and the re-resolved actor.
   *
   * Takes the resolved context rather than closing over the raw org id: the
   * staging tool binds `ctx.workspaceId`, so verifying against anything else is
   * how a token starts failing for reasons nobody can reproduce.
   */
  readonly bind: (ctx: BrainPrincipalContext) => TBinding;
  /**
   * Run the write. Called ONLY after the nonce is burned, with the live actor
   * and the workspace's real vocabulary.
   */
  readonly execute: (
    ctx: BrainPrincipalContext,
    vocabulary: ClaimVocabulary,
  ) => Promise<TOutcome>;
}

/**
 * The nine rungs, in the one order.
 *
 * 1. An active workspace, then 2. an internal database — in that order, because
 *    it is the order both endpoints already answered in and #5571 is a refactor.
 *    (The staging TOOLS ask store-first, and `StagedPreambleOrder` carries why.)
 * 3. Re-resolve the actor from THIS request. Neither endpoint is a trusted
 *    fast-path: attribution, grants and ACL visibility are all derived
 *    server-side, so a session that has since lost its membership is refused
 *    even though its token verifies.
 * 4. Verify the token binds that re-resolved request, and 5. burn its nonce —
 *    one call, because the ordering is the invariant
 *    ({@link verifyAndBurnStagedConfirm}).
 * 6. Load the workspace's REAL vocabulary — never the staged payload's, and
 *    never degraded to the empty one, which would key the claim under a
 *    different identity function than ingest used.
 * 7. Run the verb, mapping `VocabularyClosureError` (deterministic and
 *    permanent until an operator recomputes the closure, so the copy says so
 *    rather than inviting a retry loop) apart from 8. a generic throw, and
 * 9. hand the outcome back for the route to project.
 *
 * The vocabulary load sits INSIDE the same `try` as the verb, which is where it
 * has always been: `loadWorkspaceVocabulary` is the thing that raises
 * `VocabularyClosureError`, so lifting it out would turn a 503 into a 500.
 */
export async function runStagedConfirm<TBinding, TOutcome>(
  c: Context<AuthEnv>,
  deps: StagedConfirmDeps<TBinding, TOutcome>,
): Promise<StagedConfirmResult<TOutcome>> {
  const { verb, log, token, bind, execute } = deps;
  const copy = verb.copy.confirm;
  const auth = c.get("authResult");
  const requestId = c.get("requestId");
  const workspaceId = auth?.user?.activeOrganizationId;
  const fields = deps.logFields ?? {};

  const actor = await resolveStagedActor({
    workspaceId,
    user: auth?.user,
    requestId,
    order: "workspace-first",
  });
  if (!actor.ok) {
    switch (actor.failure) {
      case "no-workspace":
        return {
          ok: false,
          refusal: { status: 400, body: { error: "no_workspace", message: copy.noWorkspace } },
        };
      case "store-unavailable":
        return {
          ok: false,
          refusal: {
            status: 503,
            body: { error: "brain_unavailable", message: copy.storeUnavailable, requestId },
          },
        };
      case "reader-unresolved":
        log.error(
          { err: actor.message, workspaceId, requestId, ...fields },
          `${verb.name} confirm refused: actor identity could not be resolved`,
        );
        return {
          ok: false,
          refusal: {
            status: 500,
            body: { error: "reader_unresolved", message: copy.readerUnresolved, requestId },
          },
        };
      case "actor-failed":
        log.error(
          { err: actor.message, workspaceId, requestId, ...fields },
          `${verb.name} confirm could not resolve the actor`,
        );
        return {
          ok: false,
          refusal: {
            status: 500,
            body: { error: "internal_error", message: copy.actorFailed, requestId },
          },
        };
      default: {
        // Fail closed. Unreachable by construction — the assignment is what makes
        // a new `StagedActorResolution` arm a compile error — but a THROW here
        // would escape `route.onError` to the global handler, which mints a FRESH
        // request id: the 500 a caller quotes would then correlate with nothing.
        const unexpected: never = actor;
        log.error(
          { workspaceId, requestId, failure: String(unexpected), ...fields },
          `${verb.name} confirm refused: unhandled actor-resolution arm (fail-closed)`,
        );
        return {
          ok: false,
          refusal: {
            status: 500,
            body: { error: "internal_error", message: copy.actorFailed, requestId },
          },
        };
      }
    }
  }

  const { ctx } = actor;

  // The single-use confirm gate. Verify + burn in one call, with nothing
  // between them — the ordering is `staged-write.ts`'s to keep, not this
  // module's to re-derive. Everything after this line runs on a spent nonce,
  // which is deliberate: the nonce is spent on the ATTEMPT, so a caller cannot
  // re-fire one confirmation against many claims or many target states.
  const gate = verifyAndBurnStagedConfirm(verb, token, bind(ctx));
  if (!gate.ok) {
    switch (gate.failure) {
      case "unverifiable":
        // A server/operator misconfiguration, not an attacker-probeable token
        // failure — a correlated 500, not the neutral client 400.
        // Near-unreachable in practice: mint fails loud on no-key, so a
        // confirmable write cannot have been staged without a key — reachable
        // only if the key is removed or rotated-to-empty between stage and
        // confirm.
        log.error(
          { workspaceId: ctx.workspaceId, requestId, ...fields },
          `${verb.name} confirm rejected: no signing key configured for confirm tokens (server misconfiguration)`,
        );
        return {
          ok: false,
          refusal: {
            status: 500,
            body: {
              error: "confirm_token_unverifiable",
              message: copy.tokenUnverifiable,
              requestId,
            },
          },
        };
      case "invalid":
        // ONE neutral 400 for every attacker-probeable arm. The specific reason
        // is logged server-side and never returned: telling a caller which
        // check tripped is how a pipeline gets probed.
        log.warn(
          { workspaceId: ctx.workspaceId, reason: gate.reason, requestId, ...fields },
          `${verb.name} confirm rejected: invalid confirm token`,
        );
        return {
          ok: false,
          refusal: {
            status: 400,
            body: { error: "confirm_token_invalid", message: copy.tokenInvalid },
          },
        };
      case "replayed":
        log.warn(
          { workspaceId: ctx.workspaceId, requestId, ...fields },
          `${verb.name} confirm rejected: confirm token already used (replay)`,
        );
        return {
          ok: false,
          refusal: {
            status: 400,
            body: { error: "confirm_token_invalid", message: copy.tokenReplayed },
          },
        };
      default: {
        // Fail closed, and on the SAFE side of this boundary: an unrecognized
        // gate arm must refuse, never fall through toward the write. Returned
        // rather than thrown for the request-id reason above.
        const unexpected: never = gate;
        log.error(
          { workspaceId: ctx.workspaceId, requestId, failure: String(unexpected), ...fields },
          `${verb.name} confirm rejected: unhandled confirm-gate arm (fail-closed)`,
        );
        return {
          ok: false,
          refusal: {
            status: 500,
            body: { error: "internal_error", message: copy.executeFailed, requestId },
          },
        };
      }
    }
  }

  try {
    // The workspace's REAL vocabulary, loaded here rather than carried in the
    // staged payload for the reason both endpoints exist: the staged payload is
    // not trusted, and a vocabulary is workspace STATE that may have moved since
    // staging.
    const vocabulary = await loadWorkspaceVocabulary(ctx.workspaceId);
    return { ok: true, ctx, outcome: await execute(ctx, vocabulary) };
  } catch (err) {
    if (err instanceof VocabularyClosureError) {
      log.error(
        {
          err: err.message,
          workspaceId: ctx.workspaceId,
          position: err.position,
          norm: err.norm,
          requestId,
          ...fields,
        },
        `${verb.name} confirm refused: the workspace's alias vocabulary is half-rebuilt`,
      );
      return {
        ok: false,
        refusal: {
          status: 503,
          body: {
            error: "vocabulary_incomplete",
            message: copy.vocabularyIncomplete,
            requestId,
          },
        },
      };
    }
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        workspaceId: ctx.workspaceId,
        requestId,
        ...fields,
      },
      `${verb.name} confirm failed`,
    );
    return {
      ok: false,
      refusal: {
        status: 500,
        body: { error: "internal_error", message: copy.executeFailed, requestId },
      },
    };
  }
}
