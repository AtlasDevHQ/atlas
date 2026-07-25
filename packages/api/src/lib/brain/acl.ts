/**
 * The company brain's minimal per-fact/per-episode ACL (#4768, ADR-0036
 * §Access control & residency).
 *
 * Four things live here:
 *
 *   1. **The gated tables** — the tier-2/tier-3 targets this predicate may be
 *      composed onto.
 *   2. **The grant grammar** — `org | role:{owner,admin,member} | user:<id> |
 *      audience:<source-derived>` — parsed into a discriminated union.
 *   3. **Principal-set resolution** — turning a reader's identity into the set
 *      of tokens that grant them access, including live `audience:` membership.
 *   4. **`aclVisibilityClause`** — a FAIL-CLOSED, PUSH-DOWN SQL predicate.
 *      #4773's `searchBrain` ANDs it into its WHERE clause; it is never a
 *      post-fetch filter, because a post-fetch filter has already loaded the
 *      row it is about to hide, and every LIMIT above it counts rows the
 *      reader may not see.
 *
 * ## What this gates, and what it deliberately does not
 *
 * Tiers 2 and 3 only — `brain_facts` and `brain_episodes`. Tier-1 warehouse
 * facts are computed live through the semantic layer and gated by warehouse
 * RLS; double-gating them here would mean two systems that must agree about
 * the same row and will eventually not. `AclGatedTable` constrains the NAMED
 * target so a tier-1 table cannot be requested — note that it constrains the
 * name, not the emitted SQL, which is built from `alias`; an alias pointed at
 * some other relation produces a predicate that fails loudly at runtime (no
 * `visible_to` column) rather than one that quietly gates the wrong thing.
 *
 * ## Fail-closed, in both directions
 *
 * **Reader side** — a reader whose principal set cannot be resolved gets
 * `FALSE`, not "everything" and not "the public subset". Every reader-side
 * deny in this module is logged.
 *
 * **Stored side** — a malformed token (`everyone`, `team:eng`, `ROLE:admin`)
 * is invisible by CONSTRUCTION: the predicate is array overlap against the
 * reader's tokens, and no reader token is ever malformed, so a malformed grant
 * token can match nothing. That invariant is load-bearing and is why
 * `principalTokens` guards every arm on non-empty input. It also means the
 * parser can be permissive without being unsafe.
 *
 * Stored-side anomalies are logged only where a caller invokes
 * `logGrantAnomalies` on rows it already holds — see that function's comment
 * for why that is the only honest read-time seam a push-down predicate leaves
 * open. #4773 is expected to call it on its result set.
 *
 * ## The one thing that must never become stricter
 *
 * Migration 0180's `chk_brain_{facts,episodes}_grant_nonempty` accepts any
 * grant with at least one non-NULL, non-empty element. NOTHING here may reject
 * a grant that CHECK admits. A row Postgres legally stores but Atlas code
 * refuses is a workspace that cannot be migrated between regions — and the
 * failure surfaces at cutover, long after the offending row landed. So
 * `parseGrant` REPORTS malformed tokens and never throws, and this module has
 * no write-side validation at all. Structural validity stops at "has a usable
 * principal"; whether `everyone` is a MEANINGFUL principal is a read-time
 * deny, never an import rejection.
 *
 * The IMPORT-side counterpart is `grantProblem` in
 * `api/routes/admin-migrate.ts`, which is paired with the 0180 CHECK (not with
 * this parser) and must stay exactly as permissive as it. This module's parser
 * is deliberately stricter than both, and must never be hoisted to import time.
 */

import { ORG_ROLES, type AtlasRole, type AuthMode, type OrgRole } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("brain-acl");

// ══════════════════════════════════════════════════════════════════════
// ██  The gated tables
// ══════════════════════════════════════════════════════════════════════

/** The tier-2/3 tables this predicate may gate. Tier-1 is not spellable. */
export const ACL_GATED_TABLES = ["brain_facts", "brain_episodes"] as const;
export type AclGatedTable = (typeof ACL_GATED_TABLES)[number];

// ══════════════════════════════════════════════════════════════════════
// ██  The grant grammar
// ══════════════════════════════════════════════════════════════════════

/**
 * The `org`-wide principal, spelled out. ADR-0036's "the public majority
 * carries an explicit `[org]`" — "visible to everyone" is a stated grant, so
 * that a forgotten grant can never READ as public.
 */
export const ORG_PRINCIPAL = "org" as const;

/** Prefixes of the parameterised arms. Exported so writers format, not concat. */
export const ROLE_PREFIX = "role:" as const;
export const USER_PREFIX = "user:" as const;
export const AUDIENCE_PREFIX = "audience:" as const;

/** A parsed grant token. */
export type BrainPrincipal =
  | { readonly kind: "org" }
  | { readonly kind: "role"; readonly role: OrgRole }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "audience"; readonly audienceId: string };

/** Narrow an arbitrary string to an org role without a cast. */
function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Parse one grant token, or `null` if it is not in the grammar.
 *
 * Comparison is BYTE-EXACT and case-sensitive on purpose. The enforcement is
 * Postgres's `&&` operator over `text[]`, which is byte-exact; if this parser
 * lower-cased (or trimmed) while Postgres did not, `isVisibleTo` and
 * `aclVisibilityClause` would disagree about the same row. So `ROLE:admin` and
 * `org ` are malformed rather than helpfully coerced.
 *
 * The `<id>` arms accept ANY non-empty remainder. Better Auth ids and
 * source-derived audience ids have no shape this module is entitled to assume,
 * and a stricter pattern here would be exactly the "stricter than the CHECK"
 * failure the module header forbids.
 */
export function parsePrincipal(raw: string): BrainPrincipal | null {
  if (raw === ORG_PRINCIPAL) return { kind: "org" };
  if (raw.startsWith(ROLE_PREFIX)) {
    const role = raw.slice(ROLE_PREFIX.length);
    // `role:platform_admin` is malformed: platform roles are cross-tenant and
    // deliberately outside the grammar. ADR-0036 scopes the admin/audit
    // override to a region and admits no super-admin arm.
    return isOrgRole(role) ? { kind: "role", role } : null;
  }
  if (raw.startsWith(USER_PREFIX)) {
    const userId = raw.slice(USER_PREFIX.length);
    return userId.length > 0 ? { kind: "user", userId } : null;
  }
  if (raw.startsWith(AUDIENCE_PREFIX)) {
    const audienceId = raw.slice(AUDIENCE_PREFIX.length);
    return audienceId.length > 0 ? { kind: "audience", audienceId } : null;
  }
  return null;
}

/** Render a principal back to its stored token. Round-trips `parsePrincipal`. */
export function formatPrincipal(principal: BrainPrincipal): string {
  switch (principal.kind) {
    case "org":
      return ORG_PRINCIPAL;
    case "role":
      return `${ROLE_PREFIX}${principal.role}`;
    case "user":
      return `${USER_PREFIX}${principal.userId}`;
    case "audience":
      return `${AUDIENCE_PREFIX}${principal.audienceId}`;
  }
}

/**
 * What `parseGrant` found. Both halves matter; neither is an error.
 *
 * DISPLAY AND ANOMALY REPORTING ONLY. `principals` plays no part in
 * enforcement — a visibility question goes through `isVisibleTo` or the
 * predicate and nothing else. Hand-rolling `principals.some(p => p.kind ===
 * "role" && p.role === ctx.role)` looks right and silently drops the monotone
 * owner ⊇ admin ⊇ member implication that `impliedRoles` supplies.
 */
export interface ParsedGrant {
  readonly principals: readonly BrainPrincipal[];
  /**
   * Tokens outside the grammar, verbatim — except non-string elements (NULL,
   * `undefined`, anything a hand-edited import bundle smuggled in), which are
   * reported as `''` so the COUNT still reflects them. NULL and `''` elements
   * are both legal at rest: the CHECK requires one USABLE principal, not that
   * every element is usable.
   */
  readonly malformed: readonly string[];
}

/**
 * Parse a stored `visible_to` array. Never throws, never rejects.
 *
 * A grant that is entirely malformed yields `principals: []`, which grants
 * nobody anything — the deny is the RESULT, not an exception. That is the
 * whole shape of this module's contract with migration 0180: everything the
 * CHECK admits parses, and the ones that mean nothing simply match nothing.
 *
 * Accepts `readonly unknown[]` rather than `BrainGrant` because the caller is
 * usually holding a `text[]` straight off `pg`, where a NULL element arrives
 * as `null` and no type has narrowed it yet.
 */
export function parseGrant(grant: readonly unknown[]): ParsedGrant {
  const principals: BrainPrincipal[] = [];
  const malformed: string[] = [];
  for (const raw of grant) {
    if (typeof raw !== "string" || raw.length === 0) {
      malformed.push("");
      continue;
    }
    const principal = parsePrincipal(raw);
    if (principal) principals.push(principal);
    else malformed.push(raw);
  }
  return { principals, malformed };
}

/**
 * The logging half of "malformed grants deny + log".
 *
 * A push-down predicate cannot log the rows it excluded — it never sees them,
 * which is the point. So the seam is here: a caller that ALREADY holds a row
 * (the review surface, the exporter, `searchBrain`'s result set) passes its
 * grant through and any malformed token is surfaced. This costs nothing — no
 * extra fetch — and catches the case that actually matters in practice: a
 * grant like `['user:abc', 'everyone']` that PASSES the predicate on its valid
 * token while carrying a second one the author believed was doing something.
 *
 * Returns the parse so callers do not pay for it twice.
 */
export function logGrantAnomalies(
  grant: readonly unknown[],
  meta: {
    readonly table: AclGatedTable;
    readonly rowId: string;
    readonly workspaceId: string;
    readonly requestId?: string;
  },
): ParsedGrant {
  const parsed = parseGrant(grant);
  if (parsed.malformed.length > 0) {
    log.warn(
      {
        table: meta.table,
        rowId: meta.rowId,
        workspaceId: meta.workspaceId,
        requestId: meta.requestId,
        malformed: parsed.malformed,
        usablePrincipals: parsed.principals.length,
      },
      "brain ACL: grant contains tokens outside the grammar — they grant nobody access",
    );
  }
  return parsed;
}

// ══════════════════════════════════════════════════════════════════════
// ██  Principal-set resolution
// ══════════════════════════════════════════════════════════════════════

/**
 * A reader's resolved identity within one workspace.
 *
 * A DISCRIMINATED UNION rather than a flat record with an `origin` label,
 * because the three arms carry materially different obligations and the flat
 * shape made illegal combinations constructible. Specifically,
 * `{ origin: "unauthenticated-local", role: "owner" }` typechecked and earned
 * a full audit override — a workspace-wide grant bypass on a deployment that
 * has declared it has no identity at all.
 *
 *   - `authenticated` — a real identity. `userId` is non-null BY THE TYPE.
 *     `audienceIds` is a SNAPSHOT of as-of-now membership, read locally from
 *     `fact_audience_member` — never a live connector call (ADR-0036: grants
 *     are derived at ingest and immutable per fact version; membership is the
 *     live half and the revocation path, so it must be cheap enough to
 *     evaluate on every read).
 *   - `unauthenticated-local` — `auth: none`, where the deployment has
 *     DECLARED there is no identity to resolve. Granted the `org` principal
 *     ONLY, so anything deliberately narrowed to a role, user, or audience
 *     stays hidden even from the local operator. That is strictly narrower
 *     than what the rest of Atlas hands `none` mode, and intentionally so.
 *   - `unresolved` — an authenticated request whose identity could NOT be
 *     established. Denied outright. Distinct from `unauthenticated-local`
 *     because "there is no identity" and "there should have been an identity
 *     and there isn't" are opposite situations that must not share a path.
 */
export type BrainPrincipalContext =
  | {
      readonly origin: "authenticated";
      readonly workspaceId: string;
      readonly userId: string;
      /**
       * The reader's ORG role IN `workspaceId`. `null` for a reader with no org
       * membership and for a bare `platform_admin` — a platform role is not an
       * org role and confers no brain grant.
       */
      readonly role: OrgRole | null;
      readonly audienceIds: readonly string[];
    }
  | {
      readonly origin: "unauthenticated-local";
      readonly workspaceId: string;
      readonly userId: null;
      readonly role: null;
      readonly audienceIds: readonly [];
    }
  | {
      readonly origin: "unresolved";
      readonly workspaceId: string;
      readonly userId: null;
      readonly role: null;
      readonly audienceIds: readonly [];
    };

/**
 * The narrow slice of a database handle this module needs. Structurally
 * satisfied by `InternalPoolClient`, `pg.Pool`, and `pg.PoolClient`, so
 * callers pass their existing handle straight through — and tests pass a
 * literal, with no `mock.module()` and no top-level singleton to mutate.
 */
export interface AudienceMembershipReader {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * "Which audiences is this user in?" — the per-request expansion, served by
 * `idx_fact_audience_member_user`.
 *
 * The `workspace_id` predicate is the module's ONLY cross-tenant-sensitive
 * read: `audience_id` is explicitly not globally unique (two tenants both
 * minting `engineering` is normal), so a membership row leaking in from
 * another workspace would hand this reader a token that then matches their
 * OWN tenant's facts — a leak the visibility predicate's workspace containment
 * cannot catch, because the token is being applied inside the right tenant.
 */
export const AUDIENCE_MEMBERSHIP_SQL = `
  SELECT DISTINCT audience_id
    FROM fact_audience_member
   WHERE workspace_id = $1
     AND user_id = $2
` as const;

export interface ResolvePrincipalInput {
  readonly workspaceId: string;
  readonly mode: AuthMode;
  readonly userId: string | undefined;
  /**
   * The reader's role **in `workspaceId`** — i.e. the org-plugin `member.role`
   * for that org, as produced by `resolveEffectiveRole(userRole, userId,
   * workspaceId)` from `lib/auth/effective-role.ts`.
   *
   * NOT `getUserRole(user)` from `lib/auth/permissions.ts`. That helper
   * back-fills an auth-mode DEFAULT, and its `simple-key` default is `admin` —
   * so passing it would mint `role:admin` + `role:member` tokens AND
   * audit-override entitlement for every holder of a shared API key, out of
   * nothing. `AtlasUser.role` raw is safe; the defaulting helper is not.
   */
  readonly role: AtlasRole | undefined;
  /**
   * The org `role` was resolved against. Must equal `workspaceId`.
   *
   * `member.role` is per-org (#2890), so a `role` resolved against the
   * session's ACTIVE org while reading a DIFFERENT workspace would grant
   * `role:` tokens — and audit-override entitlement — derived from another
   * tenant. Naming the org here makes that mismatch detectable instead of
   * invisible; on mismatch the role grants are dropped and the event logged.
   */
  readonly roleResolvedForOrgId: string | undefined;
  /** Correlates this module's log lines with the originating request. */
  readonly requestId?: string;
}

/**
 * Resolve a reader's principal context, including live audience membership.
 *
 * Database failures PROPAGATE. Catching them and returning zero audiences
 * would be fail-closed in the narrow sense and wrong in every other one: it
 * silently downgrades a reader mid-incident and reports success while doing
 * it. The caller surfaces a 500 with a requestId, which is what a failed
 * authorization lookup deserves.
 */
export async function resolvePrincipalContext(
  db: AudienceMembershipReader,
  input: ResolvePrincipalInput,
): Promise<BrainPrincipalContext> {
  const { workspaceId, mode, userId, role, roleResolvedForOrgId, requestId } = input;

  // An exhaustive switch rather than `mode === "none"`, so a fifth AuthMode
  // forces a conscious decision instead of silently inheriting the
  // authenticated arm.
  switch (mode) {
    case "none":
      return {
        origin: "unauthenticated-local",
        workspaceId,
        userId: null,
        role: null,
        audienceIds: [],
      };
    case "simple-key":
    case "managed":
    case "byot":
      break;
    default: {
      log.warn(
        { workspaceId, mode, requestId },
        "brain ACL: unrecognised auth mode — reader identity is unresolvable",
      );
      return { origin: "unresolved", workspaceId, userId: null, role: null, audienceIds: [] };
    }
  }

  if (!userId) {
    // Authenticated mode with no user id should be unreachable — auth
    // middleware attaches one — so this is a bug signal, not a routine branch.
    // It resolves `unresolved`, which `aclVisibilityClause` denies outright:
    // returning the `org`-only context here would hand an unidentified caller
    // the workspace's public facts on the strength of a middleware bug.
    log.warn(
      { workspaceId, mode, requestId },
      "brain ACL: authenticated request carries no user id — principal set is unresolvable",
    );
    return { origin: "unresolved", workspaceId, userId: null, role: null, audienceIds: [] };
  }

  let orgRole: OrgRole | null = null;
  if (role !== undefined) {
    if (roleResolvedForOrgId !== workspaceId) {
      log.warn(
        { workspaceId, roleResolvedForOrgId, userId, requestId },
        "brain ACL: role was resolved against a different org than the read target — dropping role grants",
      );
    } else if (isOrgRole(role)) {
      orgRole = role;
    }
    // Anything else is a platform role (`platform_admin`), which is not an org
    // grant. Falls through as `null` — deliberately, not by omission.
  }

  const result = await db.query(AUDIENCE_MEMBERSHIP_SQL, [workspaceId, userId]);
  const audienceIds = result.rows
    .map((row) => (row as { audience_id?: unknown }).audience_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return { origin: "authenticated", workspaceId, userId, role: orgRole, audienceIds };
}

/**
 * Roles a reader with `role` satisfies, most-privileged first.
 *
 * Role matching is MONOTONE: an owner matches `role:owner`, `role:admin`, and
 * `role:member`. Exact-match was considered and rejected. `role:member` means
 * "at least a member" in every RBAC system anyone has used, and under exact
 * matching a fact granted to `role:member` would be invisible to the workspace
 * OWNER — a hole that reads as a bug every time it is hit, and that the ingest
 * deriver (#4771) could only avoid by remembering to enumerate all three arms
 * on every grant.
 *
 * The widening is bounded and has no leak case: owner ⊇ admin ⊇ member is the
 * same containment Atlas's own `auth/org-permissions.ts` role table already
 * spells out row by row, and every role a reader gains access through is one
 * they already outrank.
 */
export function impliedRoles(role: OrgRole): readonly OrgRole[] {
  switch (role) {
    case "owner":
      return ["owner", "admin", "member"];
    case "admin":
      return ["admin", "member"];
    case "member":
      return ["member"];
    default:
      // Unreachable through the type, reachable through a cast or a future
      // ORG_ROLES addition. Deny the role grants loudly rather than fall out
      // of the switch as `undefined` — which the caller's `for…of` would turn
      // into an unattributed `TypeError` from a security primitive.
      log.warn({ role }, "brain ACL: unknown org role — granting no role principals");
      return [];
  }
}

/**
 * The reader's grant tokens — the exact array the push-down predicate binds,
 * and the exact set `isVisibleTo` tests against. THE single place a reader's
 * access is derived, and therefore the single place it is denied.
 *
 * Returns `[]` (grants nothing) for an `unresolved` reader and for a context
 * with no workspace. `aclVisibilityClause` checks both again before calling
 * this so it can emit a specific log line for each, but the deny itself lives
 * here — a helper that skipped it would be a fail-open sibling of the
 * predicate, which is exactly the defect the review panel found in the first
 * cut of this module.
 *
 * Never contains `''` or a bare prefix. Two distinct hazards:
 *   - `ARRAY[''] && ARRAY['']` is TRUE in Postgres, and a stored `''` element
 *     is legal at rest, so an empty reader token would match a grant that
 *     grants nobody anything.
 *   - An unguarded `user:`/`audience:` arm emits the BARE PREFIX (`user:`),
 *     which `parsePrincipal` classifies as malformed — and a malformed reader
 *     token could raw-match a malformed STORED token, breaking the module
 *     header's load-bearing "no reader token is ever malformed" invariant.
 * Both are why every arm below is guarded, not tidiness.
 */
export function principalTokens(ctx: BrainPrincipalContext): readonly string[] {
  if (ctx.origin === "unresolved" || !ctx.workspaceId) return [];

  const tokens: string[] = [ORG_PRINCIPAL];
  if (ctx.origin !== "authenticated") return tokens;

  if (ctx.role) {
    for (const role of impliedRoles(ctx.role)) tokens.push(`${ROLE_PREFIX}${role}`);
  }
  if (ctx.userId) tokens.push(`${USER_PREFIX}${ctx.userId}`);
  for (const audienceId of ctx.audienceIds) {
    // Stored WITHOUT the prefix in `fact_audience_member` — the prefix belongs
    // to the grammar, not to the identity — so it is added here, once.
    if (audienceId.length > 0) tokens.push(`${AUDIENCE_PREFIX}${audienceId}`);
  }
  return tokens;
}

/** A row this module can answer a visibility question about. */
export interface AclGatedRow {
  readonly workspaceId: string;
  readonly visibleTo: readonly unknown[];
}

/**
 * In-memory mirror of the push-down predicate's grant-match arm: would `row`
 * be visible to `ctx`?
 *
 * Takes the ROW, not just its grant, so tenant containment is unskippable.
 * That is not ceremony: `aclVisibilityClause` emits `workspace_id = $n`
 * precisely because audience ids collide across tenants, and an earlier cut of
 * this helper took the bare grant — which made it answer TRUE for another
 * tenant's row, and for an `unresolved` reader the SQL denies outright. A
 * "mirror" that disagrees with the predicate in the permissive direction is
 * worse than no mirror, because callers trust it.
 *
 * Deliberately array-overlap-shaped rather than "parse then compare", because
 * the thing it must agree with is Postgres's `&&`. A parse-based mirror would
 * drift the moment the two disagreed about a token's shape.
 *
 * Does NOT model the audit override — an override read bypasses grants
 * entirely and must go through the predicate, not through this.
 *
 * NOT a substitute for the predicate. It answers a question about a row the
 * caller already holds; it cannot keep an unreadable row from being fetched,
 * and only the WHERE clause can.
 */
export function isVisibleTo(row: AclGatedRow, ctx: BrainPrincipalContext): boolean {
  if (row.workspaceId !== ctx.workspaceId) {
    log.warn(
      {
        rowWorkspaceId: row.workspaceId,
        readerWorkspaceId: ctx.workspaceId,
        origin: ctx.origin,
        userId: ctx.userId,
      },
      "brain ACL: visibility asked about a row outside the reader's workspace — denying",
    );
    return false;
  }
  const tokens = new Set(principalTokens(ctx));
  if (tokens.size === 0) return false;
  return row.visibleTo.some((token) => typeof token === "string" && tokens.has(token));
}

// ══════════════════════════════════════════════════════════════════════
// ██  The fail-closed push-down predicate
// ══════════════════════════════════════════════════════════════════════

/**
 * Why a clause is the shape it is. Observable so a caller can log it and a
 * test can assert the branch rather than pattern-matching SQL text.
 */
export type AclDecision =
  /** Normal path — workspace containment AND grant overlap. */
  | "grant-match"
  /** An entitled workspace admin's audit read. Workspace containment only. */
  | "audit-override"
  /** An override was requested by a reader not entitled to one. Falls back to `grant-match` SQL. */
  | "override-refused"
  /** No workspace, an unresolvable reader identity, or no usable principal. `(FALSE)`. */
  | "deny-all";

/**
 * A region- and workspace-scoped admin/audit read.
 *
 * ADR-0036 states the override is REGION-scoped ("no cross-region
 * super-admin"). Region scoping is by construction: the process IS the region
 * (ADR-0024), so there is no region to name. WORKSPACE scoping is this
 * module's own addition — it is not by construction, and it is enforced in the
 * emitted SQL.
 *
 * Entitlement is an `authenticated` reader with an org role of `owner` or
 * `admin`. A bare `platform_admin` is a platform operator, not a member of the
 * tenant, and gets nothing.
 */
export interface AclAuditOverride {
  /**
   * Why the override was invoked. Required, and an empty/whitespace reason is
   * REFUSED — an unexplained override is not one.
   *
   * Recorded verbatim in a structured `log.warn` from the `brain-acl` logger.
   * This is NOT written to the durable `audit_log` table; a caller that needs
   * a durable record must write one.
   */
  readonly reason: string;
}

export interface AclClauseOptions {
  /** Tier-2 or tier-3 target. Tier-1 warehouse facts are not gated here. */
  readonly table: AclGatedTable;
  /**
   * Table alias used in the caller's query. Defaults to the table name. Must
   * alias one of `ACL_GATED_TABLES` — it is what the emitted SQL references.
   */
  readonly alias?: string;
  /** 1-based index of the FIRST placeholder this clause may use. */
  readonly paramIndex: number;
  readonly override?: AclAuditOverride;
  /** Correlates this clause's log lines with the originating request. */
  readonly requestId?: string;
}

/**
 * A WHERE fragment plus the values it binds.
 *
 * A discriminated union on `decision` because the parameter ARITY VARIES by
 * branch, and the type has that information: a caller who switches on
 * `decision` gets the arity from the compiler instead of from a comment.
 * Regardless, advance your own placeholder counter by `params.length` and
 * never by a constant — Postgres rejects a bind that supplies more parameters
 * than the statement references, so guessing fails loudly, but it fails at
 * execution, which is late.
 *
 * `sql` is always parenthesised and carries no leading `AND`.
 */
export type AclClause =
  | { readonly decision: "deny-all"; readonly sql: string; readonly params: readonly [] }
  | {
      readonly decision: "audit-override";
      readonly sql: string;
      readonly params: readonly [workspaceId: string];
    }
  | {
      readonly decision: "grant-match" | "override-refused";
      readonly sql: string;
      readonly params: readonly [workspaceId: string, tokens: readonly string[]];
    };

/** A SQL identifier safe to interpolate as an alias. */
const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DENY_ALL: AclClause = { sql: "(FALSE)", params: [], decision: "deny-all" };

/**
 * The fail-closed, push-down visibility predicate. AND this into the WHERE
 * clause of any read over `brain_facts` or `brain_episodes`.
 *
 * ## Why it emits workspace containment too
 *
 * The clause is `workspace_id = $n AND visible_to && $m`, not the overlap
 * alone — even though every caller already scopes to a workspace. Audience ids
 * are workspace-scoped identities with no global uniqueness: two tenants can
 * both mint `audience:engineering`, and a reader in tenant A holding that
 * token would match tenant B's fact if this predicate were composed into a
 * query whose own workspace scoping was missing or was accidentally OR-ed.
 * Redundant tenant scoping inside a security predicate is the difference
 * between a primitive that is safe standalone and one that is safe only when
 * used correctly. Postgres folds the duplicate condition for free.
 *
 * ## Composition (ADR-0036 — four gates, AND-ed)
 *
 * This is ONE of four. The others are residency (invariant by construction —
 * the process is the region), org/group reach (ADR-0022), and content mode
 * (`draft`/`published`; `brain_facts` joins the registry in #4769). AND them;
 * never OR, and never substitute one for another.
 */
export function aclVisibilityClause(
  ctx: BrainPrincipalContext,
  options: AclClauseOptions,
): AclClause {
  const { table, paramIndex, override, requestId } = options;
  const alias = options.alias ?? table;

  if (!Number.isInteger(paramIndex) || paramIndex < 1) {
    throw new Error(
      `aclVisibilityClause: paramIndex must be a positive integer, got ${paramIndex}`,
    );
  }
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(
      `aclVisibilityClause: alias ${JSON.stringify(alias)} is not a plain SQL identifier`,
    );
  }

  // Both deny arms record whether an override was ATTEMPTED. An operator
  // reading "identity could not be resolved" must be able to tell that
  // somebody also tried to invoke a workspace-wide ACL bypass — attempted
  // privilege escalation is exactly the event you want in the log.
  const denyContext = {
    table,
    origin: ctx.origin,
    userId: ctx.userId,
    requestId,
    overrideRequested: !!override,
  };
  if (!ctx.workspaceId) {
    // No workspace means no tenant boundary to enforce, and a predicate with
    // no tenant boundary is worse than none at all.
    log.warn(denyContext, "brain ACL: principal context has no workspace — denying all rows");
    return DENY_ALL;
  }
  if (ctx.origin === "unresolved") {
    log.warn(
      { ...denyContext, workspaceId: ctx.workspaceId },
      "brain ACL: reader identity could not be resolved — denying all rows",
    );
    return DENY_ALL;
  }

  const workspaceClause = `${alias}.workspace_id = $${paramIndex}`;

  if (override) {
    const reason = override.reason.trim();
    const entitled =
      ctx.origin === "authenticated" &&
      !!ctx.userId &&
      (ctx.role === "owner" || ctx.role === "admin") &&
      reason.length > 0;
    const auditContext = {
      table,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      role: ctx.role,
      origin: ctx.origin,
      reason: override.reason,
      requestId,
    };
    if (entitled) {
      log.warn(
        auditContext,
        "brain ACL: audit override — per-grant visibility bypassed for this read",
      );
      return {
        sql: `(${workspaceClause})`,
        params: [ctx.workspaceId],
        decision: "audit-override",
      };
    }
    // Refused, not fatal: the reader still sees what their own grants allow.
    // Falling through to `grant-match` is not a widening, and blinding a
    // reader to their own facts because a caller over-asked would be a worse
    // failure than the over-ask itself. It is logged either way.
    log.warn(
      auditContext,
      "brain ACL: audit override refused — reader is not an authenticated workspace owner/admin with a stated reason; falling back to grant matching",
    );
  }

  const tokens = principalTokens(ctx);
  if (tokens.length === 0) {
    // Reachable whenever `principalTokens` denies — today that is exactly the
    // two arms handled above, so this is a backstop rather than a distinct
    // cause. It is written out anyway: `visible_to && ARRAY[]` is already
    // FALSE in Postgres, so the ROW-level outcome would be identical, but it
    // would be a silent, unlogged deny reported as `grant-match`. The explicit
    // arm exists to make the deny OBSERVABLE, not because the SQL would leak.
    log.warn(
      { table, workspaceId: ctx.workspaceId, userId: ctx.userId, origin: ctx.origin, requestId },
      "brain ACL: reader resolved to no principals — denying all rows",
    );
    return DENY_ALL;
  }

  return {
    sql: `(${workspaceClause} AND ${alias}.visible_to && $${paramIndex + 1}::text[])`,
    params: [ctx.workspaceId, tokens],
    decision: override ? "override-refused" : "grant-match",
  };
}
