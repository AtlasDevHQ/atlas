/**
 * Route tests for POST /api/v1/brain-corrections/confirm — the confirm-before-write
 * execution point for chat-staged brain corrections (#5496, ADR-0036 §T9).
 *
 * Mirrors rest-operations.test.ts's isolation: a minimal Hono app with only this
 * route mounted, the auth middleware mocked to an authenticated workspace admin,
 * and the verb machinery stubbed so the ROUTE's contract is what is under test.
 *
 * The security contract:
 *   - The endpoint is **NOT a trusted fast-path**. It re-resolves the actor and
 *     hands `correctFact` that live context — so authority, ACL visibility and
 *     the tier-1 refusal are re-run server-side, and nothing in the staged
 *     payload can escalate past them.
 *   - The token binds the correction. A payload edited after staging fails
 *     verification and the verb never runs.
 *   - The nonce burns. A replayed confirm — or a looping agent re-posting its
 *     staged payload — is refused.
 *   - The response carries `flaggedForReReviewCount`, never the ids (#4939):
 *     the dependent-facts query is un-ACL-gated, so a subset of them names facts
 *     this actor cannot read.
 */
import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createHash } from "node:crypto";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// --- Auth (mirrors rest-operations.test.ts) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "session" as const,
    user: {
      id: "u-1",
      email: "ada@example.com",
      role: "admin",
      activeOrganizationId: "ws-1",
      mode: "session",
    },
  } as unknown as AuthResult),
);
const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);
const mockGetClientIP: Mock<(req: Request) => string | null> = mock(() => null);

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "session",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async () => [],
    hasInternalDB: () => true,
  }),
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
}));

/**
 * The signing keyset, stubbed explicitly — `buildInternalDbMockDefaults` carries
 * `getEncryptionKeyset: () => null`, and under that stub the real resolver never
 * answers however `BETTER_AUTH_SECRET` is arranged. Declaring the keyset says
 * what this file needs instead of depending on a stub two files away.
 */
const TEST_KEY = createHash("sha256").update("brain-confirm-route-test-key").digest();
void mock.module("@atlas/api/lib/db/encryption-keys", () => ({
  getEncryptionKeyset: () => ({
    active: { version: 1, key: TEST_KEY },
    byVersion: new Map([[1, TEST_KEY]]),
    decrypt: [{ version: 1, key: TEST_KEY }],
    source: "BETTER_AUTH_SECRET" as const,
  }),
  getEncryptionKey: () => TEST_KEY,
  activeKeyVersion: () => 1,
  _resetEncryptionKeyCache: () => {},
}));

// The actor resolver — the route's live re-resolution. Stubbed so a test can
// make it fail, which is the "identity could not be resolved" arm.
class MockBrainReaderIdentityError extends Error {}
const READER_CTX = {
  origin: "authenticated" as const,
  workspaceId: "ws-1",
  userId: "u-1",
  role: "admin" as const,
  audienceIds: ["org"] as readonly string[],
};
let readerContextResult: () => unknown = () => READER_CTX;
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: MockBrainReaderIdentityError,
  BrainReaderUnresolvedError: class extends MockBrainReaderIdentityError {},
  BrainRoleUnresolvedError: class extends MockBrainReaderIdentityError {},
  resolveBrainReaderContext: async () => readerContextResult(),
}));

class MockVocabularyClosureError extends Error {
  readonly position = "object";
  readonly norm = "bo";
}
let vocabularyResult: () => unknown = () => ({
  subject: (n: string) => n,
  predicate: (n: string) => n,
  object: (n: string) => n,
});
void mock.module("@atlas/api/lib/brain/vocabulary", () => ({
  VocabularyClosureError: MockVocabularyClosureError,
  loadWorkspaceVocabulary: async () => vocabularyResult(),
}));

// The verb machinery, stubbed: this file tests the ROUTE. `correctCalls` is what
// makes "the endpoint re-runs the gate with a LIVE context" observable.
const CORRECTED = {
  kind: "corrected" as const,
  result: {
    verb: "retract" as const,
    factId: "6f2c0000-0000-4000-8000-000000000000",
    correctionEpisodeId: "ep-1",
    invalidatedAt: "2026-08-27T12:00:00.000Z",
    flaggedForReReview: ["dep-1", "dep-2"],
    supersededBy: null,
    validTo: null,
  },
};
let correctCalls: Array<Record<string, unknown>> = [];
let correctionResult: () => unknown = () => CORRECTED;
// Mock-all-exports, matching the sibling in `lib/tools/__tests__/correct-fact-tool.test.ts`:
// the factory lists every VALUE export `correction.ts` has. A partial factory
// makes any later import of a SQL-constant consumer fail with a `SyntaxError`
// about a missing export rather than a useful assertion — which is exactly what
// `.claude/rules/testing.md` means by "mock all exports".
void mock.module("@atlas/api/lib/brain/correction", () => ({
  CORRECTION_VERBS: ["retract", "supersede", "re-authority", "pin"],
  CORRECTION_EPISODE_INSERT_SQL: "INSERT",
  DEPENDENT_FACTS_SQL: "SELECT",
  DERIVES_FROM_EDGE_SQL: "INSERT",
  MERGE_PROVENANCE_MARKER_SQL: "UPDATE",
  PROMOTE_CORRECTION_FACT_SQL: "UPDATE",
  REPLACEMENT_ROW_SQL: "SELECT",
  RETRACT_FACT_SQL: "UPDATE",
  CorrectionRefusedError: class CorrectionRefusedError extends Error {},
  correctionTargetSql: () => "SELECT",
  // The route never calls this — `correctFact` runs the authority gate itself,
  // and the ROUTE's job is to hand it a live context. Stubbed to "no refusal" so
  // the export exists and a future route that does consult it fails loudly here
  // rather than silently taking the happy path.
  correctionAuthorityRefusal: () => null,
  CORRECTION_REFUSAL_REASONS: {
    notAuthorized: "NOT_AUTHORIZED",
    warehouseTarget: "WAREHOUSE_TARGET",
    unrecognizedSourceKind: "UNRECOGNIZED_SOURCE_KIND",
    malformedSourceKind: "MALFORMED_SOURCE_KIND",
    targetNotPublished: "TARGET_NOT_PUBLISHED",
    validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
    targetNotCurrent: "TARGET_NOT_CURRENT",
    replacementMissing: "REPLACEMENT_MISSING",
    replacementIdentical: "REPLACEMENT_IDENTICAL",
    replacementMalformed: "REPLACEMENT_MALFORMED",
    replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
  } satisfies typeof import("@atlas/api/lib/brain/correction").CORRECTION_REFUSAL_REASONS,
  correctFact: async (request: Record<string, unknown>) => {
    correctCalls.push(request);
    return correctionResult();
  },
}));

// Import after mocks.
const { Hono } = await import("hono");
const { createBrainCorrectionsRoute } = await import("../brain-corrections");
const { mintCorrectionConfirmToken } = await import("@atlas/api/lib/brain/correction-confirm");
const { _resetConfirmNonces } = await import("@atlas/api/lib/confirm-token");

const FACT = "6f2c0000-0000-4000-8000-000000000000";
beforeEach(() => {
  correctCalls = [];
  correctionResult = () => CORRECTED;
  readerContextResult = () => READER_CTX;
  vocabularyResult = () => ({
    subject: (n: string) => n,
    predicate: (n: string) => n,
    object: (n: string) => n,
  });
  _resetConfirmNonces();
});

function app() {
  const a = new Hono();
  a.route("/api/v1/brain-corrections", createBrainCorrectionsRoute());
  return a;
}

/** A staged confirm payload with a real, correctly-bound token. */
function stagedBody(
  overrides: {
    factId?: string;
    verb?: "retract" | "supersede" | "re-authority" | "pin";
    reason?: string;
    replacement?: { object: string; validFrom?: string };
  } = {},
) {
  const factId = overrides.factId ?? FACT;
  const verb = overrides.verb ?? "retract";
  const payload = {
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    ...(overrides.replacement !== undefined ? { replacement: overrides.replacement } : {}),
  };
  const token = mintCorrectionConfirmToken({ workspaceId: "ws-1", factId, verb, payload });
  return { factId, verb, ...payload, token };
}

/** `res.json()` is `unknown`; every assertion here reads a known envelope. */
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/v1/brain-corrections/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/brain-corrections/confirm", () => {
  it("applies a confirmed correction and returns the projected result", async () => {
    const res = await app().fetch(post(stagedBody({ reason: "wrong" })));
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("corrected");
    expect(json.factId).toBe(FACT);
    expect(json.correctionEpisodeId).toBe("ep-1");
    expect(correctCalls).toHaveLength(1);
  });

  it("records intent as `confirmed` — a human clicked and the server verified it", async () => {
    // #5496's audit criterion, at the one entry point that can honestly claim it.
    await app().fetch(post(stagedBody()));
    expect(correctCalls[0]?.intent).toBe("confirmed");
  });

  it("hands correctFact the LIVE re-resolved context, not anything from the payload", async () => {
    // This is what makes the endpoint not a trusted fast-path: the ctx the verb
    // gates on comes from `resolveBrainReaderContext` on THIS request, so a role
    // revoked between staging and confirming is refused by the machinery.
    await app().fetch(post(stagedBody()));
    expect(correctCalls[0]?.ctx).toEqual(READER_CTX);
    // …and the vocabulary is loaded live too, never carried in the payload.
    expect(correctCalls[0]?.vocabulary).toBeDefined();
  });

  it("reports flagged dependents as a COUNT and leaks no dependent id (#4939)", async () => {
    const res = await app().fetch(post(stagedBody()));
    const body = await res.text();
    const json = JSON.parse(body) as Record<string, unknown>;

    expect(json.flaggedForReReviewCount).toBe(2);
    expect(json).not.toHaveProperty("flaggedForReReview");
    // The rule, not the field name: NO id from the un-ACL-gated set may appear
    // anywhere in the response, under any key.
    for (const id of CORRECTED.result.flaggedForReReview) {
      expect(
        body,
        `the confirm response contains dependent id "${id}" — those come from a query with no ACL, so a subset names facts this actor cannot read`,
      ).not.toContain(id);
    }
  });

  describe("the token gate", () => {
    it("refuses a confirm with no token as a validation error, and never runs the verb", async () => {
      const { token: _dropped, ...withoutToken } = stagedBody();
      const res = await app().fetch(post(withoutToken));
      expect(res.status).toBe(422);
      expect(correctCalls).toHaveLength(0);
    });

    it("refuses a tampered payload — the verb never runs", async () => {
      // ⭐ The acceptance criterion: "a tampered payload cannot escalate". The
      // token was minted for a `retract`; the body claims a `supersede`.
      const staged = stagedBody({ verb: "retract" });
      const res = await app().fetch(
        post({ ...staged, verb: "supersede", replacement: { object: "Evil" } }),
      );
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error).toBe("confirm_token_invalid");
      expect(
        correctCalls,
        "a tampered confirm payload reached the verb machinery — the token binding must refuse it first",
      ).toHaveLength(0);
    });

    it("refuses a token minted for a different workspace", async () => {
      const foreign = mintCorrectionConfirmToken({
        workspaceId: "ws-evil",
        factId: FACT,
        verb: "retract",
        payload: {},
      });
      const res = await app().fetch(post({ factId: FACT, verb: "retract", token: foreign }));
      expect(res.status).toBe(400);
      expect(correctCalls).toHaveLength(0);
    });

    it("returns ONE neutral message for every probeable token failure", async () => {
      // The specific reason is logged server-side and never returned — a caller
      // must not be able to probe which check tripped.
      const tampered = await app().fetch(post({ ...stagedBody(), verb: "pin" }));
      const garbage = await app().fetch(
        post({ factId: FACT, verb: "retract", token: "not-a-token" }),
      );
      expect(await jsonOf(tampered)).toEqual(await jsonOf(garbage));
    });

    it("burns the token — a replayed confirm is refused and the verb runs once", async () => {
      // ⭐ "The token is single-use: a replayed confirm is rejected. A looping
      // agent cannot re-fire." Same app instance, same body, twice.
      const a = app();
      const body = stagedBody();

      const first = await a.fetch(post(body));
      expect(first.status).toBe(200);

      const second = await a.fetch(post(body));
      expect(second.status).toBe(400);
      expect((await jsonOf(second)).error).toBe("confirm_token_invalid");
      expect(
        correctCalls,
        "a replayed confirm reached the verb machinery a second time — the nonce burn must refuse it",
      ).toHaveLength(1);
    });

    it("spends the nonce on the ATTEMPT, not on success", async () => {
      // Deliberate: a caller must not be able to re-fire one confirmation
      // against many states until one lands.
      correctionResult = () => ({ kind: "not-found" });
      const a = app();
      const body = stagedBody();

      expect((await a.fetch(post(body))).status).toBe(404);
      const replay = await a.fetch(post(body));
      expect(replay.status).toBe(400);
      expect((await jsonOf(replay)).error).toBe("confirm_token_invalid");
    });
  });

  describe("the machinery's refusals reach HTTP unchanged", () => {
    it("maps an authority refusal to 403", async () => {
      correctionResult = () => ({
        kind: "refused",
        reason: "NOT_AUTHORIZED",
        message: "Corrections are an admin verb.",
      });
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(403);
      expect((await jsonOf(res)).error).toBe("correction_refused");
    });

    it("maps the tier-1 refusal to 409", async () => {
      correctionResult = () => ({
        kind: "refused",
        reason: "WAREHOUSE_TARGET",
        message: "Tier-1 has no correction path.",
      });
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(409);
    });

    it("maps a missing replacement to 400", async () => {
      correctionResult = () => ({
        kind: "refused",
        reason: "REPLACEMENT_MISSING",
        message: "Superseding needs the corrected value.",
      });
      const res = await app().fetch(post(stagedBody({ verb: "supersede" })));
      expect(res.status).toBe(400);
    });

    it("maps not-found to one indistinguishable 404", async () => {
      correctionResult = () => ({ kind: "not-found" });
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(404);
      expect(String((await jsonOf(res)).message)).toContain("may not exist");
    });
  });

  describe("degraded paths", () => {
    it("returns 503 with an actionable message when the vocabulary closure is half-rebuilt", async () => {
      vocabularyResult = () => {
        throw new MockVocabularyClosureError("half-rebuilt");
      };
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(503);
      const json = await jsonOf(res);
      expect(json.error).toBe("vocabulary_incomplete");
      // Retrying cannot clear it, so the copy must not invite a loop.
      expect(String(json.message)).toContain("Retrying will not help");
      expect(correctCalls).toHaveLength(0);
    });

    it("returns 500 when the actor's identity cannot be resolved", async () => {
      readerContextResult = () => {
        throw new MockBrainReaderIdentityError("no principals");
      };
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(500);
      expect((await jsonOf(res)).error).toBe("reader_unresolved");
      expect(correctCalls).toHaveLength(0);
    });

    it("returns 400 when the session carries no active workspace", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "session" as const,
        user: { id: "u-1", email: "ada@example.com", role: "admin", mode: "session" },
      } as unknown as AuthResult);
      const res = await app().fetch(post(stagedBody()));
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error).toBe("no_workspace");
      expect(correctCalls).toHaveLength(0);
    });
  });
});
