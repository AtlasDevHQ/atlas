/**
 * Audit regression suite for `admin-prompts.ts` — F-35 (#1790).
 *
 * Pins every write route to the canonical `ADMIN_ACTIONS.prompt.*` string
 * and the metadata shape that forensic queries expect. A drift on any
 * route (renamed action type, missing `id` / `name`, stripped `scope`)
 * trips the suite before it reaches production.
 *
 * Test pattern modeled on `admin-orgs-audit.test.ts` (F-31) and
 * `admin-model-config.test.ts` (F-30).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — set up before app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

function collectionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "col-1",
    org_id: "org-alpha",
    name: "My Collection",
    industry: "saas",
    description: "Test collection",
    is_builtin: false,
    sort_order: 0,
    status: "published",
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  };
}

function itemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    collection_id: "col-1",
    question: "What does this metric measure?",
    description: null,
    category: null,
    sort_order: 0,
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/prompts — collection create
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/prompts — audit emission", () => {
  it("emits prompt.collection_create with id + name + industry metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT INTO prompt_collections")) {
        return [collectionRow({ id: "col-new", name: "New Collection", industry: "saas" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/prompts/", {
        name: "New Collection",
        industry: "saas",
        description: "From a unit test",
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.collection_create");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("col-new");
    expect(entry.metadata).toMatchObject({
      id: "col-new",
      name: "New Collection",
      industry: "saas",
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/prompts/:id — collection update
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/admin/prompts/:id — audit emission", () => {
  it("emits prompt.collection_update with id + name metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1", name: "Old Name" })];
      }
      if (sql.startsWith("UPDATE prompt_collections")) {
        return [collectionRow({ id: "col-1", name: "Renamed" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/prompts/col-1", { name: "Renamed" }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.collection_update");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("col-1");
    expect(entry.metadata).toMatchObject({ id: "col-1", name: "Renamed" });
  });

  it("does not emit when the collection is built-in (403)", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-builtin", is_builtin: true })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/prompts/col-builtin", { name: "Try" }),
    );
    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/prompts/:id — collection delete
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/admin/prompts/:id — audit emission", () => {
  it("emits prompt.collection_delete with id + name metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1", name: "Doomed" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/prompts/col-1"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.collection_delete");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("col-1");
    expect(entry.metadata).toMatchObject({ id: "col-1", name: "Doomed" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/prompts/:id/items — item create
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/prompts/:id/items — audit emission", () => {
  it("emits prompt.create with id + name (question) + collectionId metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1" })];
      }
      if (sql.includes("MAX(sort_order)")) return [{ max: 0 }];
      if (sql.startsWith("INSERT INTO prompt_items")) {
        return [itemRow({ id: "item-new", collection_id: "col-1", question: "New question" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/prompts/col-1/items", {
        question: "New question",
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.create");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("item-new");
    expect(entry.metadata).toMatchObject({
      id: "item-new",
      name: "New question",
      collectionId: "col-1",
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/prompts/:collectionId/items/:itemId — item update
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/admin/prompts/:collectionId/items/:itemId — audit emission", () => {
  it("emits prompt.update with id + name (question) + collectionId metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1" })];
      }
      if (sql.startsWith("SELECT * FROM prompt_items")) {
        return [itemRow({ id: "item-1" })];
      }
      if (sql.startsWith("UPDATE prompt_items")) {
        return [itemRow({ id: "item-1", question: "Updated question" })];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/prompts/col-1/items/item-1", {
        question: "Updated question",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.update");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("item-1");
    expect(entry.metadata).toMatchObject({
      id: "item-1",
      name: "Updated question",
      collectionId: "col-1",
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/prompts/:collectionId/items/:itemId — item delete
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/admin/prompts/:collectionId/items/:itemId — audit emission", () => {
  it("emits prompt.delete with id + name (question) + collectionId metadata", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1" })];
      }
      if (sql.includes("FROM prompt_items WHERE id")) {
        return [{ id: "item-1", question: "Doomed prompt" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/prompts/col-1/items/item-1"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.delete");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("item-1");
    expect(entry.metadata).toMatchObject({
      id: "item-1",
      name: "Doomed prompt",
      collectionId: "col-1",
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/prompts/:id/reorder — item reorder
// ---------------------------------------------------------------------------

describe("PUT /api/v1/admin/prompts/:id/reorder — audit emission", () => {
  it("emits prompt.reorder with collectionId + newOrder metadata", async () => {
    const newOrder = ["item-a", "item-b", "item-c"];
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM prompt_collections")) {
        return [collectionRow({ id: "col-1" })];
      }
      if (sql.includes("SELECT id FROM prompt_items WHERE collection_id")) {
        return newOrder.map((id) => ({ id }));
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/prompts/col-1/reorder", {
        itemIds: newOrder,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("prompt.reorder");
    expect(entry.targetType).toBe("prompt");
    expect(entry.targetId).toBe("col-1");
    expect(entry.metadata).toMatchObject({
      collectionId: "col-1",
      newOrder,
    });
  });
});
