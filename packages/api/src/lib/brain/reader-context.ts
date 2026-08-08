/**
 * Turning a request's identity into a brain reader's principal context —
 * once, for every brain read surface (#4773, ADR-0036 §Access control).
 *
 * `resolvePrincipalContext` in `acl.ts` is the primitive; it takes an already-
 * resolved role and expands audience membership. This module is the layer
 * above it: the part that has to RE-RESOLVE the role against the workspace
 * being read, and that has to notice when that re-resolution failed.
 *
 * ## Why the role has to be re-resolved at all
 *
 * `member.role` is per-org (#2890). A role carried on the session was resolved
 * against the session's ACTIVE org, and `resolvePrincipalContext` drops role
 * grants outright when the two disagree — correct, but it means a caller that
 * hands over a stale role silently loses every `role:`-granted row. So the
 * role is re-resolved here against the workspace actually being read, and
 * handed down with its `orgId` attached.
 *
 * ## Two failures, opposite directions, both invisible by default
 *
 * `resolveEffectiveRole` CATCHES member-table failures and returns `undefined`
 * — by design, so its own callers fail closed to least privilege (a DB blip
 * bounces an org admin out of the console rather than over-granting).
 *
 * For a reader that turns the role into ACL GRANTS, that catch is a **silent
 * partial narrowing**. Losing the role drops the reader's `role:` tokens while
 * leaving the context `authenticated`: `aclVisibilityClause` still returns
 * `grant-match`, no deny fires, `BrainReaderUnresolvedError` never throws — and
 * every fact granted only to `role:admin` / `role:member` vanishes. Every
 * surface stays self-consistent, so the incident is invisible from all of them:
 * a smaller, entirely plausible answer. Critically, the obvious guard —
 * "did the session carry a role we then failed to re-resolve?" — does NOT
 * work: `AtlasUser.role` can be absent, and a session-time member-table failure
 * is one of the things that erases it — so the guard is blindest in precisely
 * the case it exists for.
 * So this module calls {@link resolveEffectiveRoleStrict}, which propagates the
 * lookup failure instead of encoding it as `undefined`, and converts it to
 * {@link BrainRoleUnresolvedError}.
 *
 * The opposite failure is a **widening**, and it is the one a reader is most
 * likely to get wrong. `resolveEffectiveRole`'s no-member-row arm returns the
 * caller's SESSION role verbatim. Stamping that role with
 * `orgId: workspaceId` would tell `resolvePrincipalContext` it was resolved
 * against the workspace being read — defeating its cross-org mismatch check —
 * and mint `role:` tokens in a workspace the reader is not a member of. So the
 * role is forwarded ONLY when `fromMemberRow` says it came from this org's
 * `member` row; otherwise role grants are dropped and the event logged.
 *
 * Both halves fall out of asking ONE narrow question — "what is this user's
 * role in this workspace's `member` table?" — with the session role
 * deliberately not passed in. A bare `platform_admin` therefore grants nothing
 * (correct: a cross-tenant platform role is not an org role, and `acl.ts` says
 * the same), while a platform admin who genuinely holds `member.role = 'admin'`
 * in this workspace keeps that grant rather than losing it to a short-circuit
 * that never consulted the table.
 */

import {
  MemberRoleLookupError,
  resolveEffectiveRoleStrict,
  type EffectiveRoleResolution,
} from "@atlas/api/lib/auth/effective-role";
import { createLogger } from "@atlas/api/lib/logger";
import {
  resolvePrincipalContext,
  type AudienceMembershipReader,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { AtlasRole, AtlasUser } from "@atlas/api/lib/auth/types";
import type { AuthMode } from "@useatlas/types";

const log = createLogger("brain-reader-context");

/**
 * Base for every "this reader's identity is broken" failure.
 *
 * Exists so a consumer can write ONE `instanceof` instead of enumerating the
 * subclasses. The enumeration was the bug waiting to happen: `searchBrain` maps
 * these to a `forbidden` refusal and everything else to a generic
 * "search failed", so a third identity failure added here would silently fall
 * into the generic arm and reach an MCP agent as `internal_error` — quietly
 * un-doing the guarantee this module exists to provide.
 */
export class BrainReaderIdentityError extends Error {}

/** Closed diagnostic vocabulary for which surface refused a read. */
export type BrainReadSurface =
  | "read"
  | "review"
  | "search"
  | "oversight"
  | "correction"
  /**
   * The Claim Vocabulary blast-radius preview (#5086). Its own member rather
   * than reusing `"oversight"`: both modules refuse with this class, and one
   * shared literal made the two messages byte-identical — so an operator could
   * not tell the publish preview from the counterfactual preview, which are two
   * different fixes. Diagnostics only, never branched on.
   */
  | "vocabulary-preview";

/**
 * The reader's identity could not be turned into a usable principal set, so
 * `aclVisibilityClause` returned `deny-all`.
 *
 * Thrown rather than answered with an empty result set, which is the whole
 * point. `principalTokens` seeds `org` unconditionally for both `authenticated`
 * and `unauthenticated-local` readers, so `deny-all` is reachable ONLY from an
 * `unresolved` origin, a missing `workspaceId`, or an origin arriving through a
 * cast — every one of which is an upstream defect, not a reader who happens to
 * be entitled to nothing.
 *
 * The failure this prevents, per surface: on the review queue, an auth
 * regression drops the session user, the reassuring "Nothing to review" empty
 * state renders, and the reviewer clicks publish on a workspace of unreviewed
 * drafts. On `searchBrain`, the agent is told the company brain holds nothing
 * about the subject and answers from the model's priors instead. Both are worse
 * than a 500 with a requestId; `resolvePrincipalContext` gives the same
 * reasoning for propagating its own lookup failures rather than degrading.
 *
 * Lives here rather than beside either consumer because it is a statement about
 * READER IDENTITY, which is this module's subject — and because two surfaces
 * throwing structurally identical errors from two files is how they drift into
 * being caught differently.
 */
export class BrainReaderUnresolvedError extends BrainReaderIdentityError {
  constructor(
    readonly workspaceId: string,
    readonly origin: BrainPrincipalContext["origin"],
    /** Which read surface refused. Diagnostics only — never branched on. */
    readonly surface: BrainReadSurface = "read",
  ) {
    super(
      `brain ${surface}: reader identity resolved to no usable principals (workspace ${workspaceId}, origin ${origin}) — refusing to serve an empty result set`,
    );
    this.name = "BrainReaderUnresolvedError";
  }
}

/**
 * The reader's org role could not be re-resolved against the workspace being
 * read, because the member-table lookup FAILED.
 *
 * Thrown rather than degraded — see the module header. Distinct from
 * {@link BrainReaderUnresolvedError}, which covers the reader who resolved to
 * NO principals at all: that one is detectable from the clause decision, this
 * one is invisible there by construction.
 */
export class BrainRoleUnresolvedError extends BrainReaderIdentityError {
  constructor(
    readonly workspaceId: string,
    readonly userId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `brain read: the org-role lookup for workspace ${workspaceId} failed (user ${userId}) — refusing to serve a result set narrowed by a failed role lookup`,
      options,
    );
    this.name = "BrainRoleUnresolvedError";
  }
}

export interface BrainReaderContextInput {
  readonly workspaceId: string;
  readonly mode: AuthMode;
  /** The request's authenticated user, or `undefined` in `auth: none` mode. */
  readonly user: AtlasUser | undefined;
  readonly requestId?: string;
}

/**
 * Resolve a brain reader's principal context for one workspace.
 *
 * @throws {BrainRoleUnresolvedError} when the member-table lookup fails — a
 *   silent ACL narrowing if left unreported.
 */
export async function resolveBrainReaderContext(
  db: AudienceMembershipReader,
  input: BrainReaderContextInput,
): Promise<BrainPrincipalContext> {
  const { workspaceId, mode, user, requestId } = input;
  const userId = user?.id;

  // `none` short-circuits BEFORE the lookup. `resolvePrincipalContext` discards
  // the role entirely in that mode (the context is `unauthenticated-local`), so
  // running it could only produce an avoidable hard failure — refusing a read
  // over a role nothing was going to use.
  if (mode === "none") {
    return resolvePrincipalContext(db, {
      workspaceId,
      mode,
      userId,
      resolvedRole: undefined,
      requestId,
    });
  }

  let resolvedRole: { role: AtlasRole; orgId: string } | undefined;
  if (userId) {
    let resolution: EffectiveRoleResolution;
    try {
      // `undefined` for the session role, DELIBERATELY. This module wants one
      // answer — "what is this user's role in THIS workspace's member table" —
      // and passing the session role would give the resolver two other ways to
      // answer: `platform_admin` short-circuits before the lookup, and a
      // no-member-row falls back to whatever the session carried. Both would
      // arrive as a role we then have to decide not to trust. Asking the
      // narrow question directly means `fromMemberRow` is the only outcome
      // that can grant anything, and a platform admin who genuinely holds
      // `member.role = 'admin'` here keeps that grant instead of losing it to
      // the short-circuit.
      resolution = await resolveEffectiveRoleStrict(undefined, userId, workspaceId);
    } catch (err) {
      if (err instanceof MemberRoleLookupError) {
        throw new BrainRoleUnresolvedError(workspaceId, userId, { cause: err });
      }
      throw err;
    }
    if (resolution.fromMemberRow && resolution.role) {
      resolvedRole = { role: resolution.role, orgId: workspaceId };
    } else if (resolution.role) {
      // Reachable only if the resolver gains another non-member-row arm — this
      // module passes no session role, so today the fallback has nothing to
      // fall back TO. Forwarding such a role stamped `orgId: workspaceId` would
      // assert to `resolvePrincipalContext` that it was resolved against this
      // workspace, defeating its cross-org mismatch check. Dropped, and logged:
      // a reader who expected `role:` visibility and does not have it should be
      // explicable from the logs.
      log.warn(
        { workspaceId, userId, role: resolution.role, requestId },
        "brain read: reader's role did not come from this workspace's member row — dropping role grants",
      );
    }
  }

  return resolvePrincipalContext(db, { workspaceId, mode, userId, resolvedRole, requestId });
}
