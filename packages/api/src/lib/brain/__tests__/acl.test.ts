/**
 * Unit coverage for the brain ACL grammar, principal resolution, and the
 * fail-closed push-down predicate (#4768, ADR-0036 §Access control).
 *
 * The real-Postgres half — that the emitted SQL actually selects the rows this
 * file says it should, and that `isVisibleTo` agrees with `&&` token for token
 * — lives in `acl-visibility-pg.test.ts`. Both halves are load-bearing: this
 * one pins the DECISIONS, that one pins the SQL, and a bug in either shows up
 * as a row the wrong person can read.
 */

import { describe, expect, it } from "bun:test";
import {
  ACL_GATED_TABLES,
  AUDIENCE_PREFIX,
  ORG_PRINCIPAL,
  ROLE_PREFIX,
  USER_PREFIX,
  aclVisibilityClause,
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

function ctx(partial: Partial<BrainPrincipalContext> = {}): BrainPrincipalContext {
  return {
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    origin: "authenticated",
    ...partial,
  };
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
  it("always seeds `org`", () => {
    expect(principalTokens(ctx({ role: null, userId: null }))).toEqual([ORG_PRINCIPAL]);
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

  it("lets an owner read a `role:member` fact", () => {
    // Exact-match role grants would hide member-scoped facts from the
    // workspace OWNER — a hole that reads as a bug every time it is hit.
    expect(isVisibleTo(["role:member"], ctx({ role: "owner" }))).toBe(true);
    expect(isVisibleTo(["role:admin"], ctx({ role: "owner" }))).toBe(true);
  });

  it("does not let a member read a `role:admin` fact", () => {
    expect(isVisibleTo(["role:admin"], ctx({ role: "member" }))).toBe(false);
    expect(isVisibleTo(["role:owner"], ctx({ role: "member" }))).toBe(false);
  });

  it("prefixes audience ids, which are stored unprefixed", () => {
    const tokens = principalTokens(ctx({ audienceIds: ["eng", "exec"] }));
    expect(tokens).toContain(`${AUDIENCE_PREFIX}eng`);
    expect(tokens).toContain(`${AUDIENCE_PREFIX}exec`);
    // The bare id must never be a token — it would match a stored `eng`, which
    // is a malformed grant, not an audience grant.
    expect(tokens).not.toContain("eng");
  });

  it("never emits an empty-string token", () => {
    // `ARRAY[''] && ARRAY['']` is TRUE in Postgres, and a stored `''` element
    // is legal at rest — so an empty reader token would match a grant that
    // grants nobody anything.
    const tokens = principalTokens(ctx({ userId: "", audienceIds: ["", "ok"] }));
    expect(tokens).not.toContain("");
    expect(tokens).not.toContain(USER_PREFIX);
    expect(tokens).not.toContain(AUDIENCE_PREFIX);
    expect(tokens).toContain(`${AUDIENCE_PREFIX}ok`);
  });

  it("matches user grants only for the named user", () => {
    expect(isVisibleTo(["user:user-1"], ctx({ userId: "user-1" }))).toBe(true);
    expect(isVisibleTo(["user:user-2"], ctx({ userId: "user-1" }))).toBe(false);
  });

  it("treats malformed stored tokens as granting nobody", () => {
    for (const grant of [["everyone"], ["public"], ["ORG"], [""], [null]]) {
      expect(isVisibleTo(grant, ctx({ role: "owner", audienceIds: ["eng"] }))).toBe(false);
    }
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

  it("reads audience membership locally, scoped to workspace + user", async () => {
    let seen: unknown[] | undefined;
    const resolved = await resolvePrincipalContext(
      reader([{ audience_id: "eng" }, { audience_id: "exec" }], (_sql, params) => {
        seen = params;
      }),
      { workspaceId: WS, mode: "managed", userId: "user-1", role: "member" },
    );
    expect(seen).toEqual([WS, "user-1"]);
    expect(resolved.audienceIds).toEqual(["eng", "exec"]);
    expect(resolved.origin).toBe("authenticated");
  });

  it("drops non-string / empty audience ids rather than minting a bare prefix", async () => {
    const resolved = await resolvePrincipalContext(
      reader([{ audience_id: "eng" }, { audience_id: null }, { audience_id: "" }, {}]),
      { workspaceId: WS, mode: "managed", userId: "user-1", role: "member" },
    );
    expect(resolved.audienceIds).toEqual(["eng"]);
  });

  it("gives `auth: none` the org principal ONLY, without touching the DB", async () => {
    let queried = false;
    const resolved = await resolvePrincipalContext(
      reader([], () => {
        queried = true;
      }),
      { workspaceId: WS, mode: "none", userId: undefined, role: undefined },
    );
    expect(queried).toBe(false);
    expect(resolved.origin).toBe("unauthenticated-local");
    expect(principalTokens(resolved)).toEqual([ORG_PRINCIPAL]);
    // Narrowed content stays hidden even from the local operator.
    expect(isVisibleTo(["role:owner"], resolved)).toBe(false);
    expect(isVisibleTo(["audience:eng"], resolved)).toBe(false);
    expect(isVisibleTo(["org"], resolved)).toBe(true);
  });

  it("maps a bare platform_admin to no org-role principal", async () => {
    const resolved = await resolvePrincipalContext(reader([]), {
      workspaceId: WS,
      mode: "managed",
      userId: "op-1",
      role: "platform_admin",
    });
    expect(resolved.role).toBeNull();
    expect(principalTokens(resolved)).toEqual([ORG_PRINCIPAL, `${USER_PREFIX}op-1`]);
    expect(isVisibleTo(["role:admin"], resolved)).toBe(false);
  });

  it("resolves `unresolved` when an authenticated request carries no user id", async () => {
    const resolved = await resolvePrincipalContext(reader([]), {
      workspaceId: WS,
      mode: "managed",
      userId: undefined,
      role: "admin",
    });
    expect(resolved.origin).toBe("unresolved");
  });

  it("propagates database failures instead of silently downgrading the reader", async () => {
    // Swallowing this would report success while quietly stripping every
    // audience grant from an authorization decision.
    const failing: AudienceMembershipReader = {
      query: () => Promise.reject(new Error("connection terminated")),
    };
    await expect(
      resolvePrincipalContext(failing, {
        workspaceId: WS,
        mode: "managed",
        userId: "user-1",
        role: "member",
      }),
    ).rejects.toThrow("connection terminated");
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
    // Two tenants can both mint `audience:engineering`. Without the redundant
    // containment, a reader in tenant A holding that token would match tenant
    // B's fact if the caller's own scoping were missing or accidentally OR-ed.
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
    const clause = aclVisibilityClause(ctx({ origin: "unresolved" }), {
      table: "brain_facts",
      paramIndex: 1,
    });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("FALSE");
    expect(clause.params).toEqual([]);
  });

  it("denies outright when there is no workspace", () => {
    const clause = aclVisibilityClause(ctx({ workspaceId: "" }), {
      table: "brain_facts",
      paramIndex: 1,
    });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("FALSE");
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

  it("declares its own arity — callers advance by params.length, never a constant", () => {
    const deny = aclVisibilityClause(ctx({ origin: "unresolved" }), {
      table: "brain_facts",
      paramIndex: 1,
    });
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
  it("bypasses grants for a workspace owner/admin, still scoped to the workspace", () => {
    for (const role of ["owner", "admin"] as const) {
      const clause = aclVisibilityClause(ctx({ role }), {
        table: "brain_facts",
        alias: "f",
        paramIndex: 2,
        override: { reason: "GDPR subject access request", requestId: "req-1" },
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

  it("refuses an override from `auth: none` and from an unresolved reader", () => {
    expect(
      aclVisibilityClause(
        ctx({ role: null, userId: null, origin: "unauthenticated-local" }),
        { table: "brain_facts", paramIndex: 1, override: { reason: "local" } },
      ).decision,
    ).toBe("override-refused");
    expect(
      aclVisibilityClause(ctx({ origin: "unresolved" }), {
        table: "brain_facts",
        paramIndex: 1,
        override: { reason: "x" },
      }).decision,
    ).toBe("deny-all");
  });
});

describe("no /ee coupling (#4768 acceptance — T8)", () => {
  it("the ACL module imports nothing from @atlas/ee", async () => {
    // The minimal ACL is CORE and fail-closed: a self-hosted build with no
    // enterprise package must gate the brain identically. Corrector-masking
    // and the richer enterprise surfaces layer ON TOP; they never supply the
    // primitive. `scripts/check-ee-imports.sh` is the repo-wide guard — this
    // pins the specific file the acceptance criterion names.
    const source = await Bun.file(
      new URL("../acl.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toContain("@atlas/ee");
  });
});
