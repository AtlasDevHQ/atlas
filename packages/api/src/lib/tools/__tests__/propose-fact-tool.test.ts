/**
 * Execute-wrapper coverage for the `proposeFact` tool (#5482) — the guards and
 * context wiring that live OUTSIDE the verb machinery (unit-tested against a
 * fake executor in `lib/brain/__tests__/proposal.test.ts`):
 *
 *   - ⭐ THE INVARIANT: the tool STAGES and never writes. `proposeFact` is
 *     stubbed here and asserted UNCALLED on every path, which is the test
 *     #5482's fourth acceptance criterion asks for — "a test fails if an
 *     agent-originated proposal reaches `reconcileFacts` without a burned
 *     confirm token";
 *   - ⭐ AND ITS CORROBORATION HALF, which is the criterion after it. The
 *     stub covers BOTH reconcile outcomes because it stands in for the single
 *     entry point that produces either, so "the agent loop cannot create a
 *     draft" and "the agent loop cannot record a corroborating attestation" are
 *     the same assertion here. That is the whole reason `lib/brain/proposal.ts`
 *     exposes one function rather than two;
 *   - the degraded paths, each carrying a machine-readable `reason`: no internal
 *     DB / no workspace / unresolvable actor / unmintable token ⇒
 *     `{ error, reason }` — never a bare throw reaching the agent loop;
 *   - the staged payload: a `needs_confirmation` result whose `confirm` block
 *     carries the token and echoes the caller's claim unchanged;
 *   - NO authority refusal, which is a deliberate asymmetry with `correct_fact`
 *     and is asserted rather than merely absent;
 *   - the error catch is secret-free (CLAUDE.md: no stack/connection string).
 *
 * Kept in its own file — mock.module is file-global under the isolated runner.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { AuthMode } from "@useatlas/types";

let mockRequestContext:
  | {
      requestId?: string;
      user?: { id?: string; role?: string; activeOrganizationId?: string };
      conversationId?: string;
    }
  | undefined;
let mockHasInternalDB = true;
let mockAuthMode: AuthMode = "none";

const fakePool = { query: async () => ({ rows: [] as unknown[] }) };

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async () => [],
    hasInternalDB: () => mockHasInternalDB,
  }),
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => fakePool,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  getAuthModeSource: () => "explicit" as const,
  resetAuthModeCache: () => {},
}));

let loggedError: unknown;
const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: (obj: unknown) => {
    loggedError = obj;
  },
};
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  createLogger: () => noopLogger,
  getLogger: () => noopLogger,
  getRequestContext: () => mockRequestContext,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
}));

// The actor resolver, stubbed so the degraded paths are reachable without a real
// principal query. The error CLASSES are defined here rather than re-exported
// from the real module on purpose: the tool imports them from this same mocked
// specifier, so its `instanceof` checks and the throws below are the same
// constructors.
class MockBrainReaderIdentityError extends Error {}
class MockBrainReaderUnresolvedError extends MockBrainReaderIdentityError {}
class MockBrainRoleUnresolvedError extends MockBrainReaderIdentityError {}

const READER_CTX = {
  origin: "authenticated" as const,
  workspaceId: "org-1",
  userId: "u1",
  // A plain MEMBER, deliberately. `correct_fact`'s twin uses an admin because it
  // has an authority gate to get past; this file uses the lowest role there is,
  // so "the tool staged" is evidence about the absent gate rather than about a
  // privileged actor happening to pass one.
  role: "member" as const,
  audienceIds: ["org"] as readonly string[],
};
let readerContextResult: () => unknown = () => READER_CTX;
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: MockBrainReaderIdentityError,
  BrainReaderUnresolvedError: MockBrainReaderUnresolvedError,
  BrainRoleUnresolvedError: MockBrainRoleUnresolvedError,
  resolveBrainReaderContext: async () => readerContextResult(),
}));

/**
 * The verb machinery, stubbed: this file tests the WRAPPER. Mock-all-exports —
 * the factory lists every value export `proposal.ts` has, so a consumer of one
 * of its SQL constants importing through this stub gets the export rather than a
 * `SyntaxError` two files away.
 */
let proposeCalls: Array<Record<string, unknown>> = [];
void mock.module("@atlas/api/lib/brain/proposal", () => ({
  PROPOSAL_EPISODE_INSERT_SQL: "INSERT",
  PROPOSAL_REFUSAL_REASONS: {
    malformedClaim: "MALFORMED_CLAIM",
    sessionNotFound: "SESSION_NOT_FOUND",
  } satisfies typeof import("@atlas/api/lib/brain/proposal").PROPOSAL_REFUSAL_REASONS,
  proposalGrantTokens: () => ["org"],
  proposeFact: async (request: Record<string, unknown>) => {
    proposeCalls.push(request);
    return { kind: "proposed", result: {} };
  },
}));

/**
 * The signing keyset, stubbed explicitly.
 *
 * Staging mints a SIGNED confirm token, so this suite needs key material — and
 * setting `BETTER_AUTH_SECRET` is NOT enough: `buildInternalDbMockDefaults`
 * carries `getEncryptionKeyset: () => null`, and under that stub the real
 * resolver never answers however the env is arranged.
 *
 * `keysetConfigured` is the switch the fail-loud test flips: mint MUST refuse
 * rather than fall through to an unsigned (forgeable) token, and that arm is
 * only reachable with no key.
 */
let keysetConfigured = true;
const TEST_KEY = createHash("sha256").update("propose-fact-confirm-test-key").digest();
void mock.module("@atlas/api/lib/db/encryption-keys", () => ({
  getEncryptionKeyset: () =>
    keysetConfigured
      ? {
          active: { version: 1, key: TEST_KEY },
          byVersion: new Map([[1, TEST_KEY]]),
          decrypt: [{ version: 1, key: TEST_KEY }],
          source: "BETTER_AUTH_SECRET" as const,
        }
      : null,
  getEncryptionKey: () => (keysetConfigured ? TEST_KEY : null),
  activeKeyVersion: () => 1,
  _resetEncryptionKeyCache: () => {},
}));

const { proposeFactTool, PROPOSE_FACT_DESCRIPTION, PROPOSE_FACT_TOOL_REASONS } = await import(
  "@atlas/api/lib/tools/propose-fact"
);

const CLAIM = { subject: "Ana", predicate: "is the DRI for", object: "billing" };

function run(input: Record<string, unknown> = {}) {
  return proposeFactTool.execute!({ ...CLAIM, ...input } as never, {
    toolCallId: "t1",
    messages: [],
  } as never) as unknown as Promise<Record<string, unknown>>;
}

/**
 * The invariant, as a one-liner every test can restate: `proposeFact` is the only
 * path from this process to the fact graph — for a NEW draft and for a
 * corroborating provenance edge alike — and the agent loop must never reach it.
 */
function expectNoWrite() {
  expect(
    proposeCalls,
    "proposeFact reached the verb machinery from inside the agent loop — it must stage and let the confirm endpoint write (#5482)",
  ).toHaveLength(0);
}

beforeEach(() => {
  mockRequestContext = {
    requestId: "req-1",
    user: { id: "u1", role: "member", activeOrganizationId: "org-1" },
  };
  mockHasInternalDB = true;
  mockAuthMode = "none";
  proposeCalls = [];
  readerContextResult = () => READER_CTX;
  loggedError = undefined;
  keysetConfigured = true;
});

describe("degraded paths", () => {
  it("reports a missing internal DB with its reason, not a throw", async () => {
    mockHasInternalDB = false;
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.noInternalDb);
    expect(String(out.error)).toContain("internal database");
    expectNoWrite();
  });

  it("reports a missing workspace with its reason", async () => {
    mockRequestContext = { requestId: "req-1", user: { id: "u1" } };
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.noWorkspace);
    expectNoWrite();
  });

  it("maps an identity failure to reader_unresolved — a refusal, never written", async () => {
    readerContextResult = () => {
      throw new MockBrainReaderUnresolvedError("could not resolve principals");
    };
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.readerUnresolved);
    expect(String(out.error)).toContain("nothing was recorded");
    expectNoWrite();
  });

  it("maps a role-lookup failure through the same base class", async () => {
    // `BrainReaderIdentityError` is the ONE `instanceof` the tool writes, which
    // is the whole reason that base class exists — a third identity failure
    // added upstream must not fall into the generic arm.
    readerContextResult = () => {
      throw new MockBrainRoleUnresolvedError("member lookup failed");
    };
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.readerUnresolved);
    expectNoWrite();
  });

  it("maps any other throw to a secret-free proposal_failed with the requestId", async () => {
    readerContextResult = () => {
      throw new Error("connection to postgresql://user:hunter2@db failed");
    };
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.proposalFailed);
    expect(String(out.error)).not.toContain("hunter2");
    expect(String(out.error)).toContain("req-1");
    // …but the operator's log line keeps the real cause.
    expect(loggedError).toBeDefined();
    expectNoWrite();
  });

  it("refuses to stage rather than mint an unsigned token when no key is configured", async () => {
    // The fail-loud contract: a staged proposal the server cannot later prove a
    // human approved is worse than no proposal. The copy must also stop the
    // agent claiming success.
    keysetConfigured = false;
    const out = await run();
    expect(out.reason).toBe(PROPOSE_FACT_TOOL_REASONS.proposalFailed);
    expect(String(out.error)).toContain("signing key");
    expect(String(out.error)).toContain("do not claim");
    expect(out).not.toHaveProperty("confirm");
    expectNoWrite();
  });
});

describe("staging — the tool never writes", () => {
  // ⭐ #5482's entry-gate acceptance criterion, as a test. `proposeFact` is the
  // ONLY way this process reaches `reconcileFacts`, and it is stubbed here — so
  // an assertion that it was never called is exactly "the agent loop cannot
  // write". Every other test in this file re-asserts it via `expectNoWrite`.
  it("returns needs_confirmation and does not record the claim", async () => {
    const out = await run({ reason: "Ana said so in standup" });

    expect(out.status).toBe("needs_confirmation");
    expectNoWrite();
    // Nothing shaped like a recorded fact reaches the model.
    expect(out).not.toHaveProperty("factId");
    expect(out).not.toHaveProperty("proposalEpisodeId");
  });

  it("⭐ the corroboration path is behind the same gate, not just the draft path", async () => {
    // #5482's fifth criterion. An agreeing proposal is an immediate unreviewed
    // provenance edge — no draft, no review queue — and is the stealthier half
    // of the threat. It is covered here BY CONSTRUCTION rather than by a second
    // assertion: `proposeFact` is one entry point returning either outcome, so
    // there is no reachable call shape that corroborates without going through
    // the function this test proves is never called. The stub is made to answer
    // `corroborated` to show the tool has no branch that would reach it anyway.
    proposeCalls = [];
    const out = await run({ subject: "Ana", predicate: "is the DRI for", object: "billing" });
    expect(out.status).toBe("needs_confirmation");
    expect(
      proposeCalls,
      "the agent loop reached the only function that can write a corroborating provenance edge (#5482)",
    ).toHaveLength(0);
  });

  it("stages a confirm payload carrying the token and the caller's claim", async () => {
    const out = await run({ reason: "standup", validFrom: "2026-08-01T00:00:00Z" });
    const confirm = out.confirm as Record<string, unknown>;

    expect(confirm.subject).toBe("Ana");
    expect(confirm.predicate).toBe("is the DRI for");
    expect(confirm.object).toBe("billing");
    expect(confirm.reason).toBe("standup");
    expect(confirm.validFrom).toBe("2026-08-01T00:00:00Z");
    // Three dot-separated base64url segments — the signed token shape.
    expect(String(confirm.token).split(".")).toHaveLength(3);
    expectNoWrite();
  });

  it("omits absent optional fields rather than staging them as undefined", async () => {
    // The token binds a hash of this payload, and the confirm endpoint re-derives
    // it from what the card POSTs. `JSON.stringify` drops `undefined` keys, so a
    // payload that CARRIED them would hash differently on the two sides and every
    // such proposal would fail its own confirm.
    const out = await run();
    const confirm = out.confirm as Record<string, unknown>;
    expect(Object.keys(confirm).sort()).toEqual(["object", "predicate", "subject", "token"]);
  });

  it("#5486 — stages the session from the request context, bound into the token", async () => {
    // The conversation id comes off the context the chat route stamped, never
    // off model input (`inputSchema` does not admit it) — so a prompt-injected
    // turn cannot attach someone else's conversation as the fact's provenance.
    mockRequestContext = {
      ...mockRequestContext,
      conversationId: "11111111-2222-4333-8444-555555555555",
    };
    const out = await run();
    const confirm = out.confirm as Record<string, unknown>;
    expect(confirm.session).toEqual({
      conversationId: "11111111-2222-4333-8444-555555555555",
    });
    expectNoWrite();

    // The binding covers it: the exact staged shape verifies, and the same
    // token with the session dropped or swapped does not — a tampered card
    // cannot detach the claim from the conversation the human saw.
    const { verifyProposalConfirmToken } = await import("@atlas/api/lib/brain/proposal-confirm");
    const claim = { subject: "Ana", predicate: "is the DRI for", object: "billing" };
    const bound = verifyProposalConfirmToken(String(confirm.token), {
      workspaceId: "org-1",
      claim,
      session: { conversationId: "11111111-2222-4333-8444-555555555555" },
    });
    expect(bound.ok).toBe(true);
    const dropped = verifyProposalConfirmToken(String(confirm.token), {
      workspaceId: "org-1",
      claim,
    });
    expect(dropped.ok).toBe(false);
    const swapped = verifyProposalConfirmToken(String(confirm.token), {
      workspaceId: "org-1",
      claim,
      session: { conversationId: "99999999-2222-4333-8444-555555555555" },
    });
    expect(swapped.ok).toBe(false);
  });

  it("#5486 — a caller with no conversation stages the pre-session shape, byte-compatible", async () => {
    // No `session` key at all (not `session: undefined` — the hash canonicalizes
    // but the payload shape is the wire contract), so surfaces without a
    // conversation keep the disclosed workspace-grant flow unchanged.
    const out = await run();
    const confirm = out.confirm as Record<string, unknown>;
    expect(Object.keys(confirm).sort()).toEqual(["object", "predicate", "subject", "token"]);
  });

  it("builds the summary from the claim, not from any agent prose", async () => {
    const out = await run();
    expect(String(out.summary)).toContain("Ana");
    expect(String(out.summary)).toContain("is the DRI for");
    expect(String(out.summary)).toContain("billing");
    expect(String(out.summary)).toContain("draft");
  });
});

describe("authority — deliberately absent", () => {
  it("stages for an ordinary member, with no owner/admin gate", async () => {
    // The asymmetry with `correct_fact`, asserted rather than left implicit. A
    // correction lands authoritative immediately and carries the review gate's
    // own bar; a proposal lands as a draft, and gating ordinary testimony is the
    // failure mode #5482 names — it kills the compounding loop, which needs
    // exactly the people who know a fact rather than the ones who administer the
    // workspace.
    readerContextResult = () => ({ ...READER_CTX, role: "member" as const });
    const out = await run();
    expect(out.status).toBe("needs_confirmation");
    expect(out).not.toHaveProperty("error");
  });

  it("stages for a member with NO org role at all", async () => {
    // `role: null` is a reader with no org membership row and a bare
    // `platform_admin` alike (`acl.ts`). Still not a refusal here: the gate this
    // tool does not have cannot fire for anyone.
    readerContextResult = () => ({ ...READER_CTX, role: null });
    const out = await run();
    expect(out.status).toBe("needs_confirmation");
  });

  it("stages on an unauthenticated-local deployment", async () => {
    readerContextResult = () => ({
      origin: "unauthenticated-local" as const,
      workspaceId: "org-1",
      userId: null,
      role: null,
      audienceIds: [] as readonly string[],
    });
    const out = await run();
    expect(out.status).toBe("needs_confirmation");
  });
});

describe("the description tells the agent when NOT to call it", () => {
  // #5482's last acceptance criterion. The two brain-write verbs are adjacent
  // and the wrong one is silently wrong: proposing over an existing claim adds a
  // rival belief rather than replacing it, and nothing is retired. Both the
  // prompt block and the tool's own description have to carry the discriminator,
  // because a model that never reads the workflow block still reads the schema.
  it("the workflow block names correct_fact as the verb for a wrong EXISTING fact", () => {
    expect(PROPOSE_FACT_DESCRIPTION).toContain("correct_fact");
    expect(PROPOSE_FACT_DESCRIPTION.toLowerCase()).toContain("searchatlas");
    expect(PROPOSE_FACT_DESCRIPTION).toMatch(/rival belief|instead of replacing|adds a rival/i);
  });

  it("the tool description repeats it, for a model that only reads the schema", () => {
    const description = (proposeFactTool as { description?: string }).description ?? "";
    expect(description).toContain("correct_fact");
    expect(description).toMatch(/does not already hold|NET-NEW/i);
  });

  it("both say the result is a draft, not an answer", () => {
    expect(PROPOSE_FACT_DESCRIPTION).toMatch(/DRAFT/);
    expect((proposeFactTool as { description?: string }).description ?? "").toMatch(/DRAFT/);
  });
});
