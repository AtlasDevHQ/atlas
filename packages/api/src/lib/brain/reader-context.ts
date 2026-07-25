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
 * ## The failure this exists to catch
 *
 * `resolveEffectiveRole` returns `undefined` for BOTH "no member row" and "the
 * member lookup threw" — it catches by design, so its original callers fail
 * closed to least privilege (a DB blip bounces an org admin out of the console
 * rather than over-granting).
 *
 * For a brain reader that same behavior is a SILENT PARTIAL ACL DEGRADATION.
 * Losing the role drops the reader's `role:` tokens while leaving the context
 * `authenticated`: `aclVisibilityClause` still returns `grant-match`, no deny
 * fires, `BrainReaderUnresolvedError` never throws — and every fact granted
 * only to `role:admin` / `role:member` vanishes from the result set. The
 * surfaces stay self-consistent, so the incident is invisible from any of
 * them: a smaller, entirely plausible answer.
 *
 * Hence {@link BrainRoleUnresolvedError}. A session that carries a workspace
 * role and cannot have it re-resolved is an anomaly, not a routine branch, and
 * the honest answer is a 500 with a requestId — the same reasoning
 * `resolvePrincipalContext` gives for propagating its own audience-lookup
 * failures rather than degrading quietly.
 *
 * `platform_admin` is exempt: it is a cross-tenant platform role that
 * short-circuits before the member lookup and confers no org grant either way,
 * so its absence from the member table is expected rather than anomalous.
 */

import { resolveEffectiveRole } from "@atlas/api/lib/auth/effective-role";
import {
  resolvePrincipalContext,
  type AudienceMembershipReader,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { AtlasRole, AtlasUser } from "@atlas/api/lib/auth/types";
import type { AuthMode } from "@useatlas/types";

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
export class BrainReaderUnresolvedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly origin: BrainPrincipalContext["origin"],
    /** Which read surface refused. Diagnostics only — never branched on. */
    readonly surface = "read",
  ) {
    super(
      `brain ${surface}: reader identity resolved to no usable principals (workspace ${workspaceId}, origin ${origin}) — refusing to serve an empty result set`,
    );
    this.name = "BrainReaderUnresolvedError";
  }
}

/**
 * The reader's org role could not be re-resolved against the workspace being
 * read, for a session that demonstrably carries one.
 *
 * Thrown rather than degraded — see the module header. Distinct from
 * {@link BrainReaderUnresolvedError}, which covers the reader who resolved to
 * NO principals at all: that one is detectable from the clause decision, this
 * one is invisible there by construction.
 */
export class BrainRoleUnresolvedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly sessionRole: AtlasRole,
  ) {
    super(
      `brain read: could not re-resolve the reader's org role for workspace ${workspaceId} (session role ${sessionRole}) — refusing to serve a result set narrowed by a failed role lookup`,
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
 * @throws {BrainRoleUnresolvedError} when a session carrying a workspace role
 *   cannot have it re-resolved — a silent ACL narrowing if left unreported.
 */
export async function resolveBrainReaderContext(
  db: AudienceMembershipReader,
  input: BrainReaderContextInput,
): Promise<BrainPrincipalContext> {
  const { workspaceId, mode, user, requestId } = input;
  const userId = user?.id;

  let resolvedRole: AtlasRole | undefined;
  if (userId) {
    resolvedRole = await resolveEffectiveRole(user?.role, userId, workspaceId);
    if (!resolvedRole && user?.role && user.role !== "platform_admin") {
      throw new BrainRoleUnresolvedError(workspaceId, user.role);
    }
  }

  return resolvePrincipalContext(db, {
    workspaceId,
    mode,
    userId,
    resolvedRole: resolvedRole ? { role: resolvedRole, orgId: workspaceId } : undefined,
    requestId,
  });
}
