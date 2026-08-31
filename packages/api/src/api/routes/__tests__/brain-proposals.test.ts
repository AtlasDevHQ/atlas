/**
 * Route tests for POST /api/v1/brain-proposals/confirm — the confirm-before-write
 * execution point for chat-staged brain proposals (#5482, ADR-0036 §T7).
 *
 * Mirrors `brain-corrections.test.ts`'s isolation: a minimal Hono app with only
 * this route mounted, the auth middleware mocked to an authenticated workspace
 * MEMBER (not an admin — the verb is deliberately not admin-gated), and the verb
 * machinery stubbed so the ROUTE's contract is what is under test.
 *
 * The security contract:
 *   - ⭐ This endpoint is the ONLY caller of `proposeFact`, and therefore the
 *     only path from a chat turn to `reconcileFacts`. That covers BOTH halves of
 *     what the verb can do — creating a draft, and recording a corroborating
 *     provenance edge against a live fact — because they are one function.
 *   - The endpoint is **NOT a trusted fast-path**. It re-resolves the actor and
 *     hands `proposeFact` that live context, and loads the workspace's real
 *     vocabulary rather than trusting anything staged.
 *   - The token binds the CLAIM. A payload edited after staging fails
 *     verification and the verb never runs — which matters more here than for a
 *     correction, because the staged text IS the assertion.
 *   - The nonce burns. A replayed confirm — or a looping agent re-posting its
 *     staged payload — is refused, on the corroboration path as much as the
 *     draft one.
 */
import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createHash } from "node:crypto";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// --- Auth (mirrors brain-corrections.test.ts, at the lowest role) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "session" as const,
    user: {
      id: "u-1",
      email: "ada@example.com",
      // A plain member. `correct_fact`'s route test uses an admin because that
      // verb has an authority gate; this one must work for exactly the person
      // that gate would have turned away.
      role: "member",
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
 * answers however `BETTER_AUTH_SECRET` is arranged.
 */
const TEST_KEY = createHash("sha256").update("brain-proposal-route-test-key").digest();
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
  role: "member" as const,
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
  readonly norm = "billing";
}
const IDENTITY_VOCABULARY = {
  subject: (n: string) => n,
  predicate: (n: string) => n,
  object: (n: string) => n,
};
let vocabularyResult: () => unknown = () => IDENTITY_VOCABULARY;
void mock.module("@atlas/api/lib/brain/vocabulary", () => ({
  VocabularyClosureError: MockVocabularyClosureError,
  loadWorkspaceVocabulary: async () => vocabularyResult(),
}));

// The verb machinery, stubbed: this file tests the ROUTE. `proposeCalls` is what
// makes "the endpoint hands the verb a LIVE context" observable — and what makes
// "the verb never ran" assertable on every rejection arm.
const PROPOSED = {
  kind: "proposed" as const,
  result: {
    factId: "fact-1",
    status: "draft" as const,
    proposalEpisodeId: "ep-1",
    provisional: false,
    tensionEdges: 0,
  },
};
const CORROBORATED = {
  kind: "corroborated" as const,
  result: { factId: "fact-existing", proposalEpisodeId: "ep-1", evidenceAdded: true },
};
let proposeCalls: Array<Record<string, unknown>> = [];
let proposalResult: () => unknown = () => PROPOSED;
// Mock-all-exports: the factory lists every VALUE export `proposal.ts` has.
void mock.module("@atlas/api/lib/brain/proposal", () => ({
  PROPOSAL_EPISODE_INSERT_SQL: "INSERT",
  PROPOSAL_REFUSAL_REASONS: {
    malformedClaim: "MALFORMED_CLAIM",
    sessionNotFound: "SESSION_NOT_FOUND",
  } satisfies typeof import("@atlas/api/lib/brain/proposal").PROPOSAL_REFUSAL_REASONS,
  proposalGrantTokens: () => ["org"],
  proposeFact: async (request: Record<string, unknown>) => {
    proposeCalls.push(request);
    return proposalResult();
  },
}));

// Import after mocks.
const { Hono } = await import("hono");
const { createBrainProposalsRoute } = await import("../brain-proposals");
const { PROPOSAL_STAGED_VERB } = await import("@atlas/api/lib/brain/staged-propose");
const { mintStagedConfirmToken } = await import("@atlas/api/lib/brain/staged-write");
const { _resetConfirmNonces } = await import("@atlas/api/lib/confirm-token");
const { CORRECTION_STAGED_VERB } = await import("@atlas/api/lib/brain/staged-correct");

const CLAIM = { subject: "Ana", predicate: "is the DRI for", object: "billing" };

beforeEach(() => {
  proposeCalls = [];
  proposalResult = () => PROPOSED;
  readerContextResult = () => READER_CTX;
  vocabularyResult = () => IDENTITY_VOCABULARY;
  _resetConfirmNonces();
});

function app() {
  const a = new Hono();
  a.route("/api/v1/brain-proposals", createBrainProposalsRoute());
  return a;
}

/** A staged confirm payload with a real, correctly-bound token. */
function stagedBody(
  overrides: {
    subject?: string;
    predicate?: string;
    object?: string;
    reason?: string;
    validFrom?: string;
    session?: { conversationId: string };
  } = {},
) {
  const claim = {
    subject: overrides.subject ?? CLAIM.subject,
    predicate: overrides.predicate ?? CLAIM.predicate,
    object: overrides.object ?? CLAIM.object,
    ...(overrides.validFrom !== undefined ? { validFrom: overrides.validFrom } : {}),
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
  };
  const token = mintStagedConfirmToken(PROPOSAL_STAGED_VERB, {
    workspaceId: "ws-1",
    claim,
    ...(overrides.session !== undefined ? { session: overrides.session } : {}),
  });
  return {
    ...claim,
    ...(overrides.session !== undefined ? { session: overrides.session } : {}),
    token,
  };
}

/** The session ref #5486's tests stage. */
const SESSION = { conversationId: "11111111-2222-4333-8444-555555555555" };

function post(body: unknown): Request {
  return new Request("http://localhost/api/v1/brain-proposals/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** The invariant every rejection arm restates. */
function expectNoWrite() {
  expect(
    proposeCalls,
    "the confirm endpoint reached the verb on a rejected request — nothing may write without a verified, burned token (#5482)",
  ).toHaveLength(0);
}

describe("POST /api/v1/brain-proposals/confirm", () => {
  it("records a confirmed proposal as a draft and returns the outcome", async () => {
    const res = await app().fetch(post(stagedBody({ reason: "standup" })));
    expect(res.status).toBe(200);

    const json = await jsonOf(res);
    expect(json.outcome).toBe("proposed");
    expect(json.status).toBe("draft");
    expect(json.factId).toBe("fact-1");
    expect(json.proposalEpisodeId).toBe("ep-1");
    expect(proposeCalls).toHaveLength(1);
  });

  it("distinguishes the corroboration outcome instead of reporting a draft", async () => {
    // The card says different things for each, because telling a user their
    // fact is queued for review when nothing was queued is exactly the confident
    // wrongness the confirm flow exists to remove.
    proposalResult = () => CORROBORATED;
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(200);

    const json = await jsonOf(res);
    expect(json.outcome).toBe("corroborated");
    expect(json.factId).toBe("fact-existing");
    expect(json.evidenceAdded).toBe(true);
    expect(json).not.toHaveProperty("status");
  });

  it("works for an ordinary member — the verb is not admin-gated", async () => {
    // The authority asymmetry with `correct_fact`, at the route. The mocked
    // session already carries `role: "member"`, so a 200 here IS the assertion.
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(200);
  });

  it("hands proposeFact the LIVE re-resolved context, not anything from the payload", async () => {
    await app().fetch(post(stagedBody()));
    expect(proposeCalls[0]?.ctx).toEqual(READER_CTX);
  });

  it("loads the workspace's real vocabulary rather than trusting the staged payload", async () => {
    // A vocabulary is workspace STATE and may have moved since staging. It is
    // never degraded: an empty one would key the claim under a different
    // identity function than ingest used.
    await app().fetch(post(stagedBody()));
    expect(proposeCalls[0]?.vocabulary).toBe(IDENTITY_VOCABULARY);
  });

  it("#5486 — threads a staged session through to the verb, verified against the token", async () => {
    const res = await app().fetch(post(stagedBody({ session: SESSION })));
    expect(res.status).toBe(200);
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]?.session).toEqual(SESSION);
  });

  it("#5486 — a session-less confirm hands the verb no session at all", async () => {
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(200);
    expect(proposeCalls[0]).not.toHaveProperty("session");
  });

  it("parses validFrom into a Date on its way into the verb", async () => {
    await app().fetch(post(stagedBody({ validFrom: "2026-01-15T00:00:00Z" })));
    const claim = proposeCalls[0]?.claim as Record<string, unknown>;
    expect(claim.validFrom).toBeInstanceOf(Date);
    expect((claim.validFrom as Date).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("the confirm token gate", () => {
  it("rejects a request with no token at all", async () => {
    const { token: _token, ...withoutToken } = stagedBody();
    const res = await app().fetch(post(withoutToken));
    expect(res.status).toBe(422);
    expectNoWrite();
  });

  it("rejects a forged token with one neutral 400", async () => {
    const res = await app().fetch(post({ ...stagedBody(), token: "not.a.token" }));
    expect(res.status).toBe(400);
    const json = await jsonOf(res);
    expect(json.error).toBe("confirm_token_invalid");
    // The specific reason is logged, never returned — telling a caller which
    // check tripped is how a pipeline gets probed.
    expect(JSON.stringify(json)).not.toContain("malformed");
    expectNoWrite();
  });

  it("⭐ rejects a claim edited after staging — the token binds the assertion", async () => {
    // The tamper that matters most on this verb. A correction's token binds an
    // id and a verb; here the staged TEXT is the whole substance of what the
    // human agreed to assert, so swapping any slot must fail the binding.
    const staged = stagedBody({ object: "billing" });
    const res = await app().fetch(post({ ...staged, object: "payroll" }));
    expect(res.status).toBe(400);
    expectNoWrite();
  });

  it("rejects a subject or predicate swapped after staging", async () => {
    const staged = stagedBody();
    expect((await app().fetch(post({ ...staged, subject: "Bo" }))).status).toBe(400);
    expect((await app().fetch(post({ ...staged, predicate: "reports to" }))).status).toBe(400);
    expectNoWrite();
  });

  it("rejects a reason added after staging", async () => {
    // `reason` is recorded verbatim in the episode and shown to the reviewer, so
    // it is part of what was consented to, not decoration.
    const staged = stagedBody();
    const res = await app().fetch(post({ ...staged, reason: "injected" }));
    expect(res.status).toBe(400);
    expectNoWrite();
  });

  it("⭐ #5486 — rejects a session added, dropped, or swapped after staging", async () => {
    // The provenance the human consented to is the provenance that lands: the
    // session is in the token's one hash, so a tampered card cannot attach a
    // different conversation (whose ACL context would seed the grant) or
    // detach the one the card named.
    const withSession = stagedBody({ session: SESSION });
    const withoutSession = stagedBody();

    // Added after staging.
    let res = await app().fetch(post({ ...withoutSession, session: SESSION }));
    expect(res.status).toBe(400);
    // Dropped after staging.
    const { session: _dropped, ...detached } = withSession;
    res = await app().fetch(post(detached));
    expect(res.status).toBe(400);
    // Swapped after staging.
    res = await app().fetch(
      post({
        ...withSession,
        session: { conversationId: "99999999-2222-4333-8444-555555555555" },
      }),
    );
    expect(res.status).toBe(400);
    expectNoWrite();
  });

  it("#5486 — rejects a non-uuid session id at the schema, before any token work", async () => {
    const res = await app().fetch(
      post({ ...stagedBody(), session: { conversationId: "not-a-uuid" } }),
    );
    expect(res.status).toBe(422);
    expectNoWrite();
  });

  it("rejects a token minted for another workspace", async () => {
    const token = mintStagedConfirmToken(PROPOSAL_STAGED_VERB, { workspaceId: "ws-other", claim: CLAIM });
    const res = await app().fetch(post({ ...CLAIM, token }));
    expect(res.status).toBe(400);
    expectNoWrite();
  });

  it("⭐ rejects a CORRECTION confirm token presented here", async () => {
    // Both gates sign with the same keyset, so the `typ` domain separator is the
    // only thing standing between them. A human agreeing to change an existing
    // claim must not have that consent spent on asserting a new one.
    const token = mintStagedConfirmToken(CORRECTION_STAGED_VERB, {
      workspaceId: "ws-1",
      factId: "6f2c0000-0000-4000-8000-000000000000",
      verb: "retract",
      payload: {},
    });
    const res = await app().fetch(post({ ...CLAIM, token }));
    expect(res.status).toBe(400);
    expectNoWrite();
  });

  it("rejects an expired token", async () => {
    const token = mintStagedConfirmToken(PROPOSAL_STAGED_VERB,
      { workspaceId: "ws-1", claim: CLAIM },
      { nowSeconds: Math.floor(Date.now() / 1000) - 7200 },
    );
    const res = await app().fetch(post({ ...CLAIM, token }));
    expect(res.status).toBe(400);
    expectNoWrite();
  });
});

describe("the nonce burn — single use", () => {
  it("⭐ refuses a replayed confirm, so a looping agent cannot re-fire it", async () => {
    const body = stagedBody();
    expect((await app().fetch(post(body))).status).toBe(200);
    expect(proposeCalls).toHaveLength(1);

    const replay = await app().fetch(post(body));
    expect(replay.status).toBe(400);
    const json = await jsonOf(replay);
    expect(String(json.message)).toContain("already used");
    // The verb ran exactly once.
    expect(proposeCalls).toHaveLength(1);
  });

  it("⭐ the burn covers the corroboration path too, where a second write is a second ATTESTATION", async () => {
    // The stealthier half. A replayed corroboration is not a duplicate row a
    // reviewer would notice — it is one person's voice counted twice in the
    // distinct-source corroboration count, invisible in the UI and wrong in the
    // direction that inflates confidence.
    proposalResult = () => CORROBORATED;
    const body = stagedBody();
    expect((await app().fetch(post(body))).status).toBe(200);
    expect((await app().fetch(post(body))).status).toBe(400);
    expect(proposeCalls).toHaveLength(1);
  });

  it("spends the nonce on the ATTEMPT, so a refused confirm cannot be re-fired", async () => {
    // Deliberate, on `brain-corrections.ts`'s reasoning: a caller must not be
    // able to re-fire one confirmation against many claims. The user re-states
    // and the agent stages a fresh one.
    proposalResult = () => ({
      kind: "refused" as const,
      reason: "MALFORMED_CLAIM",
      message: "The claim's object asserts nothing that can be recorded.",
    });
    const body = stagedBody();
    const first = await app().fetch(post(body));
    expect(first.status).toBe(400);
    expect((await jsonOf(first)).error).toBe("proposal_refused");

    proposalResult = () => PROPOSED;
    const replay = await app().fetch(post(body));
    expect(replay.status).toBe(400);
    expect((await jsonOf(replay)).error).toBe("confirm_token_invalid");
    expect(proposeCalls).toHaveLength(1);
  });
});

describe("degraded paths", () => {
  it("refuses with 500 when the actor's identity cannot be resolved", async () => {
    readerContextResult = () => {
      throw new MockBrainReaderIdentityError("no principals");
    };
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toBe("reader_unresolved");
    expectNoWrite();
  });

  it("refuses with 503 and no retry advice when the alias vocabulary is half-rebuilt", async () => {
    // Deterministic and permanent until an operator recomputes the closure, so
    // the copy must not invite a loop.
    vocabularyResult = () => {
      throw new MockVocabularyClosureError("half-rebuilt");
    };
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(503);
    const json = await jsonOf(res);
    expect(json.error).toBe("vocabulary_incomplete");
    expect(String(json.message)).toContain("Retrying will not help");
  });

  it("maps a machinery throw to a secret-free 500", async () => {
    proposalResult = () => {
      throw new Error("connection to postgresql://user:hunter2@db failed");
    };
    const res = await app().fetch(post(stagedBody()));
    expect(res.status).toBe(500);
    const json = await jsonOf(res);
    expect(JSON.stringify(json)).not.toContain("hunter2");
    expect(String(json.message)).toContain("nothing was changed");
  });

  it("rejects an oversized surface before any token work", async () => {
    const res = await app().fetch(
      post({ ...CLAIM, object: "x".repeat(2_001), token: "irrelevant" }),
    );
    expect(res.status).toBe(422);
    expectNoWrite();
  });

  it("rejects a blank surface at the schema, not at the seam", async () => {
    const res = await app().fetch(post({ ...CLAIM, subject: "", token: "irrelevant" }));
    expect(res.status).toBe(422);
    expectNoWrite();
  });
});
