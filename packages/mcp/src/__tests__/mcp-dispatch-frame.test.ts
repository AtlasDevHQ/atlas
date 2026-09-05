/**
 * The dispatch frame carries the door's frame (#5626).
 *
 * `createMcpDispatch` opens its own `withRequestContext` frame per tool call,
 * and `withRequestContext` is `requestStore.run` — it replaces the outer frame,
 * never merges it. Before #5626 the dispatch re-stamped `connectionId` by name
 * and nothing else, so the door's `atlasMode` and `clientIp` were gone inside
 * the tool body: `loadOrgWhitelist` read `undefined` (no status filter — drafts
 * included) while `isConnectionVisibleInMode` defaulted to `"published"`.
 *
 * Pinned here:
 *   1. every field the door stamped is readable in the tool body — `atlasMode`,
 *      `clientIp`, `connectionId`, and a field the dispatch never names, so a
 *      new outer field crosses without an edit to `mcp-dispatch.ts`;
 *   2. the dispatch still owns its own keys — `requestId`, `user`, `actor`,
 *      `agentOrigin`, `scopes` — and an outer `scopes` is dropped, not
 *      inherited;
 *   3. a dispatch with no door around it still runs;
 *   4. the permissive direction the carry-through closes: under a published
 *      door, a draft-only entity's table fails the REAL `validateSQL` whitelist
 *      inside the dispatch, and the same query with no mode on the frame is
 *      what used to admit it.
 *
 * The anonymous door and the hosted server each assert the same read in their
 * own suites (`demo.test.ts`, `server.test.ts`); this file owns the frame
 * semantics with no transport in the way.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type * as RealEntities from "@atlas/api/lib/semantic/entities";
import type { SemanticEntityRow, SemanticEntityStatus } from "@atlas/api/lib/semantic/entities";
import { createConnectionMock } from "@atlas/api/__mocks__/connection";
import { notDriven } from "@atlas/api/__mocks__/drivable";
import { createAtlasUser, type AtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext, withRequestContext } from "@atlas/api/lib/logger";

// ── Module-scope mocks (every named export, per testing.md) ─────────────

void mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

// `hasInternalDB` is what routes `validateSQL` to the per-org whitelist; every
// other export stays real (the actor.test.ts shape).
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => true,
}));

const ORG = "org_5626";
const DEMO = "__demo__";

interface EntityFixture {
  readonly name: string;
  readonly table: string;
  readonly status: SemanticEntityStatus;
}

/** The store's rows. `listEntityRows` applies the status filter the way the SQL does. */
let entityRows: readonly EntityFixture[] = [];
const mockListEntityRows = mock<typeof RealEntities.listEntityRows>(
  async (orgId, entityType, statusFilter) =>
    entityRows
      .filter((r) => statusFilter === undefined || r.status === statusFilter)
      .map(
        (r): SemanticEntityRow => ({
          id: `${orgId}:${entityType ?? "entity"}:${r.name}`,
          org_id: orgId,
          entity_type: "entity",
          name: r.name,
          yaml_content: `table: ${r.table}\n`,
          connection_group_id: DEMO,
          status: r.status,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        }),
      ),
);
const mockListConnectionGroupMembers = mock<typeof RealEntities.listConnectionGroupMembers>(
  async () => [],
);

const FIXTURE = "mcp-dispatch-frame";
void mock.module(
  "@atlas/api/lib/semantic/entities",
  (): Record<keyof typeof RealEntities, unknown> => ({
    listEntityRows: mockListEntityRows,
    listConnectionGroupMembers: mockListConnectionGroupMembers,
    AmbiguousEntityError: class AmbiguousEntityError extends Error {},
    SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
    DEMO_CONNECTION_ID: DEMO,
    getEntity: notDriven("getEntity", FIXTURE),
    upsertEntityForGroup: notDriven("upsertEntityForGroup", FIXTURE),
    createVersion: notDriven("createVersion", FIXTURE),
    generateChangeSummary: notDriven("generateChangeSummary", FIXTURE),
    getDraftEntityForGroup: notDriven("getDraftEntityForGroup", FIXTURE),
    upsertDraftEntityForGroup: notDriven("upsertDraftEntityForGroup", FIXTURE),
    resolveGroupIdForConnection: notDriven("resolveGroupIdForConnection", FIXTURE),
    upsertEntity: notDriven("upsertEntity", FIXTURE),
    upsertDraftEntity: notDriven("upsertDraftEntity", FIXTURE),
    upsertTombstone: notDriven("upsertTombstone", FIXTURE),
    upsertTombstoneForGroup: notDriven("upsertTombstoneForGroup", FIXTURE),
    deleteDraftEntity: notDriven("deleteDraftEntity", FIXTURE),
    deleteDraftEntityForGroup: notDriven("deleteDraftEntityForGroup", FIXTURE),
    listEntities: notDriven("listEntities", FIXTURE),
    listEntitiesWithOverlay: notDriven("listEntitiesWithOverlay", FIXTURE),
    deleteEntity: notDriven("deleteEntity", FIXTURE),
    countEntities: notDriven("countEntities", FIXTURE),
    listVersions: notDriven("listVersions", FIXTURE),
    getVersion: notDriven("getVersion", FIXTURE),
    applyTombstones: notDriven("applyTombstones", FIXTURE),
    promoteDraftEntities: notDriven("promoteDraftEntities", FIXTURE),
    archiveSingleConnection: notDriven("archiveSingleConnection", FIXTURE),
    restoreSingleConnection: notDriven("restoreSingleConnection", FIXTURE),
    bulkUpsertEntities: notDriven("bulkUpsertEntities", FIXTURE),
    upsertProfileStatus: notDriven("upsertProfileStatus", FIXTURE),
    listIncompleteProfileLayers: notDriven("listIncompleteProfileLayers", FIXTURE),
  }),
);

const { createMcpDispatch } = await import("../mcp-dispatch.js");
const { validateSQL } = await import("@atlas/api/lib/tools/sql");
const { _resetOrgWhitelists } = await import("@atlas/api/lib/semantic/whitelist");

// ── Fixtures ────────────────────────────────────────────────────────────

const ACTOR: AtlasUser = createAtlasUser("user_5626", "managed", "u@example.com", {
  role: "admin",
  activeOrganizationId: ORG,
});

const READ_TOOL = { requiresWrite: false, requiresBoundOrg: false, minRole: "member" } as const;

function stdioDispatch(scopes?: readonly string[]) {
  return createMcpDispatch({
    actor: ACTOR,
    transport: "stdio",
    workspaceId: ORG,
    deployMode: "self-hosted",
    ...(scopes ? { scopes } : {}),
  });
}

type Frame = ReturnType<typeof getRequestContext>;

/** Run a body under the dispatch and hand back the frame it observed. */
async function observeFrame(
  dispatch: ReturnType<typeof createMcpDispatch>,
): Promise<{ frame: Frame; requestId: string }> {
  let frame: Frame;
  let requestId = "";
  const result = await dispatch.dispatch("probe", READ_TOOL, async (id) => {
    frame = getRequestContext();
    requestId = id;
    return { content: [{ type: "text", text: "ok" }] };
  });
  expect(result.isError).toBeFalsy();
  return { frame: frame!, requestId };
}

/** The frame the anonymous door opens (`demo.ts`), minus the identity it mints. */
const DOOR_FRAME = {
  requestId: "door-request",
  atlasMode: "published" as const,
  agentOrigin: "mcp" as const,
  clientIp: "203.0.113.9",
  connectionId: DEMO,
};

describe("createMcpDispatch — the frame carries the door's frame (#5626)", () => {
  it("reads atlasMode, clientIp and connectionId off the outer frame inside the tool body", async () => {
    const { frame } = await withRequestContext(DOOR_FRAME, () => observeFrame(stdioDispatch()));
    expect(frame?.atlasMode).toBe("published");
    expect(frame?.clientIp).toBe("203.0.113.9");
    expect(frame?.connectionId).toBe(DEMO);
  });

  it("carries a field the dispatch never names, so a new outer field needs no edit here", async () => {
    // `conversationId` is stamped by the chat route and read by `proposeFact`;
    // `mcp-dispatch.ts` does not mention it. If a future door stamps it, the
    // tool body must see it — that is the whole-frame spread, not a list.
    const { frame } = await withRequestContext(
      { ...DOOR_FRAME, conversationId: "conv_5626", groupReach: "g_reach" },
      () => observeFrame(stdioDispatch()),
    );
    expect(frame?.conversationId).toBe("conv_5626");
    expect(frame?.groupReach).toBe("g_reach");
  });

  it("still owns requestId, user, actor and agentOrigin", async () => {
    const outerUser = createAtlasUser("someone_else", "managed", "x@example.com", {
      activeOrganizationId: "org_other",
    });
    const { frame, requestId } = await withRequestContext(
      { ...DOOR_FRAME, user: outerUser, agentOrigin: "chat", actor: { kind: "human" } },
      () => observeFrame(stdioDispatch()),
    );
    expect(requestId).toStartWith("mcp-probe-");
    expect(frame?.requestId).toBe(requestId);
    expect(frame?.requestId).not.toBe("door-request");
    expect(frame?.user).toBe(ACTOR);
    expect(frame?.agentOrigin).toBe("mcp");
    expect(frame?.actor).toEqual({ kind: "mcp", toolName: "probe" });
  });

  it("drops an outer scopes rather than inheriting it, and keeps its own when it has one", async () => {
    const outer = { ...DOOR_FRAME, scopes: ["mcp:write"] as const };
    const none = await withRequestContext(outer, () => observeFrame(stdioDispatch()));
    expect(none.frame?.scopes).toBeUndefined();

    const own = await withRequestContext(outer, () => observeFrame(stdioDispatch(["mcp:read"])));
    expect(own.frame?.scopes).toEqual(["mcp:read"]);
  });

  it("runs with no door around it", async () => {
    expect(getRequestContext()).toBeUndefined();
    const { frame } = await observeFrame(stdioDispatch());
    expect(frame?.atlasMode).toBeUndefined();
    expect(frame?.agentOrigin).toBe("mcp");
    expect(frame?.user).toBe(ACTOR);
  });
});

describe("a draft-only entity over MCP in published mode", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    mockListEntityRows.mockClear();
    entityRows = [
      { name: "orders", table: "orders", status: "published" },
      { name: "payroll", table: "payroll_draft", status: "draft" },
    ];
  });

  /** The two whitelist reads `executeSQL` makes, run inside the dispatch. */
  function validateUnderDispatch(sql: string) {
    return stdioDispatch().dispatch("executeSQL", READ_TOOL, async () => {
      const verdict = await validateSQL(sql, DEMO, ORG);
      return { content: [{ type: "text", text: JSON.stringify(verdict) }] };
    });
  }

  function verdictOf(result: Awaited<ReturnType<typeof validateUnderDispatch>>) {
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as { valid: boolean; error?: string };
  }

  it("refuses the draft entity's table and admits the published one", async () => {
    const draft = await withRequestContext(DOOR_FRAME, () =>
      validateUnderDispatch("SELECT count(*) FROM payroll_draft"),
    );
    expect(verdictOf(draft)).toEqual({
      valid: false,
      error: expect.stringContaining('Table "payroll_draft" is not in the allowed list'),
    });

    const published = await withRequestContext(DOOR_FRAME, () =>
      validateUnderDispatch("SELECT count(*) FROM orders"),
    );
    expect(verdictOf(published).valid).toBe(true);

    // The whitelist was loaded with the door's mode — the status filter is
    // what excludes the draft, not the developer overlay (which needs an
    // explicit `"developer"`).
    expect(mockListEntityRows).toHaveBeenCalledWith(ORG, "entity", "published");
  });

  it("is the same query a mode-less frame admits — the direction #5626 closes", async () => {
    // With no `atlasMode` on the frame, `loadOrgWhitelist` runs
    // `listEntityRows(org, "entity", undefined)` — no status filter — and the
    // draft's table is on the list. Before #5626 every MCP door landed here.
    const { atlasMode: _dropped, ...modeless } = DOOR_FRAME;
    const result = await withRequestContext(modeless, () =>
      validateUnderDispatch("SELECT count(*) FROM payroll_draft"),
    );
    expect(verdictOf(result).valid).toBe(true);
    expect(mockListEntityRows).toHaveBeenCalledWith(ORG, "entity", undefined);
  });
});
