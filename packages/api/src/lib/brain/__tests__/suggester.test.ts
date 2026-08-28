/**
 * The autonomous suggester (#5488) — each of the issue's acceptance criteria
 * pinned where it can actually fail:
 *
 *   - **Off by default** — the registry entry defaults `"false"` and a fresh
 *     workspace resolves disabled.
 *   - **Per-workspace, platform footgun stated** — SaaS enrollment reads
 *     explicit workspace overrides only, so a platform-scoped `true` enrolls
 *     nobody; the enumeration's tenant-safety filters are pinned byte-wise.
 *   - **Draft-only / never publishes** — the module's only fact-writing seam
 *     is `reconcileFacts` (whose INSERT never names `status`, so 0180's
 *     `DEFAULT 'draft'` applies and the #5483 gate is the only exit); a
 *     source scan refuses any promotion import, status write, or deletion.
 *   - **Distinguishable** — every claim crosses the seam stamped
 *     `producer: BRAIN_SUGGESTER_PRODUCER`, a value distinct from both the
 *     proposal's and the extractor's. (The rendering half lives in
 *     `review-honesty.test.tsx`.)
 *   - **`learn/` stays a distinct class** — a boundary scan asserts zero
 *     brain references across `lib/learn/`.
 *   - **Disabling stops production and deletes nothing** — an empty
 *     enrollment produces zero work, and the no-delete half is structural
 *     (the source scan above).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_PROPOSAL_PRODUCER, BRAIN_SUGGESTER_PRODUCER } from "@useatlas/schemas";
import {
  loadSettings,
  _resetSettingsCache,
  getSettingDefinition,
} from "@atlas/api/lib/settings";
import type { ResolvedConfig } from "@atlas/api/lib/config";
import { _setConfigForTest, _resetConfig } from "@atlas/api/lib/config";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { BRAIN_EXTRACTION_PRODUCER } from "@atlas/api/lib/brain/extract-contract";
import {
  CONVERSATION_OWNERSHIP_SQL,
  SESSION_EPISODE_INSERT_SQL,
  SESSION_SOURCE_ID_PREFIX,
} from "@atlas/api/lib/brain/session-episode";
import type {
  FactCandidate,
  ReconcileExecutor,
  ReconcileReport,
  ReconcileRequest,
} from "@atlas/api/lib/brain/reconcile";

// ---------------------------------------------------------------------------
// Mock internal DB — the promote-decay scheduler test's shape: `internalQuery`
// branches on the SQL so the SaaS enrollment enumeration, the self-hosted org
// listing, the conversation selection and the transcript read each get their
// own drivable rows while `loadSettings()` still gets `settingsRows`.
// ---------------------------------------------------------------------------
let dbAvailable = false;
let settingsRows: Array<{
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
  org_id: string | null;
}> = [];

let optedInOrgRows: Array<{ org_id: string }> = [];
let selfHostedOrgRows: Array<{ id: string }> = [];
let enumerationSql: string | null = null;
let enumerationParams: unknown[] | null = null;

let conversationRows: Array<{ id: string; user_id: string; updated_at: string }> = [];
let conversationSql: string | null = null;
let messageRowsByConversation = new Map<string, Array<{ role: string; content: unknown }>>();

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("SELECT DISTINCT s.org_id")) {
      enumerationSql = sql;
      enumerationParams = params ?? null;
      return optedInOrgRows;
    }
    if (typeof sql === "string" && sql.includes("FROM organization ORDER BY id")) {
      return selfHostedOrgRows;
    }
    if (typeof sql === "string" && sql.includes("FROM conversations")) {
      conversationSql = sql;
      return conversationRows;
    }
    if (typeof sql === "string" && sql.includes("FROM messages")) {
      const first = params?.[0];
      const conversationId = typeof first === "string" ? first : "";
      return messageRowsByConversation.get(conversationId) ?? [];
    }
    return settingsRows;
  },
  internalExecute: () => {},
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const {
  runSuggesterTick,
  isSuggesterEnabledForWorkspace,
  getSuggesterIntervalMs,
  assembleTranscript,
  messageText,
  _resetSuggesterLedger,
  SUGGESTER_ENABLED_KEY,
  DEFAULT_SUGGESTER_INTERVAL_MS,
  CANDIDATE_CONVERSATIONS_SQL,
  MIN_TRANSCRIPT_CHARS,
  CONVERSATIONS_PER_TICK,
} = await import("@atlas/api/lib/brain/suggester");

/** Fully-typed `ResolvedConfig` so a `deployMode` typo can't compile silently. */
function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

const HOUR = 60 * 60 * 1000;
/** A real UUID — `materializeSessionEpisode` refuses malformed ids before any query. */
const CONV_ID = "00000000-0000-4000-8000-000000000001";
/** Idle long enough to qualify, recent enough to be inside the lookback. */
const idleUpdatedAt = () => new Date(Date.now() - 2 * HOUR).toISOString();

/** A transcript comfortably past the substance floor. */
const CHATTY = [
  { role: "user", content: `Ana runs the billing team now, took over from Priya last sprint. ${"x".repeat(MIN_TRANSCRIPT_CHARS)}` },
  { role: "assistant", content: "Noted — Ana owns billing." },
];

interface FakeSeams {
  reconcileRequests: ReconcileRequest[];
  reconcileReport: ReconcileReport;
  extractCalls: Array<{ body: string }>;
  candidates: readonly FactCandidate[];
  txQueries: Array<{ sql: string; params: unknown[] | undefined }>;
}

/** The injected collaborators one tick runs against, capture included. */
function fakeSeams(overrides: Partial<Pick<FakeSeams, "candidates" | "reconcileReport">> = {}) {
  const seams: FakeSeams = {
    reconcileRequests: [],
    reconcileReport: {
      outcomes: [{ kind: "created", factId: "f-1", provisional: false, tensionEdges: 0 }],
      // Only `outcomes` (and the absent `episodeBlocked`) are read by the
      // module; the report's counter fields are reconcile-internal bookkeeping
      // a capture double does not need to fabricate.
    } as unknown as ReconcileReport,
    extractCalls: [],
    candidates: [
      {
        subject: "Ana",
        predicate: "runs",
        object: "billing",
        detail: { extractor: BRAIN_EXTRACTION_PRODUCER, model: "test-model" },
      },
    ],
    txQueries: [],
    ...overrides,
  };

  const tx: ReconcileExecutor = {
    query: async (sql: string, params?: unknown[]) => {
      seams.txQueries.push({ sql, params });
      if (sql === CONVERSATION_OWNERSHIP_SQL) return { rows: [{ id: params?.[0] }] };
      if (sql === SESSION_EPISODE_INSERT_SQL) return { rows: [{ id: "ep-session-1" }] };
      return { rows: [] };
    },
  };

  const deps = {
    resolveModel: async () => ({
      model: { specificationVersion: "v2" } as never,
      modelId: "test-model",
      batchApiKey: null,
    }),
    extract: async ({ body }: { body: string }) => {
      seams.extractCalls.push({ body });
      return seams.candidates;
    },
    loadVocabulary: async () => identityVocabulary,
    withTransaction: <T,>(fn: (t: ReconcileExecutor) => Promise<T>): Promise<T> => fn(tx),
    reconcile: async (request: ReconcileRequest) => {
      seams.reconcileRequests.push(request);
      return seams.reconcileReport;
    },
  };

  return { seams, deps };
}

beforeEach(() => {
  delete process.env.ATLAS_BRAIN_SUGGESTER_ENABLED;
  delete process.env.ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS;
  _resetSettingsCache();
  _resetConfig();
  _resetSuggesterLedger();
  dbAvailable = false;
  settingsRows = [];
  optedInOrgRows = [];
  selfHostedOrgRows = [];
  enumerationSql = null;
  enumerationParams = null;
  conversationRows = [];
  conversationSql = null;
  messageRowsByConversation = new Map();
});

afterEach(() => {
  delete process.env.ATLAS_BRAIN_SUGGESTER_ENABLED;
  delete process.env.ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS;
  _resetSettingsCache();
  _resetConfig();
});

// ---------------------------------------------------------------------------
// ⭐ Off by default (acceptance criterion 1)
// ---------------------------------------------------------------------------

describe("⭐ off by default", () => {
  it("a fresh workspace resolves disabled — nothing set, nothing on", () => {
    expect(isSuggesterEnabledForWorkspace("ws-fresh")).toBe(false);
    expect(isSuggesterEnabledForWorkspace(null)).toBe(false);
    expect(isSuggesterEnabledForWorkspace(undefined)).toBe(false);
  });

  it("the registry entry is a workspace-scoped boolean defaulting \"false\", keyed by the exported constant", () => {
    // The promote-decay rename guard: the SaaS enumeration binds
    // SUGGESTER_ENABLED_KEY, so a registry rename that skipped the constant
    // would enroll ZERO workspaces with no other signal — this crosses the
    // constant against the REAL registry so drift ships red.
    const def = getSettingDefinition(SUGGESTER_ENABLED_KEY);
    expect(def).toBeDefined();
    expect(def?.scope).toBe("workspace");
    expect(def?.type).toBe("boolean");
    expect(def?.default).toBe("false");
    expect(def?.envVar).toBe(SUGGESTER_ENABLED_KEY);
    // Hot-reloaded (per-tick read), so never restart-bound.
    expect(def?.requiresRestart).toBeFalsy();
    // Where the promote/decay mirror deliberately breaks: every ATLAS_BRAIN_*
    // key is hidden from the generic settings page on Atlas Cloud — the
    // env-vars reference's universal claim, enforced by
    // check-brain-settings-doc.ts — so on SaaS the per-workspace opt-in row
    // is written by a platform admin, not self-served by the tenant.
    expect(def?.saasVisible).toBe(false);
  });

  it("the interval knob is platform operator policy", () => {
    const def = getSettingDefinition("ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS");
    expect(def?.scope).toBe("platform");
    expect(def?.requiresRestart).toBe(true);
  });

  it("interval defaults to 24h and survives junk", () => {
    expect(getSuggesterIntervalMs()).toBe(DEFAULT_SUGGESTER_INTERVAL_MS);
    process.env.ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS = "6";
    expect(getSuggesterIntervalMs()).toBe(6 * HOUR);
    process.env.ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS = "0";
    expect(getSuggesterIntervalMs()).toBe(DEFAULT_SUGGESTER_INTERVAL_MS);
    process.env.ATLAS_BRAIN_SUGGESTER_INTERVAL_HOURS = "abc";
    expect(getSuggesterIntervalMs()).toBe(DEFAULT_SUGGESTER_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// ⭐ Per-workspace enrollment, and the platform-scope footgun (criterion 2)
// ---------------------------------------------------------------------------

describe("⭐ per-workspace enrollment — a platform `true` enrolls nobody on SaaS", () => {
  it("SaaS enrollment binds the exported key and keeps its tenant-safety filters", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    const { deps } = fakeSeams();
    await runSuggesterTick(deps);
    expect(enumerationParams).toEqual([SUGGESTER_ENABLED_KEY]);
    // Explicit workspace rows only — the tier chain's platform/env tiers are
    // deliberately NOT consulted, which is the whole footgun statement.
    expect(enumerationSql).toContain("s.org_id IS NOT NULL");
    expect(enumerationSql).toContain("value IN ('true', '1')");
    expect(enumerationSql).toContain("JOIN organization");
  });

  it("on SaaS a platform-scoped/env `true` enrolls no workspace", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    // The footgun input: the dial is set everywhere EXCEPT a workspace row.
    process.env.ATLAS_BRAIN_SUGGESTER_ENABLED = "true";
    settingsRows = [
      {
        key: SUGGESTER_ENABLED_KEY,
        value: "true",
        updated_at: new Date().toISOString(),
        updated_by: null,
        org_id: null, // platform override, not a workspace's
      },
    ];
    await loadSettings();
    optedInOrgRows = []; // no explicit workspace override rows exist
    const { seams, deps } = fakeSeams();
    const result = await runSuggesterTick(deps);
    expect(result.workspacesConsidered).toBe(0);
    expect(seams.extractCalls).toEqual([]);
    expect(seams.reconcileRequests).toEqual([]);
  });

  it("on self-hosted the env var opts the deployment's workspace in — the degenerate case", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("self-hosted"));
    process.env.ATLAS_BRAIN_SUGGESTER_ENABLED = "true";
    selfHostedOrgRows = [{ id: "org-self" }];
    const { deps } = fakeSeams();
    const result = await runSuggesterTick(deps);
    expect(result.workspacesConsidered).toBe(1);
  });

  it("the conversation scan is workspace-scoped and skips harvested sessions on 0180's dedupe key", () => {
    expect(CANDIDATE_CONVERSATIONS_SQL).toContain("c.org_id = $1");
    expect(CANDIDATE_CONVERSATIONS_SQL).toContain("deleted_at IS NULL");
    // The owner is the grant seed; a conversation with no owner has no seed
    // that isn't a silent [org], so it is out of scope rather than widened.
    expect(CANDIDATE_CONVERSATIONS_SQL).toContain("c.user_id IS NOT NULL");
    // The durable watermark: the session episode, whoever minted it.
    expect(CANDIDATE_CONVERSATIONS_SQL).toContain("NOT EXISTS");
    expect(CANDIDATE_CONVERSATIONS_SQL).toContain(`'${SESSION_SOURCE_ID_PREFIX}' || c.id::text`);
  });
});

// ---------------------------------------------------------------------------
// ⭐ What crosses the seam: producer stamp, principal, draft-only (criteria 3+4)
// ---------------------------------------------------------------------------

describe("⭐ the reconcile crossing", () => {
  async function runOneConversation(overrides: Parameters<typeof fakeSeams>[0] = {}) {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    conversationRows = [{ id: CONV_ID, user_id: "u-owner", updated_at: idleUpdatedAt() }];
    messageRowsByConversation.set(CONV_ID, CHATTY);
    const { seams, deps } = fakeSeams(overrides);
    const result = await runSuggesterTick(deps);
    return { seams, result };
  }

  it("stamps every claim with the suggester producer — distinct from proposal and extractor", async () => {
    const { seams } = await runOneConversation();
    expect(seams.reconcileRequests).toHaveLength(1);
    const request = seams.reconcileRequests[0]!;
    expect(request.producer).toBe(BRAIN_SUGGESTER_PRODUCER);
    // The three producers a reviewer must be able to tell apart cannot share
    // a byte — collapse any two and the origin badge lies.
    expect(BRAIN_SUGGESTER_PRODUCER).not.toBe(BRAIN_PROPOSAL_PRODUCER);
    expect(BRAIN_SUGGESTER_PRODUCER).not.toBe(BRAIN_EXTRACTION_PRODUCER);
    // The provenance detail carries the machine too, not the borrowed
    // extraction contract's label.
    expect(request.candidates[0]?.detail?.extractor).toBe(BRAIN_SUGGESTER_PRODUCER);
  });

  it("attributes the claim to the conversation owner, not the machine (anti-inflation)", async () => {
    const { seams } = await runOneConversation();
    const request = seams.reconcileRequests[0]!;
    // A later human proposal of the same claim by the same person must count
    // as ONE distinct source — attributing the suggestion to a machine
    // principal would let the suggester manufacture corroboration weight out
    // of a conversation the human already stands behind (§T9 lock 5).
    expect(request.sourcePrincipal).toBe("user:u-owner");
    expect(request.episode.sourceActor).toBe("u-owner");
  });

  it("mints the session episode inside the same transaction, seeded to the owner — never [org]", async () => {
    const { seams } = await runOneConversation();
    // Ownership gate re-verified in-transaction, then the lazy mint.
    expect(seams.txQueries[0]?.sql).toBe(CONVERSATION_OWNERSHIP_SQL);
    const insert = seams.txQueries.find((q) => q.sql === SESSION_EPISODE_INSERT_SQL);
    expect(insert).toBeDefined();
    // $6 is the grant JSON: the owner's token, the narrowest defensible
    // audience — lock 3's "never a silent [org]".
    expect(insert?.params?.[5]).toBe(JSON.stringify(["user:u-owner"]));
    // And the reconcile episode carries that seed, not a widened one.
    expect(seams.reconcileRequests[0]?.episode.visibleTo).toEqual(["user:u-owner"]);
  });

  it("draft-only: a created outcome is counted as a draft; nothing else is written", async () => {
    const { seams, result } = await runOneConversation();
    expect(result.drafted).toBe(1);
    expect(result.corroborated).toBe(0);
    // The transaction saw exactly the ownership gate, the episode mint, and
    // whatever reconcile does behind its own seam — no status write, no
    // publish, no delete from THIS module.
    const sqls = seams.txQueries.map((q) => q.sql);
    expect(sqls.every((sql) => !/brain_facts/i.test(sql))).toBe(true);
  });

  it("a corroborated outcome is counted as corroboration, not as a draft", async () => {
    const { result } = await runOneConversation({
      reconcileReport: {
        outcomes: [{ kind: "corroborated", factId: "f-9", evidenceAdded: true }],
      } as unknown as ReconcileReport,
    });
    expect(result.drafted).toBe(0);
    expect(result.corroborated).toBe(1);
  });

  it("skips thin conversations without spending a model call, leaving them eligible", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    conversationRows = [{ id: CONV_ID, user_id: "u-owner", updated_at: idleUpdatedAt() }];
    messageRowsByConversation.set(CONV_ID, [{ role: "user", content: "hi" }]);
    const { seams, deps } = fakeSeams();
    const result = await runSuggesterTick(deps);
    expect(seams.extractCalls).toEqual([]);
    expect(result.conversationsScanned).toBe(0);
  });

  it("a no-find scan is remembered — the same conversation is not re-scanned while quiet", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    conversationRows = [{ id: CONV_ID, user_id: "u-owner", updated_at: idleUpdatedAt() }];
    messageRowsByConversation.set(CONV_ID, CHATTY);
    const { seams, deps } = fakeSeams({ candidates: [] });
    await runSuggesterTick(deps);
    expect(seams.extractCalls).toHaveLength(1);
    // Same updated_at → the ledger skips it; no episode was minted (a session
    // that yielded nothing materializes nothing — lock 3's lazy property).
    expect(seams.txQueries).toEqual([]);
    await runSuggesterTick(deps);
    expect(seams.extractCalls).toHaveLength(1);
  });

  it("a failed model call marks nothing, so the next tick retries", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    conversationRows = [{ id: CONV_ID, user_id: "u-owner", updated_at: idleUpdatedAt() }];
    messageRowsByConversation.set(CONV_ID, CHATTY);
    const { seams, deps } = fakeSeams();
    let calls = 0;
    const failing = {
      ...deps,
      extract: async () => {
        calls++;
        throw new Error("model boom");
      },
    };
    const first = await runSuggesterTick(failing);
    expect(first.errors).toBe(1);
    await runSuggesterTick(failing);
    expect(calls).toBe(2);
    expect(seams.reconcileRequests).toEqual([]);
  });

  it("an unresolvable model skips the workspace and touches nothing", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    optedInOrgRows = [{ org_id: "ws-1" }];
    const { seams, deps } = fakeSeams();
    const result = await runSuggesterTick({ ...deps, resolveModel: async () => null });
    expect(result.workspacesModelUnavailable).toBe(1);
    expect(seams.extractCalls).toEqual([]);
    expect(conversationSql).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⭐ Disabling stops production and deletes nothing (criterion 6)
// ---------------------------------------------------------------------------

describe("⭐ disabling stops production of new suggestions", () => {
  it("an empty enrollment produces zero work — the hot off-switch", async () => {
    dbAvailable = true;
    _setConfigForTest(configWithDeployMode("saas"));
    // Was enrolled last tick; the admin has since flipped the dial off, so
    // the enumeration comes back empty. Everything downstream must go quiet.
    optedInOrgRows = [];
    conversationRows = [{ id: CONV_ID, user_id: "u-owner", updated_at: idleUpdatedAt() }];
    messageRowsByConversation.set(CONV_ID, CHATTY);
    const { seams, deps } = fakeSeams();
    const result = await runSuggesterTick(deps);
    expect(result.workspacesConsidered).toBe(0);
    expect(seams.extractCalls).toEqual([]);
    expect(seams.reconcileRequests).toEqual([]);
  });

  it("source scan: the module can produce drafts and cannot delete, retract, or publish them", () => {
    // The other half of the criterion — "does not retroactively delete drafts
    // already raised" — held structurally: no DELETE, no tombstone write, no
    // status write, no promotion import exists in the module, so there is
    // nothing a disable path COULD reap with. The same scan is the
    // never-publishes pin: the one fact-writing seam referenced is
    // `reconcileFacts`, whose INSERT never names `status` (0180's DEFAULT
    // 'draft' applies), and the #5483 gate stays the only exit from draft.
    const source = readFileSync(
      join(import.meta.dir, "..", "suggester.ts"),
      "utf8",
    );
    expect(source).toContain("reconcileFacts");
    for (const forbidden of [
      /DELETE\s+FROM/i,
      /UPDATE\s+brain_facts/i,
      /INSERT\s+INTO\s+brain_facts/i,
      /invalidated_at/,
      /promoteBrainFacts/,
      /from\s+"@atlas\/api\/lib\/brain\/promotion"/,
      /correctFact/,
      /status\s*=\s*'published'/,
    ]) {
      expect(source.match(forbidden)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// ⭐ `learn/` stays a distinct class (criterion 5, ADR-0036 §T9 lock 4)
// ---------------------------------------------------------------------------

describe("⭐ learn/ holds zero brain references", () => {
  it("no module under lib/learn/ names brain_facts, reconcileFacts, or lib/brain", () => {
    // The grill measured this ("held by construction — fifteen modules, zero
    // references") and #5488's acceptance criteria say a merge must keep it
    // true: this suggester is MODELLED ON learn/'s trust dial and must not
    // turn query patterns into tier-2 facts — the boundary is the lock, and
    // this scan is the durable version of the grill's one-off measurement.
    // Shape mirrors session-episode.test.ts's ADR-0020 boundary scan.
    const learnDir = join(import.meta.dir, "..", "..", "learn");
    const files = readdirSync(learnDir).filter(
      (f) => /\.(ts|tsx)$/.test(f) && statSync(join(learnDir, f)).isFile(),
    );
    // Coverage first: an emptied directory must fail rather than pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    const NEEDLE = /brain_facts|reconcileFacts|lib\/brain/;
    for (const file of files) {
      const source = readFileSync(join(learnDir, file), "utf8");
      expect([file, NEEDLE.test(source)]).toEqual([file, false]);
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript assembly — pure helpers
// ---------------------------------------------------------------------------

describe("transcript assembly", () => {
  it("reads text from every stored content shape and ignores the rest", () => {
    expect(messageText("plain string")).toBe("plain string");
    expect(messageText({ parts: [{ type: "text", text: "a" }, { type: "tool-call" }] })).toBe("a");
    expect(messageText([{ type: "text", text: "b" }, { type: "image" }])).toBe("b");
    expect(messageText({ text: "c" })).toBe("c");
    expect(messageText(null)).toBe("");
    expect(messageText(42)).toBe("");
    expect(messageText({ parts: "not-an-array" })).toBe("");
  });

  it("keeps user and assistant turns only, as role-prefixed lines", () => {
    const transcript = assembleTranscript([
      { role: "user", content: "who owns billing?" },
      { role: "tool", content: "SELECT 1" },
      { role: "assistant", content: "Ana does." },
      { role: "system", content: "you are a helpful analyst" },
    ]);
    expect(transcript).toBe("user: who owns billing?\nassistant: Ana does.");
  });

  it("caps at the extraction contract's body bound", () => {
    const rows = Array.from({ length: 100 }, () => ({
      role: "user",
      content: "y".repeat(500),
    }));
    const transcript = assembleTranscript(rows);
    expect(transcript.length).toBeLessThanOrEqual(8_000);
  });

  it("the per-tick conversation cap is a small trickle, not a flood", () => {
    // Not a magic-number pin for its own sake: the review queue is the scarce
    // resource (ADR-0039), and a dial someone just turned on must not detonate
    // a backlog into it. Anyone raising this states the new queue math.
    expect(CONVERSATIONS_PER_TICK).toBeLessThanOrEqual(10);
  });
});
