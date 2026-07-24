/**
 * The company brain's minimal per-fact/per-episode ACL (#4768, ADR-0036
 * §Access control & residency).
 *
 * Three things live here, in dependency order:
 *
 *   1. **The grant grammar** — `org | role:{owner,admin,member} | user:<id> |
 *      audience:<source-derived>` — parsed into a discriminated union.
 *   2. **Principal-set resolution** — turning a reader's identity into the set
 *      of tokens that grant them access, including live `audience:` membership.
 *   3. **`aclVisibilityClause`** — a FAIL-CLOSED, PUSH-DOWN SQL predicate.
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
 * the same row and will eventually not. `AclGatedTable` makes that a
 * compile-time fact rather than a comment: there is no way to spell a tier-1
 * target in a call to `aclVisibilityClause`.
 *
 * ## Fail-closed, in both directions
 *
 * **Reader side** — a reader whose principal set cannot be resolved gets
 * `FALSE`, not "everything" and not "the public subset". Every deny is logged.
 *
 * **Stored side** — a malformed token (`everyone`, `team:eng`, `ROLE:admin`)
 * is invisible by CONSTRUCTION: the predicate is array overlap against the
 * reader's tokens, and no reader token is ever malformed, so a malformed grant
 * token can match nothing. That is why the parser can be permissive without
 * being unsafe. The logging half of "deny + log" is `logGrantAnomalies`, which
 * callers apply to rows they already hold — see its own doc comment for why
 * that is the only honest read-time seam a push-down predicate leaves open.
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
 * deny, never an import rejection. `grantProblem` in `api/routes/admin-migrate.ts`
 * is the mirrored guard on the import side — the two are a matched pair and
 * move together.
 */

import { ORG_ROLES, type AtlasRole, type AuthMode, type OrgRole } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("brain-acl");

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

const ORG_ROLE_SET: ReadonlySet<string> = new Set(ORG_ROLES);

/**
 * Parse one grant token, or `null` if it is not in the grammar.
 *
 * Comparison is BYTE-EXACT and case-sensitive on purpose. The enforcement is
 * Postgres's `&&` operator over `text[]`, which is byte-exact; if this parser
 * lower-cased (or trimmed) while Postgres did not, `isVisibleTo` and
 * `aclVisibilityClause` would disagree about the same row — and the in-memory
 * mirror exists precisely to be trustworthy about what the SQL will do. So
 * `ROLE:admin` and `org ` are malformed rather than helpfully coerced.
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
    // deliberately outside the grammar (ADR-0036 — admin/audit override is
    // region- and workspace-scoped, there is no super-admin arm).
    return ORG_ROLE_SET.has(role) ? { kind: "role", role: role as OrgRole } : null;
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

/** What `parseGrant` found. Both halves matter; neither is an error. */
export interface ParsedGrant {
  readonly principals: readonly BrainPrincipal[];
  /**
   * Tokens outside the grammar, verbatim. NULL and `''` elements — both legal
   * at rest under the CHECK, which only requires ONE usable principal — are
   * reported here as the empty string so a caller counting anomalies sees them.
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
  meta: { readonly table: AclGatedTable; readonly rowId: string; readonly workspaceId: string },
): ParsedGrant {
  const parsed = parseGrant(grant);
  if (parsed.malformed.length > 0) {
    log.warn(
      {
        table: meta.table,
        rowId: meta.rowId,
        workspaceId: meta.workspaceId,
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

/** The tier-2/3 tables this predicate may gate. Tier-1 is not spellable. */
export const ACL_GATED_TABLES = ["brain_facts", "brain_episodes"] as const;
export type AclGatedTable = (typeof ACL_GATED_TABLES)[number];

/**
 * A reader's resolved identity within one workspace.
 *
 * `audienceIds` is a SNAPSHOT of as-of-now membership, read locally from
 * `fact_audience_member` — never a live connector call (ADR-0036: grants are
 * derived at ingest and immutable per fact version; membership is the live
 * half, and it is the revocation path, so it must be cheap enough to evaluate
 * on every read).
 */
export interface BrainPrincipalContext {
  readonly workspaceId: string;
  /** `null` when the deployment has no authenticated identity (`auth: none`). */
  readonly userId: string | null;
  /**
   * The reader's ORG role. `null` for `auth: none`, for a reader with no org
   * membership, and for a bare `platform_admin` — a platform role is not an
   * org role and confers no brain grant.
   */
  readonly role: OrgRole | null;
  readonly audienceIds: readonly string[];
  /**
   * How this context came to be.
   *
   * `unauthenticated-local` is `auth: none`, where the deployment has DECLARED
   * there is no identity to resolve. It is granted the `org` principal ONLY,
   * so anything deliberately narrowed to a role, user, or audience stays
   * hidden even from the local operator. That is strictly narrower than what
   * the rest of Atlas hands `none` mode, and intentionally so.
   *
   * `unresolved` is the failure arm — an authenticated request whose identity
   * could not be established. `aclVisibilityClause` denies it outright.
   * Distinct from `unauthenticated-local` because "there is no identity" and
   * "there should have been an identity and there isn't" are opposite
   * situations that would otherwise share a code path.
   */
  readonly origin: "authenticated" | "unauthenticated-local" | "unresolved";
}

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
 */
export const AUDIENCE_MEMBERSHIP_SQL = `
  SELECT audience_id
    FROM fact_audience_member
   WHERE workspace_id = $1
     AND user_id = $2
` as const;

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
  input: {
    readonly workspaceId: string;
    readonly mode: AuthMode;
    readonly userId: string | undefined;
    readonly role: AtlasRole | undefined;
  },
): Promise<BrainPrincipalContext> {
  const { workspaceId, mode, userId, role } = input;

  if (mode === "none") {
    return {
      workspaceId,
      userId: null,
      role: null,
      audienceIds: [],
      origin: "unauthenticated-local",
    };
  }

  // A platform role is not an org role; `AtlasUser.role` spans both surfaces.
  const orgRole = role !== undefined && ORG_ROLE_SET.has(role) ? (role as OrgRole) : null;

  if (!userId) {
    // Authenticated mode with no user id should be unreachable — auth
    // middleware attaches one — so this is a bug signal, not a routine branch.
    // It resolves `unresolved`, which `aclVisibilityClause` denies outright:
    // returning the `org`-only context here would hand an unidentified caller
    // the workspace's public facts on the strength of a middleware bug.
    log.warn(
      { workspaceId, mode },
      "brain ACL: authenticated request carries no user id — principal set is unresolvable",
    );
    return { workspaceId, userId: null, role: orgRole, audienceIds: [], origin: "unresolved" };
  }

  const result = await db.query(AUDIENCE_MEMBERSHIP_SQL, [workspaceId, userId]);
  const audienceIds = result.rows
    .map((row) => (row as { audience_id?: unknown }).audience_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return { workspaceId, userId, role: orgRole, audienceIds, origin: "authenticated" };
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
 * same containment Atlas's own `org-permissions.ts` role table already spells
 * out row by row, and every role a reader gains access through is one they
 * already outrank.
 */
export function impliedRoles(role: OrgRole): readonly OrgRole[] {
  switch (role) {
    case "owner":
      return ["owner", "admin", "member"];
    case "admin":
      return ["admin", "member"];
    case "member":
      return ["member"];
  }
}

/**
 * The reader's grant tokens — the exact array the push-down predicate binds,
 * and the exact set `isVisibleTo` tests against.
 *
 * Never contains `''`: `ARRAY[''] && ARRAY['']` is TRUE in Postgres, so an
 * empty reader token would match a stored `''` element that migration 0180
 * explicitly tolerates (the CHECK requires one USABLE principal, not that
 * every element is usable). Every arm below is guarded on non-empty input for
 * that reason, not for tidiness.
 */
export function principalTokens(ctx: BrainPrincipalContext): readonly string[] {
  const tokens: string[] = [ORG_PRINCIPAL];
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

/**
 * In-memory mirror of the push-down predicate: would `grant` be visible to
 * `ctx`?
 *
 * Deliberately array-overlap-shaped rather than "parse then compare", because
 * the thing it must agree with is Postgres's `&&`. A parse-based mirror would
 * drift the moment the two disagreed about a token's shape — which is exactly
 * the drift the SQL/mirror parity test exists to catch.
 *
 * NOT a substitute for the predicate. It answers a question about a row the
 * caller already holds (a review surface, a test, an assertion); it cannot
 * keep an unreadable row from being fetched, and only the WHERE clause can.
 */
export function isVisibleTo(grant: readonly unknown[], ctx: BrainPrincipalContext): boolean {
  const tokens = new Set(principalTokens(ctx));
  return grant.some((token) => typeof token === "string" && tokens.has(token));
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
  /** No usable principal. `FALSE`. */
  | "deny-all";

/**
 * A region- and workspace-scoped admin/audit read (ADR-0036: "admin/audit
 * override is region-scoped — no cross-region super-admin").
 *
 * Region scoping is by construction: the process IS the region (ADR-0024), so
 * there is no region to name. Workspace scoping is NOT by construction and is
 * enforced in the emitted SQL. Entitlement is the reader's ORG role being
 * `owner` or `admin` — a bare `platform_admin` is a platform operator, not a
 * member of the tenant, and gets nothing.
 */
export interface AclAuditOverride {
  /** Recorded verbatim in the audit log line. Required — an unexplained override is not one. */
  readonly reason: string;
  /** Correlates the log line with the originating request. */
  readonly requestId?: string;
}

export interface AclClauseOptions {
  /** Tier-2 or tier-3 target. Tier-1 warehouse facts are not gated here. */
  readonly table: AclGatedTable;
  /** Table alias used in the caller's query. Defaults to the table name. */
  readonly alias?: string;
  /** 1-based index of the FIRST placeholder this clause may use. */
  readonly paramIndex: number;
  readonly override?: AclAuditOverride;
}

export interface AclClause {
  /** WHERE fragment, already parenthesised. No leading `AND`. */
  readonly sql: string;
  /**
   * Values for `$paramIndex … $(paramIndex + params.length - 1)`, in order.
   *
   * The LENGTH VARIES BY DECISION — 2 for `grant-match`/`override-refused`,
   * 1 for `audit-override`, 0 for `deny-all`. Callers must advance their own
   * placeholder counter by `params.length` and never by a hardcoded number;
   * Postgres rejects a bind that supplies more parameters than the statement
   * references, so guessing fails loudly rather than silently — but it fails
   * at execution, which is late.
   */
  readonly params: readonly unknown[];
  readonly decision: AclDecision;
}

/** A SQL identifier safe to interpolate as an alias. */
const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const { table, paramIndex, override } = options;
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
  if (!ctx.workspaceId) {
    // No workspace means no tenant boundary to enforce, and a predicate with
    // no tenant boundary is worse than none at all.
    log.warn(
      { table, origin: ctx.origin },
      "brain ACL: principal context has no workspace — denying all rows",
    );
    return { sql: "FALSE", params: [], decision: "deny-all" };
  }
  if (ctx.origin === "unresolved") {
    log.warn(
      { table, workspaceId: ctx.workspaceId },
      "brain ACL: reader identity could not be resolved — denying all rows",
    );
    return { sql: "FALSE", params: [], decision: "deny-all" };
  }

  const workspaceClause = `${alias}.workspace_id = $${paramIndex}`;

  if (override) {
    const entitled = ctx.role === "owner" || ctx.role === "admin";
    if (entitled) {
      log.warn(
        {
          table,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          role: ctx.role,
          reason: override.reason,
          requestId: override.requestId,
        },
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
      {
        table,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        role: ctx.role,
        reason: override.reason,
        requestId: override.requestId,
      },
      "brain ACL: audit override refused — reader is not a workspace owner/admin; falling back to grant matching",
    );
  }

  const tokens = principalTokens(ctx);
  if (tokens.length === 0) {
    // Unreachable today — `principalTokens` always seeds `org` — but the deny
    // arm is written out rather than assumed, because "the token set can never
    // be empty" is exactly the kind of invariant a later edit quietly breaks,
    // and `visible_to && ARRAY[]` would then silently become the fail-OPEN
    // shape's near neighbour.
    log.warn(
      { table, workspaceId: ctx.workspaceId, userId: ctx.userId, origin: ctx.origin },
      "brain ACL: reader resolved to no principals — denying all rows",
    );
    return { sql: "FALSE", params: [], decision: "deny-all" };
  }

  return {
    sql: `(${workspaceClause} AND ${alias}.visible_to && $${paramIndex + 1}::text[])`,
    params: [ctx.workspaceId, tokens],
    decision: override ? "override-refused" : "grant-match",
  };
}
