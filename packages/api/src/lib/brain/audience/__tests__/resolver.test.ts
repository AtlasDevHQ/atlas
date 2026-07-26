/**
 * The identity resolver's decision surface (#4801, ADR-0036 §Access control).
 *
 * What is worth pinning here is not "an email matches a user" — it is every way
 * a resolver could quietly resolve MORE than it should, because each of those
 * ends as a membership row that grants someone access to a private channel's
 * facts. So the assertions lean on the exclusions: the SSO narrowing, the
 * workspace scoping, and the two DB-fault paths that must throw rather than
 * return an empty set (an empty set reconciles to a full revocation).
 */

import { describe, expect, it } from "bun:test";
import {
  RESOLVE_PRINCIPAL_EMAILS_SQL,
  VERIFIED_SSO_DOMAINS_SQL,
  emailDomain,
  loadVerifiedSsoDomains,
  resolvePrincipals,
  type SourcePrincipal,
} from "../resolver";

const WORKSPACE = "ws-1";

/**
 * A query stub that answers the two statements by identity, so a test can pin
 * WHICH statement ran with WHICH params. Keyed on the exported SQL constants
 * rather than a substring: a paraphrase of the query would then miss, which is
 * the point — these tests are about the real statements.
 */
function stubQuery(opts: {
  readonly domains?: readonly string[];
  readonly users?: ReadonlyArray<{ email: string; user_id: string }>;
  readonly onDomains?: () => never;
  readonly onUsers?: () => never;
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    calls.push({ sql, params: params ?? [] });
    if (sql === VERIFIED_SSO_DOMAINS_SQL) {
      opts.onDomains?.();
      return (opts.domains ?? []).map((domain) => ({ domain })) as unknown as T[];
    }
    if (sql === RESOLVE_PRINCIPAL_EMAILS_SQL) {
      opts.onUsers?.();
      return (opts.users ?? []) as unknown as T[];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, calls };
}

const principal = (id: string, email: string | null): SourcePrincipal => ({ id, email });

describe("emailDomain", () => {
  it("lowercases the domain and rejects addresses that have none", () => {
    expect(emailDomain("Person@Example.COM")).toBe("example.com");
    // A local part with no `@`, a trailing `@`, and a leading `@` are all
    // unusable — and must not produce a domain that could then MATCH a
    // verified one. `""` would be a particularly bad answer here.
    expect(emailDomain("person")).toBeNull();
    expect(emailDomain("person@")).toBeNull();
    expect(emailDomain("@example.com")).toBeNull();
  });

  it("takes the LAST @ so a quoted local part cannot forge the domain", () => {
    // `"a@evil.test"@corp.test` is a legal address whose domain is corp.test.
    // Splitting on the FIRST `@` would read it as evil.test — which, under the
    // SSO narrowing, is a way to fail a check by claiming the wrong domain.
    expect(emailDomain('"a@evil.test"@corp.test')).toBe("corp.test");
  });
});

describe("loadVerifiedSsoDomains", () => {
  it("throws rather than returning an empty set when the lookup fails", async () => {
    // The empty set means NO NARROWING. Swallowing this error would widen
    // resolution during an incident — the fail-open direction.
    const { query } = stubQuery({
      onDomains: () => {
        throw new Error("connection terminated");
      },
    });
    await expect(loadVerifiedSsoDomains(WORKSPACE, { query })).rejects.toThrow(
      "connection terminated",
    );
  });

  it("drops blank domains rather than admitting an empty-string domain", async () => {
    // `''` in the set would make `verifiedDomains.size > 0` true while matching
    // no real address — narrowing everything to nothing, i.e. a silent full
    // revocation on the next reconcile.
    const { query } = stubQuery({ domains: ["  ", "Corp.TEST"] });
    const domains = await loadVerifiedSsoDomains(WORKSPACE, { query });
    expect([...domains]).toEqual(["corp.test"]);
  });
});

describe("resolvePrincipals", () => {
  it("resolves an email match to the workspace's Atlas user", async () => {
    const { query, calls } = stubQuery({
      users: [{ email: "ada@corp.test", user_id: "user-ada" }],
    });
    const result = await resolvePrincipals(
      WORKSPACE,
      [principal("U_ADA", "Ada@Corp.test")],
      { query },
    );
    expect(result.resolved.get("U_ADA")).toBe("user-ada");
    expect(result.unresolvedCount).toBe(0);
    // The lookup is lowercased on the way in, matching the SQL's LOWER() —
    // otherwise a member who signed up with a capitalised address never
    // resolves and is quietly excluded from every audience.
    const userCall = calls.find((c) => c.sql === RESOLVE_PRINCIPAL_EMAILS_SQL);
    expect(userCall?.params).toEqual([WORKSPACE, ["ada@corp.test"]]);
  });

  it("scopes the lookup to the workspace being synced", async () => {
    // The membership row this feeds is workspace-scoped and grants inside the
    // reader's own tenant, so an unscoped resolve would be a cross-tenant leak.
    const { query, calls } = stubQuery({ users: [] });
    await resolvePrincipals(WORKSPACE, [principal("U", "a@corp.test")], { query });
    expect(calls.every((c) => c.params[0] === WORKSPACE)).toBe(true);
  });

  it("excludes an address outside the verified SSO domain, and says why", async () => {
    const { query, calls } = stubQuery({
      domains: ["corp.test"],
      // The DB WOULD match this user — the exclusion has to happen before the
      // query, or a guest sharing an address with an employee resolves.
      users: [{ email: "guest@gmail.test", user_id: "user-guest" }],
    });
    const result = await resolvePrincipals(
      WORKSPACE,
      [principal("U_GUEST", "guest@gmail.test")],
      { query },
    );
    expect(result.resolved.size).toBe(0);
    expect(result.unresolvedCount).toBe(1);
    // Never asked: the narrowing is a pre-filter, not a post-filter.
    expect(calls.some((c) => c.sql === RESOLVE_PRINCIPAL_EMAILS_SQL)).toBe(false);
  });

  it("does not narrow at all when no domain is verified", async () => {
    // The self-hosted / no-EE path. An unverified domain must not narrow
    // either — narrowing to an unproven domain would let whoever can add a
    // domain row decide which emails resolve.
    const { query } = stubQuery({
      domains: [],
      users: [{ email: "guest@gmail.test", user_id: "user-guest" }],
    });
    const result = await resolvePrincipals(
      WORKSPACE,
      [principal("U_GUEST", "guest@gmail.test")],
      { query },
    );
    expect(result.resolved.get("U_GUEST")).toBe("user-guest");
  });

  it("counts a principal with no email as unresolved rather than skipping it", async () => {
    // "Logged, never guessed" has a counting half: an uncounted exclusion is
    // indistinguishable from a roster that never contained them.
    const { query } = stubQuery({ users: [] });
    const result = await resolvePrincipals(
      WORKSPACE,
      [principal("U_NOMAIL", null), principal("U_BLANK", "   ")],
      { query },
    );
    expect(result.resolved.size).toBe(0);
    expect(result.unresolvedCount).toBe(2);
  });

  it("maps two source accounts sharing an address to the same Atlas user", async () => {
    // Rare but legal. A `Map<email, id>` would silently drop one of them, and
    // the dropped one would then be REVOKED by the reconcile.
    const { query } = stubQuery({ users: [{ email: "ada@corp.test", user_id: "user-ada" }] });
    const result = await resolvePrincipals(
      WORKSPACE,
      [principal("U_ONE", "ada@corp.test"), principal("U_TWO", "ADA@corp.test")],
      { query },
    );
    expect(result.resolved.get("U_ONE")).toBe("user-ada");
    expect(result.resolved.get("U_TWO")).toBe("user-ada");
    expect(result.unresolvedCount).toBe(0);
  });

  it("throws when the user lookup fails instead of resolving nobody", async () => {
    // The load-bearing one. Returning an empty resolution here would hand
    // `reconcileAudienceMembership` an empty roster, which deletes every member
    // of the audience — a full revocation caused by a transient DB fault.
    const { query } = stubQuery({
      onUsers: () => {
        throw new Error("statement timeout");
      },
    });
    await expect(
      resolvePrincipals(WORKSPACE, [principal("U", "a@corp.test")], { query }),
    ).rejects.toThrow("statement timeout");
  });

  it("skips the user query entirely when nothing survived filtering", async () => {
    const { query, calls } = stubQuery({ users: [] });
    await resolvePrincipals(WORKSPACE, [principal("U", null)], { query });
    expect(calls.some((c) => c.sql === RESOLVE_PRINCIPAL_EMAILS_SQL)).toBe(false);
  });
});
