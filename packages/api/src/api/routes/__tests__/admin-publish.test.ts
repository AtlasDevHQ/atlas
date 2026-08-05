/**
 * Route-level tests for `admin-publish` — the atomic publish endpoint.
 *
 * The publish PHASES themselves are pinned by the content-mode registry tests
 * (`lib/content-mode/__tests__/registry.test.ts`) and the lib twin
 * (`lib/datasources/__tests__/mcp-lifecycle.test.ts`); here the registry is a
 * spy returning canned `PromotionReport[]`, so the assertions are about THIS
 * route's projection of the reports into the wire response (every promoted
 * surface — including `knowledgeDocuments`, v0.0.41), the audit metadata, and
 * the post-commit side effects (datasource reconcile, per-mode mirror bust).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import {
  collectRefusals,
  collectSupersessions,
  collectWidenings,
  countSupersessionsHeldBack,
  promotedCountsFromReports,
} from "@atlas/api/lib/content-mode/promoted";
import type { PromotionReport } from "@atlas/api/lib/content-mode/port";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const CURRENT_ORG = "org-1";

// Canned per-table promotion reports the registry spy returns (mutable per test).
// The real `PromotionReport`, not a local restatement: `refused` (#4769) was
// added to the port, and a hand-written shape here would have silently accepted
// fixtures the production type rejects — or worse, kept compiling after a
// rename.
let REPORTS: PromotionReport[] = [];
// When set, runPublishPhases fails — exercises the rollback + 500 path.
let PHASES_THROW = false;

const txControl: string[] = [];
function fakeTxClient() {
  return {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") txControl.push(sql);
      return { rows: [] };
    },
    release() {},
  };
}

const internalQuery = mock(async (): Promise<unknown[]> => []);
const reconcileCalls: string[] = [];
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery }),
  getInternalDB: () => ({ connect: async () => fakeTxClient() }),
  reconcileWorkspaceDatasources: async (orgId: string) => {
    reconcileCalls.push(orgId);
    return { registered: 0, deregistered: 0 };
  },
}));

// Partial mock, justified: the route lazy-imports EXACTLY ONE symbol from
// `semantic/sync` (`invalidateOrgModeRoots`, the #4208 post-commit mirror
// bust) and nothing else in this file imports the module.
const invalidateCalls: string[] = [];
void mock.module("@atlas/api/lib/semantic/sync", () => ({
  invalidateOrgModeRoots: (orgId: string) => {
    invalidateCalls.push(orgId);
  },
}));

void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const auditCalls: Array<{ actionType: string; metadata: Record<string, unknown> }> = [];
void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: { actionType: string; metadata: Record<string, unknown> }) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: { mode: { publish: "mode.publish" } },
}));

// Partial mock, justified: this file's import graph reaches only the exports
// stubbed below (isolated runner; an unmocked export reached later fails
// loudly). The route projects reports → wire counts via the REAL
// `promotedCountsFromReports` (deep-path import stays unmocked) over a mini
// registry tuple that mirrors the production key↔table mapping — so these
// tests pin the actual projection, not a re-implementation of it.
void mock.module("@atlas/api/lib/content-mode", () => ({
  CONTENT_MODE_TABLES: [
    { kind: "simple", key: "connections", table: "workspace_plugins" },
    { kind: "simple", key: "prompts", table: "prompt_collections" },
    { kind: "simple", key: "starterPrompts", table: "query_suggestions" },
    { kind: "simple", key: "knowledgeDocuments", table: "knowledge_documents" },
    { kind: "exotic", key: "semantic_entities", promotedKey: "entities" },
    { kind: "exotic", key: "brain_facts", promotedKey: "brainFacts" },
  ],
  promotedCountsFromReports,
  collectRefusals,
  // Re-exported through the real implementation, not a stub: the point of the
  // #4823 / #4912 audit assertions is that the ROUTE's sweep is the shared one.
  collectWidenings,
  collectSupersessions,
  countSupersessionsHeldBack,
  makeService: () => ({
    runPublishPhases: () =>
      Effect.try({
        try: () => {
          if (PHASES_THROW) throw new Error("phase boom");
          return REPORTS;
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }),
  }),
}));

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  archiveSingleConnection: async () => ({ status: "archived", entities: 0, prompts: 0 }),
  listIncompleteProfileLayers: async () => [],
  DEMO_CONNECTION_ID: "__demo__",
}));

void mock.module("@atlas/api/lib/demo-industry", () => ({
  readDemoIndustry: () => ({ ok: true, value: null }),
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  requireOrgContext: () =>
    async (c: { set: (k: string, v: unknown) => void; get?: unknown }, next: () => Promise<void>) => {
      c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
      c.set("authResult", { user: { id: "user-1" } });
      await next();
    },
}));

const { adminPublish } = await import("../admin-publish");

function publish(body: Record<string, unknown> = {}) {
  return adminPublish.request("/", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  REPORTS = [];
  PHASES_THROW = false;
  txControl.length = 0;
  reconcileCalls.length = 0;
  invalidateCalls.length = 0;
  auditCalls.length = 0;
  internalQuery.mockClear();
});

describe("POST /api/v1/admin/publish — promoted counts projection", () => {
  it("projects every per-table report into the wire response, knowledge included (#4206/v0.0.41)", async () => {
    REPORTS = [
      { table: "workspace_plugins", promoted: 1 },
      { table: "semantic_entities", promoted: 2, tombstonesApplied: 3 },
      { table: "prompt_collections", promoted: 4 },
      { table: "query_suggestions", promoted: 5 },
      { table: "knowledge_documents", promoted: 6 },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: Record<string, number>;
      deleted: { entities: number };
    };
    expect(body.promoted).toEqual({
      connections: 1,
      entities: 2,
      prompts: 4,
      starterPrompts: 5,
      knowledgeDocuments: 6,
      brainFacts: 0,
    });
    expect(body.deleted).toEqual({ entities: 3 });
    expect(txControl).toEqual(["BEGIN", "COMMIT"]);
  });

  it("a knowledge-documents-only publish is NOT reported as 'nothing promoted'", async () => {
    // A workspace whose only drafts are knowledge documents must not get back
    // an all-zero `promoted` block.
    REPORTS = [{ table: "knowledge_documents", promoted: 12 }];
    const res = await publish();
    const body = (await res.json()) as { promoted: Record<string, number> };
    expect(body.promoted.knowledgeDocuments).toBe(12);
    expect(Object.values(body.promoted).some((n) => n > 0)).toBe(true);
  });

  it("records every promoted surface in the audit metadata", async () => {
    REPORTS = [
      { table: "knowledge_documents", promoted: 7 },
      { table: "semantic_entities", promoted: 1, tombstonesApplied: 0 },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].metadata).toMatchObject({
      promotedKnowledgeDocuments: 7,
      promotedEntities: 1,
      promotedConnections: 0,
      promotedPrompts: 0,
      promotedStarterPrompts: 0,
    });
  });
});

describe("POST /api/v1/admin/publish — refused drafts (#4769)", () => {
  const REFUSAL = {
    rowId: "fact-1",
    reasons: ["GRANT_UNUSABLE"],
    detail: '"acme uses postgres" (fact-1) was not published because its grant contains no usable principal.',
  };

  it("surfaces every refusal at the TOP LEVEL of the response, not under warnings", async () => {
    // The whole point of criterion 2: a refused draft must reach the admin.
    // Top-level because it belongs to the shared PublishResult core (#4156) —
    // REST, MCP, and the CLI must all spell it the same way.
    REPORTS = [
      { table: "knowledge_documents", promoted: 2 },
      { table: "brain_facts", promoted: 1, refused: [REFUSAL] },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refusedDrafts?: Array<{ id: string; surface: string; reasons: string[]; detail: string }>;
      warnings?: Record<string, unknown>;
    };
    expect(body.refusedDrafts).toEqual([
      {
        id: "fact-1",
        surface: "brain_facts",
        reasons: ["GRANT_UNUSABLE"],
        detail: REFUSAL.detail,
      },
    ]);
    // Not nested under `warnings` — that block stays for incompleteLayers.
    expect(body.warnings).toBeUndefined();
  });

  it("still COMMITS — a refusal quarantines the row, not the workspace's publish", async () => {
    // The design decision this slice turns on. Failing the transaction would
    // let one bad fact wedge every other pending draft in the workspace.
    REPORTS = [
      { table: "workspace_plugins", promoted: 3 },
      { table: "brain_facts", promoted: 0, refused: [REFUSAL] },
    ];
    const res = await publish();
    expect(res.status).toBe(200);
    expect(txControl).toEqual(["BEGIN", "COMMIT"]);
    const body = (await res.json()) as { promoted: Record<string, number> };
    expect(body.promoted.connections).toBe(3);
  });

  it("OMITS the field entirely when nothing was refused", async () => {
    // Omitted, not `[]`: a client branches on presence, and an empty array
    // would be indistinguishable from an API that predates refusals.
    REPORTS = [{ table: "brain_facts", promoted: 5, refused: [] }];
    const res = await publish();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("refusedDrafts");
  });

  it("sweeps EVERY adapter's refusals, not just one named table", async () => {
    // Registry-derived, so a second refusing adapter is reported with no edit
    // here — the milestone-#81 under-report lesson applied to refusals.
    REPORTS = [
      { table: "brain_facts", promoted: 0, refused: [REFUSAL] },
      {
        table: "some_future_table",
        promoted: 0,
        refused: [{ rowId: "row-9", reasons: ["OTHER"], detail: "nope" }],
      },
    ];
    const res = await publish();
    const body = (await res.json()) as { refusedDrafts?: Array<{ surface: string }> };
    expect(body.refusedDrafts?.map((r) => r.surface)).toEqual([
      "brain_facts",
      "some_future_table",
    ]);
  });

  it("audits the TRUE refusal count even when the wire list is capped", async () => {
    // The cap bounds the RESPONSE, not the truth. An earlier cut passed the
    // capped array's length straight into the audit row, so a 250-refusal
    // publish recorded "101" — a silent under-count in the one record designed
    // to outlive the rotating logs.
    REPORTS = [
      {
        table: "brain_facts",
        promoted: 0,
        refused: Array.from({ length: 250 }, (_, i) => ({
          rowId: `f${i}`,
          reasons: ["GRANT_UNUSABLE"],
          detail: `detail ${i}`,
        })),
      },
    ];
    const res = await publish();
    const body = (await res.json()) as {
      refusedDrafts?: Array<{ id: string }>;
      refusedDraftTotal?: number;
    };
    // The LIST is capped, and every entry in it is a REAL row — no synthetic
    // "(truncated)" marker, which an earlier cut used and which taught both
    // renderers to print the capped number as the refusal count.
    expect(body.refusedDrafts).toHaveLength(100);
    expect(body.refusedDrafts?.every((r) => r.id.startsWith("f"))).toBe(true);
    // The COUNT is not capped — on the wire…
    expect(body.refusedDraftTotal).toBe(250);
    // …and in the durable audit row, which additionally stores every id,
    // because the payload-size argument behind the cap is about an HTTP
    // response and this is a jsonb column.
    expect(auditCalls[0].metadata).toMatchObject({ refusedDraftCount: 250 });
    expect((auditCalls[0].metadata as { refusedDrafts: unknown[] }).refusedDrafts).toHaveLength(
      250,
    );
  });

  it("records ids and reasons in the DURABLE audit row, not just a count", async () => {
    // `log.warn` rotates; `audit_log` does not. "3 drafts were refused" six
    // months later is unactionable.
    REPORTS = [{ table: "brain_facts", promoted: 0, refused: [REFUSAL] }];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({
      refusedDraftCount: 1,
      refusedDrafts: [
        { id: "fact-1", surface: "brain_facts", reasons: ["GRANT_UNUSABLE"] },
      ],
    });
  });

  it("records a WIDENED grant in the durable audit row (#4823)", async () => {
    // The whole reason `PromotionReport.widened` exists rather than being
    // log-only. A widening permanently changed who can read a claim and
    // nothing re-offers it, so "why can the whole org see this?" months later
    // is answerable only from `audit_log`. Uncapped: this is a jsonb column.
    REPORTS = [
      {
        table: "brain_facts",
        promoted: 2,
        refused: [],
        widened: [
          { rowId: "fact-a", added: ["org"] },
          { rowId: "fact-b", added: ["audience:chat-channel:slack:C1", "role:admin"] },
        ],
      },
    ];
    const res = await publish();

    expect(auditCalls[0].metadata).toMatchObject({
      widenedGrantCount: 2,
      widenedGrants: [
        { surface: "brain_facts", id: "fact-a", added: ["org"] },
        {
          surface: "brain_facts",
          id: "fact-b",
          added: ["audience:chat-channel:slack:C1", "role:admin"],
        },
      ],
    });
    // Deliberately absent from the RESPONSE: unlike a refusal it asks nothing
    // of the admin, and the tokens are principal ids.
    expect(await res.json()).not.toHaveProperty("widenedGrants");
  });

  it("distinguishes 'no ACL changed' from the field having regressed", async () => {
    REPORTS = [{ table: "brain_facts", promoted: 5, refused: [] }];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({
      widenedGrantCount: 0,
      widenedGrants: [],
    });
  });

  it("records a SUPERSESSION in the durable audit row (#4912)", async () => {
    // Same argument as the widening, one axis over: a supersession permanently
    // changed which claim answers as-of-now reads, and the superseded row is
    // invisible to every default read afterwards — "why did the agent stop
    // saying X?" months later is answerable only from `audit_log`.
    REPORTS = [
      {
        table: "brain_facts",
        promoted: 1,
        refused: [],
        widened: [],
        superseded: [{ rowId: "fact-new", superseded: ["fact-old-1", "fact-old-2"] }],
      },
    ];
    const res = await publish();

    expect(auditCalls[0].metadata).toMatchObject({
      supersededFactCount: 1,
      supersededFacts: [
        {
          surface: "brain_facts",
          id: "fact-new",
          superseded: ["fact-old-1", "fact-old-2"],
        },
      ],
    });
    // Absent from the RESPONSE, like the widenings: the will-supersede
    // disclosure ran BEFORE the click, so the response asks nothing further.
    expect(await res.json()).not.toHaveProperty("supersededFacts");
  });

  it("distinguishes 'nothing superseded' from the field having regressed", async () => {
    REPORTS = [{ table: "brain_facts", promoted: 5, refused: [] }];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({
      supersededFactCount: 0,
      supersededFacts: [],
    });
  });

  it("records what the TIER GUARD held back, as its own durable number (#5033)", async () => {
    // The complement of the row above, and the reason it needs a field of its
    // own: a publish that PROVED three collisions against warehouse-derived
    // incumbents and declined every one of them writes exactly the same
    // `supersededFacts: []` as a publish that found nothing to arbitrate. The
    // adapter's log line rotates; this row is the durable answer to "did we
    // defend something, or was there nothing there?".
    REPORTS = [
      {
        table: "brain_facts",
        promoted: 2,
        refused: [],
        superseded: [],
        supersessionHeldBack: 3,
      },
    ];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({
      supersededFactCount: 0,
      supersessionsHeldBack: 3,
    });
  });

  it("sums the held-back count across adapters, and writes 0 rather than omitting it", async () => {
    // `0` and absent are different claims — absent is a publish that predates
    // the guard. And the sweep is a SUM over reports rather than a lookup on
    // `brain_facts`, so a second adapter growing a tier guard is picked up here
    // instead of at the call site; an adapter that reports nothing contributes
    // nothing rather than `NaN`.
    REPORTS = [
      { table: "brain_facts", promoted: 1, refused: [], supersessionHeldBack: 0 },
      { table: "semantic_entities", promoted: 4 },
    ];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({ supersessionsHeldBack: 0 });
  });

  it("records `null` — not 0 — when an adapter could not compute its count", async () => {
    // The third state, and the reason the field is `number | null`. A count
    // that failed or drifted must not write "nothing was held back" into a row
    // read months later: drift is persistent, so 0 there is a standing lie
    // rather than one bad record. A `null` from ANY adapter poisons the total,
    // because a workspace-wide number built from a partial answer is the same
    // confident falsehood one level up.
    REPORTS = [
      { table: "brain_facts", promoted: 1, refused: [], supersessionHeldBack: null },
      { table: "semantic_entities", promoted: 4 },
    ];
    await publish();
    expect(auditCalls[0].metadata).toMatchObject({ supersessionsHeldBack: null });
  });
});

describe("POST /api/v1/admin/publish — post-commit side effects (#3856 / #4208)", () => {
  it("reconciles datasources and busts the per-mode mirror after a committed publish", async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    expect(reconcileCalls).toEqual([CURRENT_ORG]);
    expect(invalidateCalls).toEqual([CURRENT_ORG]);
  });

  it("rolls back and skips both side effects on a phase failure", async () => {
    PHASES_THROW = true;
    const res = await publish();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("publish_failed");
    expect(body.requestId).toBe("test-req");
    expect(txControl).toContain("ROLLBACK");
    expect(txControl).not.toContain("COMMIT");
    expect(reconcileCalls).toHaveLength(0);
    expect(invalidateCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
