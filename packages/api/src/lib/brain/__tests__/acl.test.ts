/**
 * Unit coverage for the brain ACL grammar, principal resolution, and the
 * fail-closed push-down predicate (#4768, ADR-0036 §Access control).
 *
 * Three files cover this module, because it makes three separable claims:
 *   - this one pins the DECISIONS (which branch fires, what SQL comes out);
 *   - `acl-visibility-pg.test.ts` pins what that SQL actually SELECTS against
 *     real Postgres, and that `isVisibleTo` agrees with `&&` token for token;
 *   - `acl-logging.test.ts` pins that every deny and every override is
 *     LOGGED — "deny + log" is the acceptance criterion, and the log half is
 *     otherwise deletable without a single test going red.
 */

import { describe, expect, it } from "bun:test";
import {
  ACL_GATED_TABLES,
  AUDIENCE_PREFIX,
  ORG_PRINCIPAL,
  ROLE_PREFIX,
  AUDIENCE_MEMBERSHIP_SQL,
  DEFAULT_AUDIENCE_MAX_STALENESS_HOURS,
  USER_PREFIX,
  aclVisibilityClause,
  getAudienceMaxStalenessSeconds,
  formatPrincipal,
  impliedRoles,
  isVisibleTo,
  logGrantAnomalies,
  parseGrant,
  parsePrincipal,
  principalTokens,
  resolvePrincipalContext,
  type AudienceMembershipReader,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";

const WS = "ws-acl-test";

type AuthedContext = Extract<BrainPrincipalContext, { origin: "authenticated" }>;

/** An authenticated reader. The default arm — most tests want this. */
function ctx(partial: Partial<AuthedContext> = {}): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    ...partial,
  };
}

/** `auth: none` — the deployment has declared there is no identity. */
function localCtx(workspaceId = WS): BrainPrincipalContext {
  return {
    origin: "unauthenticated-local",
    workspaceId,
    userId: null,
    role: null,
    audienceIds: [],
  };
}

/** An authenticated request whose identity could not be established. */
function unresolvedCtx(workspaceId = WS): BrainPrincipalContext {
  return { origin: "unresolved", workspaceId, userId: null, role: null, audienceIds: [] };
}

/** A row in `ctx`'s own workspace unless told otherwise. */
function row(visibleTo: readonly unknown[], workspaceId = WS) {
  return { table: "brain_facts", workspaceId, visibleTo } as const;
}

describe("grant grammar (#4768)", () => {
  it("parses each arm of `org | role:… | user:… | audience:…`", () => {
    expect(parsePrincipal("org")).toEqual({ kind: "org" });
    expect(parsePrincipal("role:owner")).toEqual({ kind: "role", role: "owner" });
    expect(parsePrincipal("role:admin")).toEqual({ kind: "role", role: "admin" });
    expect(parsePrincipal("role:member")).toEqual({ kind: "role", role: "member" });
    expect(parsePrincipal("user:abc123")).toEqual({ kind: "user", userId: "abc123" });
    expect(parsePrincipal("audience:eng-leads")).toEqual({
      kind: "audience",
      audienceId: "eng-leads",
    });
  });

  it("round-trips every parsed principal back to its stored token", () => {
    for (const token of ["org", "role:owner", "user:u-1", "audience:a-1"]) {
      const parsed = parsePrincipal(token);
      expect(parsed).not.toBeNull();
      expect(formatPrincipal(parsed!)).toBe(token);
    }
  });

  it("rejects tokens outside the grammar without throwing", () => {
    // `everyone` is THE canonical malformed grant: it reads as public and
    // grants nobody. ADR-0036 requires an explicit `org` instead.
    expect(parsePrincipal("everyone")).toBeNull();
    expect(parsePrincipal("team:eng")).toBeNull();
    expect(parsePrincipal("")).toBeNull();
    expect(parsePrincipal("role:")).toBeNull();
    expect(parsePrincipal("user:")).toBeNull();
    expect(parsePrincipal("audience:")).toBeNull();
  });

  it("refuses `role:platform_admin` — a platform role is not an org grant", () => {
    expect(parsePrincipal("role:platform_admin")).toBeNull();
  });

  it("is byte-exact: no case folding, no trimming", () => {
    // Enforcement is Postgres's `&&`, which is byte-exact. A parser that
    // helpfully normalised here would disagree with the SQL about the same
    // row — and `isVisibleTo` exists to be trusted about what the SQL does.
    expect(parsePrincipal("ORG")).toBeNull();
    expect(parsePrincipal("Org")).toBeNull();
    expect(parsePrincipal(" org")).toBeNull();
    expect(parsePrincipal("org ")).toBeNull();
    expect(parsePrincipal("ROLE:admin")).toBeNull();
  });

  it("accepts any non-empty id — never stricter than the 0180 CHECK", () => {
    // Better Auth ids and source-derived audience ids have no shape this
    // module may assume. A stricter pattern would make a workspace Postgres
    // legally stores impossible to migrate between regions.
    for (const id of ["u", "a-b_c.d", "01HZY9", "user:with:colons", "  spaced  ", "🙂"]) {
      expect(parsePrincipal(`${USER_PREFIX}${id}`)).toEqual({ kind: "user", userId: id });
      expect(parsePrincipal(`${AUDIENCE_PREFIX}${id}`)).toEqual({
        kind: "audience",
        audienceId: id,
      });
    }
  });
});

describe("parseGrant (#4768)", () => {
  it("splits usable principals from malformed tokens", () => {
    const parsed = parseGrant(["org", "everyone", "user:u1", "role:nope"]);
    expect(parsed.principals).toEqual([{ kind: "org" }, { kind: "user", userId: "u1" }]);
    expect(parsed.malformed).toEqual(["everyone", "role:nope"]);
  });

  it("reports NULL and '' elements as malformed rather than dropping them", () => {
    // Both are legal at rest: `chk_brain_facts_grant_nonempty` requires ONE
    // usable principal, not that every element is usable. So a grant can
    // arrive off `pg` with a null in it and must still parse.
    const parsed = parseGrant(["org", null, "", undefined]);
    expect(parsed.principals).toEqual([{ kind: "org" }]);
    expect(parsed.malformed).toEqual(["", "", ""]);
  });

  it("never throws on an entirely malformed grant — the deny is the result", () => {
    const parsed = parseGrant(["everyone", "public", ""]);
    expect(parsed.principals).toEqual([]);
    expect(parsed.malformed).toHaveLength(3);
  });

  it("logGrantAnomalies returns the parse and is a no-op on a clean grant", () => {
    const clean = logGrantAnomalies(["org"], {
      table: "brain_facts",
      rowId: "f1",
      workspaceId: WS,
    });
    expect(clean.malformed).toEqual([]);
    const dirty = logGrantAnomalies(["user:u1", "everyone"], {
      table: "brain_facts",
      rowId: "f2",
      workspaceId: WS,
    });
    // The case that actually bites: a grant that PASSES the predicate on its
    // valid token while carrying a second one the author thought did something.
    expect(dirty.principals).toHaveLength(1);
    expect(dirty.malformed).toEqual(["everyone"]);
  });
});

describe("principal tokens (#4768)", () => {
  it("always seeds `org` for a reader that has any access at all", () => {
    expect(principalTokens(localCtx())).toEqual([ORG_PRINCIPAL]);
  });

  it("expands roles monotonically: owner ⊇ admin ⊇ member", () => {
    expect(impliedRoles("owner")).toEqual(["owner", "admin", "member"]);
    expect(impliedRoles("admin")).toEqual(["admin", "member"]);
    expect(impliedRoles("member")).toEqual(["member"]);
    expect(principalTokens(ctx({ role: "owner" }))).toEqual([
      ORG_PRINCIPAL,
      `${ROLE_PREFIX}owner`,
      `${ROLE_PREFIX}admin`,
      `${ROLE_PREFIX}member`,
      `${USER_PREFIX}user-1`,
    ]);
  });

  it("grants no role principals for a role outside ORG_ROLES", () => {
    // Unreachable through the type; reachable through a cast or a future role
    // addition. Must deny, not fall out of the switch as `undefined` and turn
    // the caller's `for…of` into an unattributed TypeError.
    const rogue = "superuser" as unknown as "owner";
    expect(impliedRoles(rogue)).toEqual([]);
    expect(principalTokens(ctx({ role: rogue }))).toEqual([
      ORG_PRINCIPAL,
      `${USER_PREFIX}user-1`,
    ]);
  });

  it("grants nothing at all to an unresolved reader", () => {
    expect(principalTokens(unresolvedCtx())).toEqual([]);
  });

  it("grants nothing at all for an origin outside the union", () => {
    // The regression this exists for: an earlier cut spelled the switch as
    // `if (origin !== "authenticated") return [ORG]`, which handed an origin
    // arriving through a cast — or from a checkpoint rehydrated under an older
    // shape — the workspace's entire org-granted fact set, unlogged. A
    // permissive fallthrough on the discriminant that decides whether a reader
    // is authenticated at all is the worst possible place for one.
    const rogue = { ...ctx(), origin: "service" } as unknown as BrainPrincipalContext;
    expect(principalTokens(rogue)).toEqual([]);
    const clause = aclVisibilityClause(rogue, { table: "brain_facts", paramIndex: 1 });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("(FALSE)");
    expect(isVisibleTo(row(["org"]), rogue)).toBe(false);

    // The override branch runs BEFORE the token backstop, so it is the arm
    // where a permissive fallthrough would have been worth the most. Pin it:
    // entitlement requires `origin === "authenticated"`, so a rogue origin is
    // refused and then denied outright.
    const withOverride = aclVisibilityClause(
      { ...rogue, role: "owner" } as unknown as BrainPrincipalContext,
      { table: "brain_facts", paramIndex: 1, override: { reason: "audit" } },
    );
    expect(withOverride.decision).toBe("deny-all");
    expect(withOverride.sql).toBe("(FALSE)");
  });

  it("grants nothing at all when there is no workspace", () => {
    expect(principalTokens(ctx({ workspaceId: "" }))).toEqual([]);
  });

  it("lets an owner read a `role:member` fact", () => {
    // Exact-match role grants would hide member-scoped facts from the
    // workspace OWNER — a hole that reads as a bug every time it is hit.
    expect(isVisibleTo(row(["role:member"]), ctx({ role: "owner" }))).toBe(true);
    expect(isVisibleTo(row(["role:admin"]), ctx({ role: "owner" }))).toBe(true);
  });

  it("does not let a member read a `role:admin` fact", () => {
    expect(isVisibleTo(row(["role:admin"]), ctx({ role: "member" }))).toBe(false);
    expect(isVisibleTo(row(["role:owner"]), ctx({ role: "member" }))).toBe(false);
  });

  it("prefixes audience ids, which are stored unprefixed", () => {
    const tokens = principalTokens(ctx({ audienceIds: ["eng", "exec"] }));
    expect(tokens).toContain(`${AUDIENCE_PREFIX}eng`);
    expect(tokens).toContain(`${AUDIENCE_PREFIX}exec`);
    // The bare id must never be a token — it would match a stored `eng`, which
    // is a malformed grant, not an audience grant.
    expect(tokens).not.toContain("eng");
  });

  it("never emits an empty token or a bare prefix", () => {
    // Two hazards, not one. `ARRAY[''] && ARRAY['']` is TRUE and a stored `''`
    // element is legal at rest; and a bare `user:` is itself MALFORMED, so
    // emitting one would break the "no reader token is ever malformed"
    // invariant that makes the permissive parser safe.
    const tokens = principalTokens(ctx({ userId: "", audienceIds: ["", "ok"] }));
    expect(tokens).not.toContain("");
    expect(tokens).not.toContain(USER_PREFIX);
    expect(tokens).not.toContain(AUDIENCE_PREFIX);
    expect(tokens).toContain(`${AUDIENCE_PREFIX}ok`);
  });

  it("matches user grants only for the named user", () => {
    expect(isVisibleTo(row(["user:user-1"]), ctx({ userId: "user-1" }))).toBe(true);
    expect(isVisibleTo(row(["user:user-2"]), ctx({ userId: "user-1" }))).toBe(false);
  });

  it("treats malformed stored tokens as granting nobody", () => {
    for (const grant of [["everyone"], ["public"], ["ORG"], [""], [null]]) {
      expect(isVisibleTo(row(grant), ctx({ role: "owner", audienceIds: ["eng"] }))).toBe(false);
    }
  });
});

describe("isVisibleTo mirrors the predicate's denies, not just its matches (#4768)", () => {
  // The first cut of this helper took a bare grant and skipped both gates, so
  // it answered TRUE exactly where the SQL answers FALSE. A mirror that is
  // permissive where the predicate denies is worse than no mirror.
  it("denies a row from another workspace even on a matching token", () => {
    // Audience ids collide across tenants by design — this is the leak the
    // predicate's redundant workspace containment exists to stop.
    const reader = ctx({ audienceIds: ["engineering"] });
    expect(isVisibleTo(row(["audience:engineering"], "other-ws"), reader)).toBe(false);
    expect(isVisibleTo(row(["audience:engineering"], WS), reader)).toBe(true);
  });

  it("denies an org-granted row to an unresolved reader", () => {
    expect(isVisibleTo(row(["org"]), unresolvedCtx())).toBe(false);
    expect(aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 1 }).decision)
      .toBe("deny-all");
  });

  it("denies when the reader has no workspace", () => {
    expect(isVisibleTo(row(["org"], ""), ctx({ workspaceId: "" }))).toBe(false);
  });

  it("denies a row whose grant is not an array rather than throwing", () => {
    // `visibleTo` is typed `readonly unknown[]`, but rows arrive off `pg` as
    // `visible_to`; a caller that maps `workspaceId` right and this field wrong
    // would otherwise get a bare TypeError out of a security primitive.
    const malformedRow = {
      table: "brain_facts",
      workspaceId: WS,
      visibleTo: undefined,
    } as unknown as Parameters<typeof isVisibleTo>[0];
    expect(isVisibleTo(malformedRow, ctx())).toBe(false);
  });

  it("gives `auth: none` the org principal only", () => {
    expect(isVisibleTo(row(["org"]), localCtx())).toBe(true);
    expect(isVisibleTo(row(["role:owner"]), localCtx())).toBe(false);
    expect(isVisibleTo(row(["audience:eng"]), localCtx())).toBe(false);
    expect(isVisibleTo(row(["user:user-1"]), localCtx())).toBe(false);
  });
});

describe("resolvePrincipalContext (#4768)", () => {
  function reader(rows: unknown[], onQuery?: (sql: string, params?: unknown[]) => void) {
    return {
      query: async (sql: string, params?: unknown[]) => {
        onQuery?.(sql, params);
        return { rows };
      },
    } satisfies AudienceMembershipReader;
  }

  const authed = {
    workspaceId: WS,
    mode: "managed",
    userId: "user-1",
    resolvedRole: { role: "member", orgId: WS },
  } as const;

  it("reads audience membership locally, scoped to workspace + user", async () => {
    let seenSql: string | undefined;
    let seenParams: unknown[] | undefined;
    const resolved = await resolvePrincipalContext(
      reader([{ audience_id: "eng", fresh: true }, { audience_id: "exec", fresh: true }], (sql, params) => {
        seenSql = sql;
        seenParams = params;
      }),
      authed,
    );
    // Third param is the staleness bound in seconds (#4808) — the read-time
    // half of the guarantee that a permanently-failing roster read cannot keep
    // granting forever.
    expect(seenParams?.slice(0, 2)).toEqual([WS, "user-1"]);
    expect(typeof seenParams?.[2]).toBe("number");
    // The workspace predicate is the module's only cross-tenant-sensitive read
    // — a membership row from another tenant hands this reader a token that
    // then matches their OWN tenant's facts, which the predicate's workspace
    // containment cannot catch.
    // Positive form, deliberately: the earlier `not.toContain("OR")` guard was
    // a tripwire rather than a check ("ORDER BY" contains "OR"). This pins the
    // AND-composition itself, and cannot be tripped by a benign addition.
    expect(seenSql).toMatch(/workspace_id = \$1\s+AND\s+user_id = \$2/);
    expect(resolved.audienceIds).toEqual(["eng", "exec"]);
    expect(resolved.origin).toBe("authenticated");
  });

  it("drops non-string / empty audience ids rather than minting a bare prefix", async () => {
    const resolved = await resolvePrincipalContext(
      reader([
        { audience_id: "eng", fresh: true },
        { audience_id: null, fresh: true },
        { audience_id: "", fresh: true },
        {},
      ]),
      authed,
    );
    expect(resolved.audienceIds).toEqual(["eng"]);
  });

  it("gives `auth: none` the org principal ONLY, without touching the DB", async () => {
    let queried = false;
    const resolved = await resolvePrincipalContext(
      reader([], () => {
        queried = true;
      }),
      { workspaceId: WS, mode: "none", userId: undefined, resolvedRole: undefined },
    );
    expect(queried).toBe(false);
    expect(resolved.origin).toBe("unauthenticated-local");
    expect(principalTokens(resolved)).toEqual([ORG_PRINCIPAL]);
    // Narrowed content stays hidden even from the local operator.
    expect(isVisibleTo(row(["role:owner"]), resolved)).toBe(false);
    expect(isVisibleTo(row(["audience:eng"]), resolved)).toBe(false);
    expect(isVisibleTo(row(["org"]), resolved)).toBe(true);
  });

  it("resolves the other authenticated modes without special-casing them", async () => {
    for (const mode of ["simple-key", "byot"] as const) {
      const resolved = await resolvePrincipalContext(reader([{ audience_id: "eng", fresh: true }]), {
        ...authed,
        mode,
      });
      expect(resolved.origin).toBe("authenticated");
      expect(principalTokens(resolved)).toEqual([
        ORG_PRINCIPAL,
        `${ROLE_PREFIX}member`,
        `${USER_PREFIX}user-1`,
        `${AUDIENCE_PREFIX}eng`,
      ]);
    }
  });

  it("resolves `unresolved` for an unrecognised auth mode", async () => {
    const resolved = await resolvePrincipalContext(reader([]), {
      ...authed,
      mode: "quantum" as unknown as "managed",
    });
    expect(resolved.origin).toBe("unresolved");
  });

  it("maps a bare platform_admin to no org-role principal", async () => {
    const resolved = await resolvePrincipalContext(reader([]), {
      ...authed,
      userId: "op-1",
      resolvedRole: { role: "platform_admin", orgId: WS },
    });
    expect(resolved.role).toBeNull();
    expect(principalTokens(resolved)).toEqual([ORG_PRINCIPAL, `${USER_PREFIX}op-1`]);
    expect(isVisibleTo(row(["role:admin"]), resolved)).toBe(false);
  });

  it("drops role grants when the role was resolved against a different org", async () => {
    // `member.role` is per-org (#2890). A role carried over from the session's
    // ACTIVE org while reading a DIFFERENT workspace would grant `role:` tokens
    // — and audit-override entitlement — derived from another tenant.
    const resolved = await resolvePrincipalContext(reader([]), {
      ...authed,
      resolvedRole: { role: "owner", orgId: "some-other-org" },
    });
    expect(resolved.role).toBeNull();
    expect(principalTokens(resolved)).not.toContain(`${ROLE_PREFIX}owner`);
    expect(
      aclVisibilityClause(resolved, {
        table: "brain_facts",
        paramIndex: 1,
        override: { reason: "audit" },
      }).decision,
    ).toBe("override-refused");
  });

  it("keeps role grants when the role was resolved against the read target", async () => {
    const resolved = await resolvePrincipalContext(reader([]), {
      ...authed,
      resolvedRole: { role: "owner", orgId: WS },
    });
    expect(resolved.role).toBe("owner");
    expect(principalTokens(resolved)).toContain(`${ROLE_PREFIX}owner`);
  });

  it("resolves `unresolved` when an authenticated request carries no user id", async () => {
    const resolved = await resolvePrincipalContext(reader([]), { ...authed, userId: undefined });
    expect(resolved.origin).toBe("unresolved");
    expect(principalTokens(resolved)).toEqual([]);
  });

  it("propagates database failures instead of silently downgrading the reader", async () => {
    // Swallowing this would report success while quietly stripping every
    // audience grant from an authorization decision.
    const failing: AudienceMembershipReader = {
      query: () => Promise.reject(new Error("connection terminated")),
    };
    await expect(resolvePrincipalContext(failing, authed)).rejects.toThrow(
      "connection terminated",
    );
  });

  // -------------------------------------------------------------------------
  // Staleness bound (#4808)
  // -------------------------------------------------------------------------

  it("suppresses an audience the sync has not verified within the bound", async () => {
    // The read-time half of #4808. Without it, a channel Atlas was removed from
    // fails `loadRoster` on every cycle forever and keeps granting access
    // indefinitely — the sync's fail-safe abort is correct but has no time
    // bound, so "revocation latency is one interval" becomes "unbounded".
    const resolved = await resolvePrincipalContext(
      reader([
        { audience_id: "eng", fresh: true },
        { audience_id: "abandoned", fresh: false },
      ]),
      authed,
    );
    expect(resolved.audienceIds).toEqual(["eng"]);
    expect(principalTokens(resolved)).not.toContain(`${AUDIENCE_PREFIX}abandoned`);
    // And the fact it gated is genuinely invisible, not merely absent from a list.
    expect(isVisibleTo(row([`${AUDIENCE_PREFIX}abandoned`]), resolved)).toBe(false);
    expect(isVisibleTo(row([`${AUDIENCE_PREFIX}eng`]), resolved)).toBe(true);
  });

  it("suppresses a membership row whose freshness flag is unreadable", async () => {
    // Fails CLOSED on query drift. "We could not determine whether this
    // membership is still verified" is not a basis for expanding a token — and
    // the alternative default (treat unknown as fresh) would make the bound
    // silently unenforced the moment the SELECT list changed.
    const resolved = await resolvePrincipalContext(
      reader([{ audience_id: "eng" }, { audience_id: "ops", fresh: "yes" }]),
      authed,
    );
    expect(resolved.audienceIds).toEqual([]);
  });

  it("passes the configured bound to the query rather than filtering in TS", async () => {
    // The comparison must happen against the DATABASE's clock on both sides.
    // Reading `synced_at` out and testing it against the API process's
    // `Date.now()` would make the bound depend on clock skew between two
    // machines — and skew in the generous direction silently extends every
    // grant, which is the one direction this bound exists to close.
    let seenSql: string | undefined;
    let seenParams: unknown[] | undefined;
    await resolvePrincipalContext(
      reader([{ audience_id: "eng", fresh: true }], (sql, params) => {
        seenSql = sql;
        seenParams = params;
      }),
      authed,
    );
    expect(seenSql).toContain("synced_at");
    expect(seenSql).toContain("now()");
    expect(seenParams?.[2]).toBe(DEFAULT_AUDIENCE_MAX_STALENESS_HOURS * 3600);
  });

  it("treats a non-positive bound as DISABLED, not as 'everything is stale'", async () => {
    // `make_interval(secs => 0)` is a zero interval, under which
    // `synced_at >= now()` is false for every row — so a disabled setting read
    // naively would suppress every audience in the deployment rather than none
    // of them. The SQL checks the disable arm FIRST for exactly that reason.
    expect(AUDIENCE_MEMBERSHIP_SQL).toMatch(/\$3::double precision <= 0\s+OR/);
  });

  it("falls back to the default bound on an unparseable setting, not to disabled", async () => {
    // A typo in an operator's override must not quietly switch the bound off.
    // (The `0` escape hatch is deliberate and separate — see the setting copy.)
    expect(getAudienceMaxStalenessSeconds()).toBe(DEFAULT_AUDIENCE_MAX_STALENESS_HOURS * 3600);
  });
});

describe("aclVisibilityClause (#4768)", () => {
  it("emits workspace containment AND grant overlap, in that param order", () => {
    const clause = aclVisibilityClause(ctx({ audienceIds: ["eng"] }), {
      table: "brain_facts",
      alias: "f",
      paramIndex: 3,
    });
    expect(clause.decision).toBe("grant-match");
    expect(clause.sql).toBe("(f.workspace_id = $3 AND f.visible_to && $4::text[])");
    expect(clause.params).toEqual([
      WS,
      ["org", "role:member", "user:user-1", "audience:eng"],
    ]);
  });

  it("scopes to the workspace even though callers already do — audience ids collide across tenants", () => {
    const clause = aclVisibilityClause(ctx(), { table: "brain_episodes", paramIndex: 1 });
    expect(clause.sql).toContain("brain_episodes.workspace_id = $1");
  });

  it("defaults the alias to the table name", () => {
    const clause = aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: 1 });
    expect(clause.sql).toBe(
      "(brain_facts.workspace_id = $1 AND brain_facts.visible_to && $2::text[])",
    );
  });

  it("gates both tier-2 and tier-3 tables", () => {
    for (const table of ACL_GATED_TABLES) {
      const clause = aclVisibilityClause(ctx(), { table, paramIndex: 1 });
      expect(clause.sql).toContain(`${table}.visible_to && $2::text[]`);
    }
  });

  it("denies outright when the reader is unresolved", () => {
    const clause = aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 1 });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("(FALSE)");
    expect(clause.params).toEqual([]);
  });

  it("denies outright when there is no workspace", () => {
    const clause = aclVisibilityClause(ctx({ workspaceId: "" }), {
      table: "brain_facts",
      paramIndex: 1,
    });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("(FALSE)");
  });

  it("parenthesises every arm so composition can never re-associate", () => {
    const clauses = [
      aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: 1 }),
      aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 1 }),
      aclVisibilityClause(ctx({ role: "admin" }), {
        table: "brain_facts",
        paramIndex: 1,
        override: { reason: "audit" },
      }),
    ];
    for (const clause of clauses) {
      expect(clause.sql.startsWith("(")).toBe(true);
      expect(clause.sql.endsWith(")")).toBe(true);
      expect(clause.sql.trimStart().startsWith("AND")).toBe(false);
    }
  });

  it("rejects a non-identifier alias rather than interpolating it", () => {
    expect(() =>
      aclVisibilityClause(ctx(), { table: "brain_facts", alias: "f; DROP TABLE x --", paramIndex: 1 }),
    ).toThrow(/plain SQL identifier/);
    expect(() =>
      aclVisibilityClause(ctx(), { table: "brain_facts", alias: "", paramIndex: 1 }),
    ).toThrow(/plain SQL identifier/);
  });

  it("rejects a non-positive-integer paramIndex rather than emitting `$0`", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: bad }),
      ).toThrow(/positive integer/);
    }
  });

  it("reports where the caller's next placeholder goes", () => {
    // `nextParamIndex` makes the composition rule mechanical rather than
    // readable-and-forgettable, and must always equal paramIndex + arity.
    const cases = [
      aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 5 }),
      aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: 5 }),
      aclVisibilityClause(ctx({ role: "admin" }), {
        table: "brain_facts",
        paramIndex: 5,
        override: { reason: "audit" },
      }),
    ];
    for (const clause of cases) {
      expect(clause.nextParamIndex).toBe(5 + clause.params.length);
    }
  });

  it("never hands out a mutable shared deny clause", () => {
    // One frozen template backs every deny in the process; a caller mutating
    // `.params` would otherwise poison every subsequent denied read for every
    // tenant on the instance.
    const a = aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 1 });
    const b = aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 7 });
    expect(Object.isFrozen(a.params)).toBe(true);
    expect(() => (a.params as unknown as unknown[]).push("x")).toThrow();
    // …and the per-call cursor is still per-call.
    expect(a.nextParamIndex).toBe(1);
    expect(b.nextParamIndex).toBe(7);
  });

  it("declares its own arity — callers advance by params.length, never a constant", () => {
    const deny = aclVisibilityClause(unresolvedCtx(), { table: "brain_facts", paramIndex: 1 });
    const normal = aclVisibilityClause(ctx(), { table: "brain_facts", paramIndex: 1 });
    const override = aclVisibilityClause(ctx({ role: "admin" }), {
      table: "brain_facts",
      paramIndex: 1,
      override: { reason: "audit" },
    });
    expect(deny.params).toHaveLength(0);
    expect(normal.params).toHaveLength(2);
    expect(override.params).toHaveLength(1);
    // Every emitted placeholder must be backed by a supplied param — Postgres
    // rejects a bind that supplies more than the statement references.
    for (const clause of [deny, normal, override]) {
      const placeholders = new Set([...clause.sql.matchAll(/\$(\d+)/g)].map((m) => m[1]));
      expect(placeholders.size).toBe(clause.params.length);
    }
  });
});

describe("audit override (#4768, ADR-0036 — region-scoped, no super-admin)", () => {
  it("bypasses grants for an authenticated workspace owner/admin, still workspace-scoped", () => {
    for (const role of ["owner", "admin"] as const) {
      const clause = aclVisibilityClause(ctx({ role }), {
        table: "brain_facts",
        alias: "f",
        paramIndex: 2,
        override: { reason: "GDPR subject access request" },
        requestId: "req-1",
      });
      expect(clause.decision).toBe("audit-override");
      expect(clause.sql).toBe("(f.workspace_id = $2)");
      expect(clause.params).toEqual([WS]);
    }
  });

  it("refuses a member's override and falls back to grant matching", () => {
    // Not fatal: blinding a reader to their OWN facts because a caller
    // over-asked would be a worse failure than the over-ask.
    const clause = aclVisibilityClause(ctx({ role: "member" }), {
      table: "brain_facts",
      alias: "f",
      paramIndex: 1,
      override: { reason: "oops" },
    });
    expect(clause.decision).toBe("override-refused");
    expect(clause.sql).toBe("(f.workspace_id = $1 AND f.visible_to && $2::text[])");
  });

  it("refuses a bare platform_admin — a platform operator is not a tenant member", () => {
    const clause = aclVisibilityClause(ctx({ role: null, userId: "op-1" }), {
      table: "brain_facts",
      paramIndex: 1,
      override: { reason: "operator poke" },
    });
    expect(clause.decision).toBe("override-refused");
  });

  it("refuses an override from `auth: none` even if the arm carried a role", () => {
    // The union makes `{ origin: "unauthenticated-local", role: "owner" }`
    // unconstructible, which is the point — the flat shape typechecked and
    // earned a workspace-wide bypass on a deployment with no identity at all.
    // The entitlement check requires `authenticated` regardless.
    expect(
      aclVisibilityClause(localCtx(), {
        table: "brain_facts",
        paramIndex: 1,
        override: { reason: "local" },
      }).decision,
    ).toBe("override-refused");
  });

  it("denies (does not merely refuse) an override from an unresolved reader", () => {
    expect(
      aclVisibilityClause(unresolvedCtx(), {
        table: "brain_facts",
        paramIndex: 1,
        override: { reason: "x" },
      }).decision,
    ).toBe("deny-all");
  });

  it("refuses an override with an empty, whitespace, or non-string reason", () => {
    // "Required — an unexplained override is not one" must be enforced, not
    // merely asserted in prose. The non-string arm matters because `reason`
    // originates in a request body: an un-narrowed `.trim()` would turn an
    // override probe into a 500 instead of a recorded escalation attempt.
    for (const reason of ["", "   ", "\t\n", null as unknown as string, 42 as unknown as string]) {
      expect(
        aclVisibilityClause(ctx({ role: "owner" }), {
          table: "brain_facts",
          paramIndex: 1,
          override: { reason },
        }).decision,
      ).toBe("override-refused");
    }
  });
});

describe("no /ee coupling (#4768 acceptance — T8)", () => {
  it("the ACL module imports nothing from @atlas/ee", async () => {
    // The minimal ACL is CORE and fail-closed: a self-hosted build with no
    // enterprise package must gate the brain identically. Corrector-masking
    // and the richer enterprise surfaces layer ON TOP; they never supply the
    // primitive. `scripts/check-ee-imports.sh` is the repo-wide gate (and the
    // one that catches indirect coupling); this pins the file #4768's Key
    // files section names, as intent documentation.
    const source = await Bun.file(new URL("../acl.ts", import.meta.url).pathname).text();
    expect(source).not.toMatch(/from\s+["']@atlas\/ee/);
    expect(source).not.toMatch(/import\(["']@atlas\/ee/);
  });
});
