/**
 * The publish preview's brain segment — the ACL-gated one (#4825, ADR-0036).
 *
 * Seven of the eight surfaces in `admin-publish-preview.ts` are workspace-scoped
 * and that is the whole story. `brain_facts` is not: its LABEL is the claim, so
 * the projection is gated by `aclVisibilityClause` and the remainder is reported
 * as a count. This file pins the arms that decide what that count MEANS, because
 * every one of them is a place where a plausible simplification silently
 * restores #4825's defect:
 *
 *   - `withheld: 0` instead of "all of them" on an identity fault ⇒ the modal
 *     renders "No pending changes to publish." over a workspace of drafts the
 *     confirm button will promote. That is the original issue, back, through an
 *     untested catch block, on an ACL blip.
 *   - `scopeUnavailable` collapsed away ⇒ an infrastructure fault renders as a
 *     confident, false claim about Slack channel membership, printed directly
 *     above the publish button.
 *   - a non-identity error swallowed by the same catch ⇒ a defect on constant
 *     inputs (a bad `paramIndex`, an unsafe alias) or an outage is laundered
 *     into a confidentiality message.
 *   - the anchoring invariant lost ⇒ `shown + withheld` stops equalling
 *     `brainFactsCountSql`, which is what makes the modal's arithmetic agree
 *     with the pending badge by construction rather than by coincidence.
 *
 * `loadBrainFactSegment` is exported for exactly this — the route composes
 * identity → clause → count, and the `-pg` suite exercises `brainFactPreviewSql`
 * as a STRING, which cannot see any of the above.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/__mocks__/api-test-mocks";

const WS = "ws-preview-brain";

/** Statements the segment issued, so a test can prove which ran. */
let queries: Array<{ sql: string; params: unknown[] }> = [];
/** Live drafts in the workspace, as `brainFactsCountSql` reports them. */
let workspaceDraftCount: unknown = 3;
/** Rows the ACL-scoped label projection returns. */
let visibleRows: Array<Record<string, unknown>> = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes("COUNT(*)::int AS n")) return [{ key: "brainFacts", n: workspaceDraftCount }];
      return visibleRows;
    },
  }),
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
}));

// The real logger is used deliberately: `mock.module` is file-global and must
// supply EVERY named export, and this graph reaches `withRequestContext` through
// the audit scrubber. A partial factory link-fails; a complete one would be a
// hand-maintained copy of the logger's surface for no benefit, since the degraded
// paths under test assert on their RETURN value, not on what they logged.

/**
 * How `resolveBrainReaderContext` behaves this run.
 *
 * `identity-error` models the class the segment is allowed to degrade on;
 * `other-error` models everything it must NOT — the distinction this file
 * exists to hold.
 */
let readerMode: "ok" | "unresolved" | "identity-error" | "other-error" = "ok";

class BrainReaderIdentityError extends Error {}
class BrainReaderUnresolvedError extends BrainReaderIdentityError {}
class BrainRoleUnresolvedError extends BrainReaderIdentityError {}

void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError,
  BrainReaderUnresolvedError,
  BrainRoleUnresolvedError,
  resolveBrainReaderContext: async () => {
    if (readerMode === "identity-error") throw new BrainRoleUnresolvedError("member lookup failed");
    if (readerMode === "other-error") throw new Error("connection pool exhausted");
    if (readerMode === "unresolved") {
      return { origin: "unresolved", workspaceId: WS, userId: null, role: null, audienceIds: [] };
    }
    return {
      origin: "authenticated",
      workspaceId: WS,
      userId: "user-1",
      role: "admin",
      audienceIds: [],
    };
  },
}));

const { loadBrainFactSegment } = await import("../admin-publish-preview");

beforeEach(() => {
  queries = [];
  workspaceDraftCount = 3;
  visibleRows = [];
  readerMode = "ok";
});

afterEach(() => {
  readerMode = "ok";
});

function segment() {
  return loadBrainFactSegment(WS, "managed", { id: "user-1" } as never, "test-req");
}

describe("the ordinary path", () => {
  it("shows what the reader may read and withholds the remainder", async () => {
    workspaceDraftCount = 3;
    visibleRows = [
      { id: "f1", label: "Acme uses Snowflake", updated_at: new Date(0) },
      { id: "f2", label: "Acme renews in March", updated_at: new Date(0) },
    ];

    const result = await segment();
    expect(result.rows).toHaveLength(2);
    expect(result.withheld).toBe(1);
    expect(result.scopeUnavailable).toBe(false);
  });

  it("keeps `shown + withheld` equal to the workspace draft count", async () => {
    // THE anchoring invariant. The unscoped half comes from the same statement
    // as `/api/v1/mode` draftCounts.brainFacts, so the modal's arithmetic
    // matches the pending badge by construction — not because two queries
    // happen to agree.
    workspaceDraftCount = 32;
    visibleRows = Array.from({ length: 26 }, (_, i) => ({
      id: `f${i}`,
      label: `claim ${i}`,
      updated_at: new Date(0),
    }));

    const result = await segment();
    expect(result.rows.length + result.withheld).toBe(32);
    expect(result.withheld).toBe(6); // the 26 / 32 soak reading
  });

  it("gates the label projection but not the count", async () => {
    await segment();
    const labelQuery = queries.find((q) => q.sql.includes("f.subject"));
    const countQuery = queries.find((q) => q.sql.includes("COUNT(*)::int AS n"));
    // If the labels ever stopped being gated, this surface would hand an admin
    // exactly the claims the review queue had just withheld.
    expect(labelQuery?.sql).toContain("visible_to &&");
    // And if the COUNT gained the predicate, `withheld` would always be 0 and
    // the disclosure would silently vanish.
    expect(countQuery?.sql).not.toContain("visible_to &&");
  });

  it("reports nothing withheld when the reader can see every draft", async () => {
    // Non-vacuity for every "withheld" assertion here: a segment that always
    // claimed something was hidden would pass them all while lying to every
    // admin in every workspace.
    workspaceDraftCount = 2;
    visibleRows = [
      { id: "f1", label: "a", updated_at: new Date(0) },
      { id: "f2", label: "b", updated_at: new Date(0) },
    ];
    const result = await segment();
    expect(result.withheld).toBe(0);
    expect(result.scopeUnavailable).toBe(false);
  });

  it("never reports a negative remainder when ingest races the two statements", async () => {
    workspaceDraftCount = 1;
    visibleRows = [
      { id: "f1", label: "a", updated_at: new Date(0) },
      { id: "f2", label: "b", updated_at: new Date(0) },
    ];
    const result = await segment();
    expect(result.withheld).toBe(0);
  });
});

describe("fail-closed degradation", () => {
  it("withholds EVERYTHING when the reader's identity cannot be resolved", async () => {
    // The arm whose plausible "simplification" to `withheld: 0` restores #4825:
    // the modal would say "No pending changes to publish." over a publish that
    // promotes all of them.
    readerMode = "identity-error";
    workspaceDraftCount = 7;

    const result = await segment();
    expect(result.rows).toEqual([]);
    expect(result.withheld).toBe(7);
    expect(result.scopeUnavailable).toBe(true);
    // The claims were never even fetched.
    expect(queries.some((q) => q.sql.includes("f.subject"))).toBe(false);
  });

  it("withholds EVERYTHING when the ACL clause denies outright", async () => {
    readerMode = "unresolved";
    workspaceDraftCount = 4;

    const result = await segment();
    expect(result.rows).toEqual([]);
    expect(result.withheld).toBe(4);
    expect(result.scopeUnavailable).toBe(true);
  });

  it("distinguishes an Atlas fault from an audience boundary", async () => {
    // Both arms produce "everything withheld", and only one of them is about
    // channel membership. Without the flag the modal tells an admin who can
    // read every fact in the workspace that all of them came from channels they
    // are not in — a fabricated explanation above the publish button.
    readerMode = "identity-error";
    expect((await segment()).scopeUnavailable).toBe(true);

    readerMode = "ok";
    workspaceDraftCount = 1;
    visibleRows = [];
    const genuine = await segment();
    expect(genuine.withheld).toBe(1);
    expect(genuine.scopeUnavailable).toBe(false);
  });
});

describe("what must NOT be degraded", () => {
  it("propagates a non-identity failure instead of calling it a confidentiality outcome", async () => {
    // A pool blip, or a defect `aclVisibilityClause` throws on (a bad
    // paramIndex, an unsafe alias). Laundering those into "these are outside
    // your audiences" hides a real fault behind a reassuring sentence.
    readerMode = "other-error";
    await expect(segment()).rejects.toThrow(/connection pool exhausted/);
  });

  it("refuses to report a scope it could not count", async () => {
    // Silently treating an unreadable count as 0 drops the notice and puts
    // "Publish all (N)" on a button that promotes more — #4825's defect, with
    // no trace, exactly when the count query is misbehaving.
    workspaceDraftCount = undefined;
    await expect(segment()).rejects.toThrow(/did not read back as a number/);
  });
});
