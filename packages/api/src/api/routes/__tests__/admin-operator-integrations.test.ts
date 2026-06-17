/**
 * Route-level tests for `admin-operator-integrations` (#3735).
 *
 * Focus on THIS router's own logic — the bits the shared platform middleware
 * can't cover:
 *   - GET masking: the response carries presence + source only, never a secret value.
 *   - PUT merge-on-write: non-empty fields overlay the stored bundle, blank = preserve.
 *   - refresh-on-write: every successful write rebuilds the chat plugin
 *     (`plugins.refresh("chat-interaction")`).
 *   - audit-on-write: the row records `hasSecret: true` + field NAMES, never the raw value.
 *   - 404 for an unmanaged platform slug.
 *
 * The shared `platformAdminAuth` / `mfaRequired` perimeter is exercised in
 * `admin-router.test.ts`; here `./admin-router` is replaced with a pass-through
 * (`createPlatformRouter` → a plain `OpenAPIHono`) so the assertions are about
 * THIS file, not the perimeter. The store is a `mock.module()` in-memory fake
 * (the real resolver + real `OPERATOR_PLATFORMS` run end-to-end against it);
 * the plugin registry + audit + logger + `effect/hono` bridge are mocked so the
 * handler runs without booting the runtime.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { RequestContext } from "@atlas/api/lib/effect/services";

// `hasInternalDB()` is a one-liner over `process.env.DATABASE_URL` — set it so
// the write-guard + status DB branch run (the store itself is fully mocked
// below, so nothing actually connects). `??=` hoist is the permitted form for
// an import-time env read (see docs/development/testing.md).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/atlas_test";

// ── In-memory operator-credential store (mock.module — all exports) ──────────

/** The single platform's stored bundle, mutated per-test. `null` ⇒ no row. */
let storedBundle: Record<string, string> | null = null;
/** Records the last save so assertions can inspect the merged write. */
let lastSaved: { platform: string; bundle: Record<string, string> } | null = null;
let deleteCalled = false;

// Named handles so individual tests can override behavior (e.g. force a save
// to throw to exercise the failure-audit + 500 path).
const saveSpy = mock(async (platform: string, bundle: Record<string, string>) => {
  lastSaved = { platform, bundle: { ...bundle } };
  storedBundle = { ...bundle };
});
const deleteSpy = mock(async () => {
  deleteCalled = true;
  const existed = storedBundle !== null;
  storedBundle = null;
  return existed;
});
mock.module("@atlas/api/lib/integrations/operator-credentials/store", () => ({
  saveOperatorCredentials: saveSpy,
  readOperatorCredentials: mock(async () => (storedBundle ? { ...storedBundle } : null)),
  readOperatorCredentialRecord: mock(async () =>
    storedBundle ? { bundle: { ...storedBundle }, updatedAt: new Date("2026-06-17T00:00:00.000Z") } : null,
  ),
  deleteOperatorCredentials: deleteSpy,
}));

// Plugin registry — spy on the refresh-on-write seam.
type RefreshResult = { ok: true } | { ok: false; reason: string };
const refreshSpy = mock(async (_id: string): Promise<RefreshResult> => ({ ok: true }));
mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: { refresh: refreshSpy },
}));

// Audit — capture the rows so masking + `hasSecret` assertions can inspect them.
const auditRows: Array<{ actionType: string; metadata?: Record<string, unknown> }> = [];
mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock((entry: { actionType: string; metadata?: Record<string, unknown> }) => {
    auditRows.push(entry);
  }),
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: {
    operator_integration: {
      update: "operator_integration.update",
      delete: "operator_integration.delete",
    },
  },
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test-req" }) };
});

// Run the Effect with a RequestContext layer; return the handler's Response.
mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (_c: unknown, effect: Effect.Effect<Response, unknown, RequestContext>) => {
    const layer = Layer.succeed(RequestContext, {
      requestId: "test-req",
      startTime: Date.now(),
      atlasMode: "published" as const,
    });
    return Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<Response, never, never>);
  },
}));

// Pass-through platform perimeter — the auth gate is covered by admin-router.test.ts.
mock.module("../admin-router", () => ({
  createPlatformRouter: () => new OpenAPIHono(),
}));

// ── SUT (dynamic import AFTER mocks) ─────────────────────────────────────────

const { adminOperatorIntegrations } = await import("../admin-operator-integrations");

const JSON_HEADERS = { "content-type": "application/json" };
const SECRET = "super-secret-client-secret-value";

beforeEach(() => {
  storedBundle = null;
  lastSaved = null;
  deleteCalled = false;
  auditRows.length = 0;
  refreshSpy.mockClear();
  saveSpy.mockClear();
  deleteSpy.mockClear();
});

afterEach(() => {
  storedBundle = null;
});

describe("GET /:platform — masked status", () => {
  it("404s an unmanaged platform slug", async () => {
    const res = await adminOperatorIntegrations.request("/nope", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns per-field presence + source and NEVER the secret value", async () => {
    storedBundle = {
      SLACK_CLIENT_ID: "A123",
      SLACK_CLIENT_SECRET: SECRET,
      SLACK_SIGNING_SECRET: "sign-123",
      SLACK_ENCRYPTION_KEY: "enc-key-123",
    };
    const res = await adminOperatorIntegrations.request("/slack", { method: "GET" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // The secret bytes must not appear anywhere in the serialized response.
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("enc-key-123");

    const body = JSON.parse(raw) as {
      status: {
        configured: boolean;
        hasDbOverride: boolean;
        updatedAt: string | null;
        fields: Array<{ envVar: string; present: boolean; source: string; destructiveRotation: boolean }>;
      };
    };
    expect(body.status.configured).toBe(true);
    expect(body.status.hasDbOverride).toBe(true);
    expect(body.status.updatedAt).toBe("2026-06-17T00:00:00.000Z");
    const clientSecret = body.status.fields.find((f) => f.envVar === "SLACK_CLIENT_SECRET")!;
    expect(clientSecret.present).toBe(true);
    expect(clientSecret.source).toBe("db");
    // The destructive-rotation flag flows through for the encryption key.
    const encKey = body.status.fields.find((f) => f.envVar === "SLACK_ENCRYPTION_KEY")!;
    expect(encKey.destructiveRotation).toBe(true);
  });
});

describe("PUT /:platform — merge + refresh + audit", () => {
  it("merges non-empty fields over the stored bundle (blank = preserve) and refreshes the chat plugin", async () => {
    storedBundle = {
      SLACK_CLIENT_ID: "A123",
      SLACK_CLIENT_SECRET: "old-secret",
      SLACK_SIGNING_SECRET: "old-sign",
      SLACK_ENCRYPTION_KEY: "old-enc",
    };
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      // Rotate only the signing secret; leave the rest blank (= preserve).
      body: JSON.stringify({ fields: { SLACK_SIGNING_SECRET: "new-sign", SLACK_CLIENT_SECRET: "  " } }),
    });
    expect(res.status).toBe(200);

    // The merged write keeps the un-touched fields and only swaps the signing secret.
    expect(lastSaved?.bundle).toEqual({
      SLACK_CLIENT_ID: "A123",
      SLACK_CLIENT_SECRET: "old-secret",
      SLACK_SIGNING_SECRET: "new-sign",
      SLACK_ENCRYPTION_KEY: "old-enc",
    });

    // refresh-on-write: the chat plugin is rebuilt with exactly the chat id.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0][0]).toBe("chat-interaction");

    const body = (await res.json()) as { refreshed: boolean };
    expect(body.refreshed).toBe(true);
  });

  it("writes onto an empty (env-only) platform when no row exists yet", async () => {
    storedBundle = null;
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_ID: "A999", SLACK_CLIENT_SECRET: "fresh" } }),
    });
    expect(res.status).toBe(200);
    expect(lastSaved?.bundle).toEqual({ SLACK_CLIENT_ID: "A999", SLACK_CLIENT_SECRET: "fresh" });
  });

  it("audit-logs the write with hasSecret + field NAMES, never the raw value", async () => {
    storedBundle = null;
    await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_SECRET: SECRET } }),
    });
    const row = auditRows.find((r) => r.actionType === "operator_integration.update");
    expect(row).toBeDefined();
    expect(row!.metadata?.hasSecret).toBe(true);
    expect(row!.metadata?.fieldsSet).toEqual(["SLACK_CLIENT_SECRET"]);
    // The raw secret must never appear in the audit metadata.
    expect(JSON.stringify(row!.metadata)).not.toContain(SECRET);
  });

  it("400s an all-blank body (nothing to update)", async () => {
    storedBundle = { SLACK_CLIENT_ID: "A123" };
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_SECRET: "   " } }),
    });
    expect(res.status).toBe(400);
    expect(lastSaved).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("400s an unknown field key for the platform", async () => {
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { NOT_A_SLACK_FIELD: "x" } }),
    });
    expect(res.status).toBe(400);
    expect(lastSaved).toBeNull();
  });

  it("404s a write to an unmanaged platform", async () => {
    const res = await adminOperatorIntegrations.request("/discord", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { FOO: "bar" } }),
    });
    expect(res.status).toBe(404);
  });

  it("surfaces a non-fatal refresh failure as a warning (credentials still saved)", async () => {
    refreshSpy.mockImplementationOnce(async () => ({ ok: false as const, reason: "Plugin not registered" }));
    storedBundle = null;
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_ID: "A1", SLACK_CLIENT_SECRET: "s" } }),
    });
    expect(res.status).toBe(200);
    // The write still landed.
    expect(lastSaved?.bundle).toEqual({ SLACK_CLIENT_ID: "A1", SLACK_CLIENT_SECRET: "s" });
    const body = (await res.json()) as { refreshed: boolean; refreshError?: string };
    expect(body.refreshed).toBe(false);
    expect(body.refreshError).toBe("Plugin not registered");
  });

  it("500s and logs a FAILURE audit row (no secret, no refresh) when the save throws", async () => {
    storedBundle = null;
    saveSpy.mockImplementationOnce(async () => {
      throw new Error("encrypt failed: kms unreachable");
    });
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_SECRET: SECRET } }),
    });
    expect(res.status).toBe(500);

    // The failure is audited before the error propagates — with field NAMES
    // and `hasSecret`, never the raw value.
    const row = auditRows.find((r) => r.actionType === "operator_integration.update") as
      | { status?: string; metadata?: Record<string, unknown> }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("failure");
    expect(row!.metadata?.hasSecret).toBe(true);
    expect(row!.metadata?.fieldsSet).toEqual(["SLACK_CLIENT_SECRET"]);
    expect(JSON.stringify(row)).not.toContain(SECRET);

    // A failed write must not pretend to refresh the running adapter.
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("DELETE /:platform — revert to env", () => {
  it("deletes the stored bundle, refreshes, and audit-logs", async () => {
    storedBundle = { SLACK_CLIENT_ID: "A123", SLACK_CLIENT_SECRET: SECRET };
    const res = await adminOperatorIntegrations.request("/slack", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deleteCalled).toBe(true);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0][0]).toBe("chat-interaction");

    const row = auditRows.find((r) => r.actionType === "operator_integration.delete");
    expect(row).toBeDefined();
    expect(row!.metadata?.removed).toBe(true);
  });

  it("404s a delete on an unmanaged platform", async () => {
    const res = await adminOperatorIntegrations.request("/discord", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("GET / — managed platform list", () => {
  it("lists managed platforms with a configured/override summary", async () => {
    storedBundle = null;
    const res = await adminOperatorIntegrations.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Array<{ platform: string; label: string }> };
    expect(body.platforms.some((p) => p.platform === "slack")).toBe(true);
  });
});

// `hasInternalDB()` reads `process.env.DATABASE_URL` live, so unsetting it for
// the scope of these tests drives the self-host (env-only) write guards. The
// store stays mocked, so nothing connects either way.
describe("internal DB absent — write guards return not_configured", () => {
  let savedDbUrl: string | undefined;
  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("PUT 404s `not_configured` and does not save or refresh", async () => {
    const res = await adminOperatorIntegrations.request("/slack", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fields: { SLACK_CLIENT_ID: "A1" } }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_configured");
    expect(lastSaved).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("DELETE 404s `not_configured` and does not delete or refresh", async () => {
    const res = await adminOperatorIntegrations.request("/slack", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_configured");
    expect(deleteCalled).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("still distinguishes an unmanaged slug as 404 `not_found`, not `not_configured`", async () => {
    const res = await adminOperatorIntegrations.request("/discord", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});
