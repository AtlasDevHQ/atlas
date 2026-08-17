/**
 * Tests for admin settings API routes.
 *
 * Tests: GET /settings, PUT /settings/:key, DELETE /settings/:key.
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
// Real ADMIN_ACTIONS so the route's `ADMIN_ACTIONS.settings.update`
// dereference resolves against the mock (a stub without that path would
// TypeError inside the handler).
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import { z } from "@hono/zod-openapi";
import { settingUpdateResponseSchema } from "../routes/admin";
// ⚠️ TYPE-ONLY, so importing from a module this file MOCKS is safe — type imports
// are erased and never reach the runtime registry. These are what let the mock
// factory's `satisfies` check the stubs against the real exports.
import type {
  AuditedValue,
  RedactedAuditValue,
  SettingDefinition,
  SettingUpdateResponse,
  SettingWithValue,
} from "@atlas/api/lib/settings";

// --- Unified mocks ---

let mockWorkspaceRegion: string | null = null;

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
  },
  internal: {
    getWorkspaceRegion: mock(async () => mockWorkspaceRegion),
  },
});

// --- Audit mock (#4669 — the write handlers annotate metadata.tier) ---

const mockLogAdminAction: Mock<(entry: Record<string, unknown>) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
}));

/**
 * #5270/#5262 — the settings write path no longer builds its own audit entry;
 * it hands the definition and the raw value to `auditSettingsWrite`, which
 * redacts, stamps `scope` and awaits the row. The ENTRY's shape is pinned in
 * `lib/audit/__tests__/settings-write.test.ts`; what belongs here is what the
 * ROUTE passes — in particular that `platformTier` tracks the row the write
 * actually landed on, which is #4669's claim restated at the new seam.
 */
const mockAuditSettingsWrite: Mock<(entry: Record<string, unknown>) => Promise<void>> = mock(
  async () => {},
);

void mock.module("@atlas/api/lib/audit/settings-write", () => ({
  auditSettingsWrite: mockAuditSettingsWrite,
}));

// --- Test-specific overrides ---

let mockConfigOverride: Record<string, unknown> | null = null;

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
}));

// Settings registry data used by mocks
const settingsRegistryData: SettingDefinition[] = [
  {
    key: "ATLAS_ROW_LIMIT",
    section: "Query Limits",
    label: "Row Limit",
    description: "Max rows",
    type: "number",
    default: "1000",
    envVar: "ATLAS_ROW_LIMIT",
    scope: "workspace",
  },
  {
    key: "ATLAS_PROVIDER",
    section: "Agent",
    label: "LLM Provider",
    description: "Provider",
    type: "select",
    options: ["anthropic", "openai", "bedrock", "ollama", "openai-compatible", "gateway"],
    default: "anthropic",
    envVar: "ATLAS_PROVIDER",
    scope: "platform",
  },
  {
    key: "ATLAS_RLS_ENABLED",
    section: "Security",
    label: "RLS",
    description: "Enable RLS",
    type: "boolean",
    envVar: "ATLAS_RLS_ENABLED",
    scope: "platform",
  },
  {
    key: "ANTHROPIC_API_KEY",
    section: "Secrets",
    label: "Anthropic API Key",
    description: "API key",
    type: "string",
    secret: true,
    envVar: "ANTHROPIC_API_KEY",
    scope: "platform",
  },
  // #3376 — split-axis key: hidden from the generic settings page but
  // writable on SaaS because the dedicated /admin/sandbox page saves it
  // through PUT /admin/settings/{key}. Mirrors the real registry entry.
  {
    key: "ATLAS_SANDBOX_BACKEND",
    section: "Sandbox",
    label: "Sandbox Backend",
    description: "Sandbox backend",
    type: "string",
    envVar: "ATLAS_SANDBOX_BACKEND",
    scope: "workspace",
    saasVisible: false,
    saasWritable: true,
  },
  // #4669 — the Agent Auth master switch: workspace-scoped, but its
  // PLATFORM (global) tier is the operator surface on/off switch. Used
  // to pin the explicit tier=platform write path.
  {
    key: "ATLAS_AGENT_AUTH_ENABLED",
    section: "MCP",
    label: "Enable Agent Auth Protocol",
    description: "Agent Auth master switch",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_AGENT_AUTH_ENABLED",
    scope: "workspace",
  },
  // #3376 — hidden key with no explicit saasWritable: effective
  // writability inherits saasVisible=false, so SaaS workspace admins
  // can neither see nor write it.
  {
    key: "ATLAS_DEMO_INDUSTRY",
    section: "Demo",
    label: "Demo Industry",
    description: "Demo industry",
    type: "string",
    envVar: "ATLAS_DEMO_INDUSTRY",
    scope: "workspace",
    saasVisible: false,
  },
];

const mockGetSettingsForAdmin = mock((): SettingWithValue[] => [
  {
    ...settingsRegistryData[0],
    currentValue: "1000",
    source: "default",
  },
  {
    ...settingsRegistryData[3],
    currentValue: "sk-a••••here",
    source: "env",
  },
]);

const mockSetSetting: Mock<(key: string, value: string, userId?: string, orgId?: string) => Promise<void>> = mock(
  () => Promise.resolve(),
);

const mockDeleteSetting: Mock<(key: string, userId?: string, orgId?: string) => Promise<void>> = mock(
  () => Promise.resolve(),
);

const mockGetSettingsRegistry = mock(() => settingsRegistryData);

const settingsMap = new Map(settingsRegistryData.map((s) => [s.key, s]));
const mockGetSettingDefinition = mock((key: string) => settingsMap.get(key));

// #3389 — the route write gates consult the shared fail-closed probe from
// lib/settings instead of reading getConfig() directly. The default mock
// mirrors the resolved-config happy path (saas ⇒ true, anything else ⇒
// false); fail-closed-on-config-resolution-failure semantics of the REAL
// probe are covered in lib/__tests__/settings-saas.test.ts. Tests that
// simulate a config-resolution failure override this to return true.
const saasGuardDefaultImpl = () =>
  (mockConfigOverride as { deployMode?: string } | null)?.deployMode === "saas";
const mockIsSaasModeForGuard = mock(saasGuardDefaultImpl);

/**
 * #5263 — swappable stand-in for `settingUpdateResponseBody`.
 *
 * ⚠️ It is a MUTABLE binding rather than a fixed mock because `mock.module` is
 * module-scoped and the two claims need opposite behaviour: the default echoes
 * the value so every existing PUT assertion keeps its meaning, while one test
 * swaps in a body sharing no field with the request and asserts the response
 * carries it. Without that swap "the route returns the builder's output" and
 * "the route returns an object literal that happens to match" are the same
 * observation, because the pass-through is the identity on a non-secret key.
 */
// ⚠️ The REAL response type, not a hand-rolled twin. A local shape would drift
// from `SettingUpdateResponse` silently — and this file's whole premise is that
// the route's contract is observed.
type SettingUpdateBody = SettingUpdateResponse;
const echoResponseBodyImpl = (key: string, value: string): SettingUpdateBody => ({
  success: true,
  key,
  value: value as AuditedValue,
  valueMasked: false,
});
let settingUpdateResponseBodyImpl: (key: string, value: string) => SettingUpdateBody =
  echoResponseBodyImpl;

/**
 * ⚠️ HOISTED TO A NAMED `Mock`, unlike the first draft's inline factory, because
 * the ARGUMENT contract is the half that matters and an inline stand-in gives
 * nothing to assert on. `_def` was discarded and unobservable, so
 * `settingUpdateResponseBody(undefined, key, value)` at the route — one word —
 * type-checks, keeps every test green, and makes every PUT 200 return
 * `value: "[withheld:secret-setting]", valueMasked: true`. That is the exact
 * "redact everything" failure the control below was written to prevent, which it
 * could not see while measuring its own echo stub.
 *
 * The neighbouring `#5270` describe already makes this argument for
 * `auditSettingsWrite` ("`definition: def → definition: undefined` is
 * type-legal"); it was applied to one of the handler's two call sites.
 */
const mockSettingUpdateResponseBody: Mock<
  (def: SettingDefinition | undefined, key: string, value: string) => SettingUpdateResponse
> = mock((_def: SettingDefinition | undefined, key: string, value: string) =>
  settingUpdateResponseBodyImpl(key, value),
);

void mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: mockGetSettingsForAdmin,
  getSettingsRegistry: mockGetSettingsRegistry,
  getSettingDefinition: mockGetSettingDefinition,
  setSetting: mockSetSetting,
  deleteSetting: mockDeleteSetting,
  loadSettings: mock(async () => 0),
  getSetting: mock(() => undefined),
  getSettingAuto: mock(() => undefined),
  getSettingOverride: mock(() => undefined),
  getSettingLive: mock(async () => undefined),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
  isSaasModeForGuard: mockIsSaasModeForGuard,
  // Mock-all-exports discipline — unused by these routes but present so
  // this partial mock never breaks another importer in the same process.
  refreshSettingsTick: mock(async () => {}),
  HOT_RELOADED_KEYS: new Set<string>(),
  isHotReloadedKey: mock(() => false),
  SECURITY_SENSITIVE_KEYS: new Set<string>(),
  // `null`, not `undefined` — the real signature is `SecuritySensitiveAudit |
  // null`, and `auditSettingsWrite` tests `!== null`. A stub returning
  // `undefined` would pass that guard and then throw on a property read. Not
  // reachable here (the seam itself is mocked), but `mock.module` factories are
  // untyped, so nothing would report it when it becomes reachable.
  securitySensitiveAuditFields: mock(() => null),
  // #5270 — newly load-bearing: `lib/audit/settings-write.ts` resolves
  // `redactAuditValue` from this module. A partial mock replaces the WHOLE
  // module, so the moment anything in admin.ts's import graph reaches it,
  // the omission surfaces as `undefined is not a function` several files from
  // the cause. `securitySensitiveAuditLine` and `settingsCacheEverLoaded`
  // were already missing; added for the same reason.
  redactAuditValue: mock(
    (_key: string, _def: unknown, value: string | undefined): RedactedAuditValue => ({
      value: value as AuditedValue | undefined,
      masked: false,
    }),
  ),
  redactPresentAuditValue: mock(
    (
      _key: string,
      _def: unknown,
      value: string,
    ): RedactedAuditValue & { readonly value: AuditedValue } => ({
      value: value as AuditedValue,
      masked: false,
    }),
  ),
  // #5263 — the route's 200 body is this builder's output rather than an
  // object literal, so that the withheld arm is measurable at all: the
  // `def.secret` 403 above means no request can carry a secret value to the
  // echo, and a body built inline could only ever be asserted on the verbatim
  // arm. The redaction ITSELF is pinned in `lib/__tests__/settings.test.ts`
  // against real registry definitions; what this mock exists to catch is the
  // route going back to `{ success: true, key, value }`, which the schema as
  // written does not see (`AuditedValue` is assignable to `z.string()`; a
  // branded schema WOULD catch it and stops the OpenAPI spec generating —
  // measured, see `settingUpdateResponseBody`'s docstring).
  settingUpdateResponseBody: mockSettingUpdateResponseBody,
  securitySensitiveAuditLine: mock(() => null),
  settingsCacheEverLoaded: mock(() => true),
  // ⚠️ `satisfies` IS THE RATCHET. `mock.module` factories are untyped, so a stub
  // whose shape drifts from the real export — a changed arity, a `{}` where the
  // signature says `| null` — is reported by nothing until it throws several files
  // from the cause. Four sibling suites shipped exactly that. This makes the next
  // signature change a compile error here instead.
}) satisfies Partial<typeof import("@atlas/api/lib/settings")>);

/**
 * ⚠️ COMPILE-TIME TIE between the three representations of the settings `PUT` 200
 * body: the TS type, the zod schema that generates the published spec, and this
 * file's fake. Adding a field to one and not the others is now a type error here.
 *
 * The `value` divergence is the one DELIBERATE difference — branded `AuditedValue`
 * in TS so only the redaction can mint one, plain `z.string()` in the schema
 * because `z.custom` cannot be rendered by the OpenAPI extractor (measured: it
 * fails with `UnknownZodTypeError`). Written as a type rather than a paragraph, so
 * a fourth divergence cannot be introduced silently.
 */
// ⚠️ MUTUAL, not one-directional, and the first draft was the latter. Written as
// `A extends B`, adding an OPTIONAL field to `SettingUpdateResponse` slipped
// through — measured: 0 type errors — because an optional property never blocks
// assignability. `Equal` is the standard invariant-position trick and it fails on
// a difference in either direction.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
/** Normalises mutability so `Equal` compares shapes, not `readonly` modifiers. */
type AllReadonly<T> = { readonly [K in keyof T]: T[K] };
type SchemaMatchesResponseType = Equal<
  // Both sides normalised: `z.infer` yields mutable properties while
  // `SettingUpdateResponse` is `readonly` throughout, and `Equal` is strict about
  // that. `AllReadonly` also flattens the intersection so the comparison is between
  // two plain property bags rather than an object and an `A & B`.
  AllReadonly<z.infer<typeof settingUpdateResponseSchema>>,
  AllReadonly<
    Omit<SettingUpdateResponse, "success" | "value"> & {
      success: boolean;
      value: string;
    }
  >
>;
const _schemaMatchesResponseType: SchemaMatchesResponseType = true;
void _schemaMatchesResponseType;

// --- Import the app AFTER mocks ---

const { admin } = await import("../routes/admin");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/admin", admin);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

// --- Tests ---

afterAll(() => {
  mocks.cleanup();
});

describe("admin settings routes", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mockWorkspaceRegion = null;
    mockConfigOverride = null;
    mockSetSetting.mockClear();
    mockDeleteSetting.mockClear();
    mockLogAdminAction.mockClear();
    // ⚠️ `mockReset`, not `mockClear`: the audit-failure tests queue a one-shot
    // rejection with `mockImplementationOnce`, and `mockClear` drops recorded
    // CALLS while leaving the queue intact. Today every such test consumes its
    // own, but a future one that 403s before the seam would park a rejection for
    // whichever test runs next, failing far from the cause.
    mockAuditSettingsWrite.mockReset();
    mockAuditSettingsWrite.mockImplementation(async () => {});
    // ⚠️ Drains per-test session overrides. `mockAuthenticateRequest` is driven
    // with `mockImplementationOnce` throughout this file, and a request that
    // short-circuits before the handler leaves its queued session unconsumed —
    // see the 422 test for the measured instance.
    mocks.resetPerTest();
    mockIsSaasModeForGuard.mockClear();
    mockIsSaasModeForGuard.mockImplementation(saasGuardDefaultImpl);
    // ⚠️ Restored here, not in the one test that swaps it: a leaked sentinel
    // body would make every other PUT assertion in this file read
    // "BUILDER-VALUE" and fail somewhere far from the cause.
    settingUpdateResponseBodyImpl = echoResponseBodyImpl;
    mockSettingUpdateResponseBody.mockClear();
  });

  // ─── GET /settings ──────────────────────────────────────────────

  describe("GET /api/v1/admin/settings", () => {
    it("returns settings with values and manageable flag", async () => {
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { manageable: boolean; settings: unknown[] };
      expect(data.manageable).toBe(true);
      expect(Array.isArray(data.settings)).toBe(true);
      expect(data.settings.length).toBeGreaterThan(0);
    });

    it("returns manageable=false when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { manageable: boolean };
      expect(data.manageable).toBe(false);
    });

    it("returns 403 for non-admin users", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(403);
    });
  });

  // ─── PUT /settings/:key ─────────────────────────────────────────

  describe("PUT /api/v1/admin/settings/:key", () => {
    it("saves a valid setting override", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { success: boolean; key: string; value: string };
      expect(data.success).toBe(true);
      expect(data.key).toBe("ATLAS_ROW_LIMIT");
      expect(data.value).toBe("500");
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    // ⚠️ #5263 — THE SEAM, not the policy. The policy (what a `secret: true`
    // definition does to the echoed value) is measured in
    // `lib/__tests__/settings.test.ts` against real registry entries, because
    // the `def.secret` 403 makes it unreachable from here. What is only
    // observable here is whether the route still ROUTES through the builder —
    // the cheaper edit, and the one the shipped schema does not catch.
    it("⭐ the 200 body is the builder's output, not an inlined literal", async () => {
      settingUpdateResponseBodyImpl = () => ({
        success: true,
        key: "BUILDER-KEY",
        // The brand is minted only inside `redactPresentAuditValue`; a sentinel
        // needs the cast, and the cast is confined to this one test literal.
        value: "BUILDER-VALUE" as AuditedValue,
        valueMasked: true,
        maskReason: "secret",
      });
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      // Every field differs from what an inlined `{ success: true, key, value }`
      // would produce, so this cannot pass by coincidence.
      expect(await res.json()).toEqual({
        success: true,
        key: "BUILDER-KEY",
        value: "BUILDER-VALUE",
        valueMasked: true,
        maskReason: "secret",
      });
    });

    it("reports valueMasked on the ordinary non-secret write", async () => {
      // The control for the assertion above: with the real builder shape the
      // response says the characters were NOT withheld, so a client can tell
      // the placeholder from a literal. A route hardcoding `valueMasked: true`
      // would pass the seam test and lie on every normal write.
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(await res.json()).toEqual({
        success: true,
        key: "ATLAS_ROW_LIMIT",
        value: "500",
        valueMasked: false,
      });
    });

    it("⭐ hands the builder the DEFINITION it resolved, not undefined", async () => {
      // ⚠️ THE ARGUMENT, which no other test in this file could see. Passing
      // `undefined` here routes `redactAuditValue` to its fail-closed arm, so
      // every PUT 200 would return the withheld placeholder with
      // `valueMasked: true` — "redact everything", the failure mode the control
      // above exists to catch and cannot, because it measures the echo stub
      // rather than the real builder.
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSettingUpdateResponseBody).toHaveBeenCalledTimes(1);
      expect(mockSettingUpdateResponseBody).toHaveBeenCalledWith(
        // The registry entry for this key — not a different key's, and not
        // `undefined`. `objectContaining` rather than the whole literal so a
        // registry edit elsewhere does not break this on an unrelated field.
        expect.objectContaining({ key: "ATLAS_ROW_LIMIT" }),
        "ATLAS_ROW_LIMIT",
        "500",
      );
    });

    it("rejects unknown setting keys", async () => {
      const res = await request("/api/v1/admin/settings/NONEXISTENT_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "foo" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects secret settings", async () => {
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new-key" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects missing value", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("validates number type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "not-a-number" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty string for number type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative numbers", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "-5" }),
      });
      expect(res.status).toBe(400);
    });

    it("validates select type options", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "invalid-provider" }),
      });
      expect(res.status).toBe(400);
    });

    it("validates boolean type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid boolean", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(404);
    });

    // #1978 — when setSetting throws SaasImmutableSettingError (SaaS admin
    // attempts to hot-reload an immutable key), the route must map it to
    // 409 with `error: "saas_immutable"` and a requestId. Without this
    // integration test, removing the route's catch block would leave the
    // 500 path unobserved by tests.
    it("maps SaasImmutableSettingError to 409 with saas_immutable error code", async () => {
      const { SaasImmutableSettingError } = await import("@atlas/api/lib/settings-errors");
      mockSetSetting.mockImplementationOnce(() => {
        return Promise.reject(new SaasImmutableSettingError("ATLAS_EMAIL_PROVIDER"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(409);

      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("saas_immutable");
      expect(data.message).toContain("cannot be changed at runtime");
      // requestId is set by the auth middleware — its presence is the
      // contract for client-side log correlation.
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
    });

    it("propagates non-SaasImmutable setSetting errors as 500", async () => {
      mockSetSetting.mockImplementationOnce(() => {
        return Promise.reject(new Error("unrelated DB connection failure"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      // Generic errors must NOT be silently mapped to 409 — verify the
      // catch block's `throw err` re-raise path stays intact, and that
      // the 500 envelope carries a requestId for log correlation.
      expect(res.status).toBe(500);
      const data = (await res.json()) as { requestId?: string };
      expect(typeof data.requestId).toBe("string");
      expect(data.requestId).not.toBe("");
    });
  });

  // ─── DELETE /settings/:key ──────────────────────────────────────

  describe("DELETE /api/v1/admin/settings/:key", () => {
    it("deletes an override", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { success: boolean };
      expect(data.success).toBe(true);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
    });

    it("rejects unknown keys", async () => {
      const res = await request("/api/v1/admin/settings/NONEXISTENT_KEY", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });

    it("rejects secret settings", async () => {
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    // #3389 — deleteSetting now enforces SAAS_IMMUTABLE_KEYS like
    // setSetting (clearing an override is a write). The route must map
    // the error to the SAME 409 envelope the PUT handler produces, so
    // the admin UI handles both verbs uniformly.
    it("maps SaasImmutableSettingError to 409 with saas_immutable error code (#3389)", async () => {
      const { SaasImmutableSettingError } = await import("@atlas/api/lib/settings-errors");
      mockDeleteSetting.mockImplementationOnce(() => {
        return Promise.reject(new SaasImmutableSettingError("ATLAS_EMAIL_PROVIDER"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(409);

      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("saas_immutable");
      expect(data.message).toContain("cannot be changed at runtime");
      // Same requestId contract as the PUT 409 path.
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
    });

    it("propagates non-SaasImmutable deleteSetting errors as 500", async () => {
      mockDeleteSetting.mockImplementationOnce(() => {
        return Promise.reject(new Error("unrelated DB connection failure"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      // Generic errors must NOT be silently mapped to 409 — verify the
      // catch block's `throw err` re-raise path stays intact, and that
      // the 500 envelope carries a requestId for log correlation.
      expect(res.status).toBe(500);
      const data = (await res.json()) as { requestId?: string };
      expect(typeof data.requestId).toBe("string");
      expect(data.requestId).not.toBe("");
    });
  });

  // ─── GET scope filtering ────────────────────────────────────────

  describe("GET /api/v1/admin/settings scope filtering", () => {
    it("workspace admin GET → getSettingsForAdmin called with (orgId, false)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // Workspace admin with orgId → isPlatformAdmin=false, !orgId=false → second arg is false
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith("org-1", false);
    });

    it("platform admin GET → getSettingsForAdmin called with (orgId, true)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // Platform admin → isPlatformAdmin=true → second arg is true
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith("org-1", true);
    });

    it("self-hosted admin GET → getSettingsForAdmin called with (undefined, true)", async () => {
      mockGetSettingsForAdmin.mockClear();
      // Default mock: no activeOrganizationId, role=admin → self-hosted

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // No orgId → !orgId=true → second arg is true
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, true);
    });

    // #3395 — GET's showAll classification matches the write gates: on
    // SaaS, only platform admins see platform-scoped settings. A no-org
    // non-platform-admin session is a workspace admin (same as #3389's
    // write classification), so showAll must be false. The mode probe
    // stays GET's display-only permissive `getConfig()?.deployMode` read.
    it("SaaS no-org non-platform-admin GET → showAll is false (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, false);
    });

    it("self-hosted no-org admin GET keeps showAll (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default mock: no activeOrganizationId, role=admin

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, true);
    });

    it("SaaS no-org platform admin GET keeps showAll (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, true);
    });
  });

  // ─── Org-scoped settings ────────────────────────────────────────

  describe("org-scoped settings enforcement", () => {
    it("workspace admin cannot update platform-scoped settings", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.message).toContain("platform-level setting");
    });

    it("workspace admin cannot delete platform-scoped settings", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.message).toContain("platform-level setting");
    });

    it("workspace admin can update workspace-scoped settings with orgId passthrough", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Verify orgId is forwarded for workspace-scoped settings
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "ws-admin-1", "org-1");
    });

    it("workspace admin can delete workspace-scoped settings with orgId passthrough", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      // Verify orgId is forwarded for workspace-scoped settings
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "ws-admin-1", "org-1");
      // #4669 — DELETE's audit annotation is a separate copy of PUT's;
      // pin its workspace arm too.
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ platformTier: false }),
      );
    });

    it("platform admin can update platform-scoped settings — orgId NOT forwarded", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Platform-scoped: orgId should NOT be forwarded
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "platform-admin-1", undefined);
    });

    it("self-hosted admin (no org) can update platform-scoped settings", async () => {
      // Default mock has no activeOrganizationId — simulates self-hosted
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Self-hosted: no orgId
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "admin-1", undefined);
    });
  });

  // ─── SaaS write gate (#3376) ────────────────────────────────────

  describe("saasWritable enforcement (#3376)", () => {
    // Mock a SaaS workspace admin (org-scoped, role=admin, not platform_admin)
    function asSaasWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    function asSaasPlatformAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    beforeEach(() => {
      // Runs after the outer beforeEach (which resets to null), so every
      // test in this block starts in SaaS mode unless it overrides.
      mockConfigOverride = { deployMode: "saas" };
    });

    it("SaaS workspace admin PUT on a hidden key (saasWritable inherits saasVisible=false) → 403", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("managed by Atlas in SaaS mode");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("SaaS workspace admin DELETE on a hidden key → 403", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("forbidden");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    // Pins the /admin/sandbox save path: the sandbox page writes
    // ATLAS_SANDBOX_BACKEND through this route on SaaS (#3375/#3376).
    // If the split flag regresses to plain saasVisible enforcement,
    // this test fails before the sandbox page breaks in prod.
    it("SaaS workspace admin PUT on ATLAS_SANDBOX_BACKEND (saasVisible:false, saasWritable:true) succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "vercel-sandbox" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", "vercel-sandbox", "ws-admin-1", "org-1");
    });

    it("SaaS workspace admin DELETE on ATLAS_SANDBOX_BACKEND succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", "ws-admin-1", "org-1");
    });

    it("SaaS platform admin PUT on a hidden key succeeds (flag never restricts platform admins)", async () => {
      asSaasPlatformAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "ecommerce" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("self-hosted workspace admin PUT on a hidden key is unaffected", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "cybersecurity" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("self-hosted workspace admin DELETE on a hidden key is unaffected", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
    });

    // #3389 — "unloaded" (getConfig() → null: config legitimately never
    // loaded, the AGPL/dev case) stays permissive. Only config-resolution
    // FAILURE fails closed — see the "fail-closed mode probe" block below.
    it("unloaded config (getConfig() → null) is treated as self-hosted — write allowed", async () => {
      mockConfigOverride = null;
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "saas" }),
      });
      expect(res.status).toBe(200);
    });

    it("SaaS workspace admin PUT on a visible workspace key still succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("secret check still fires under SaaS (unchanged by the write gate)", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("Secret settings");
    });

    it("platform-scope check still fires under SaaS (unchanged by the write gate)", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
    });
  });

  // ─── Fail-closed mode probe (#3389) ─────────────────────────────

  describe("fail-closed mode probe on the write path (#3389)", () => {
    // Simulate config resolution FAILING at request time: the real
    // isSaasModeForGuard() returns true ("errored" → assume SaaS) — that
    // behavior is pinned in lib/__tests__/settings-saas.test.ts. Here we
    // verify the route gates consume the probe's fail-closed verdict
    // (restrictive) instead of the old permissive getConfig() → null read.
    function simulateConfigResolutionFailure() {
      mockConfigOverride = null; // getConfig() would yield nothing useful
      mockIsSaasModeForGuard.mockImplementation(() => true);
    }

    function asWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    it("saasWritable gate is restrictive on PUT when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("saasWritable gate is restrictive on DELETE when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("platform-scope gate (no-org session) is restrictive when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      // Default auth mock: role=admin, NO activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("platform admins are not affected by the fail-closed probe", async () => {
      simulateConfigResolutionFailure();
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── No-org SaaS session edge (#3389) ───────────────────────────

  describe("no-org SaaS session is classified like GET (#3389)", () => {
    // GET filters with `!isPlatformAdmin` only — a SaaS session with no
    // activeOrganizationId is a workspace admin there. The write path
    // must classify it the same way instead of letting `orgId &&
    // !isPlatformAdmin` wave the session past the platform-scope gate.
    function asSaasNoOrgAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
    }

    beforeEach(() => {
      mockConfigOverride = { deployMode: "saas" };
    });

    it("no-org SaaS admin PUT on a platform-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("no-org SaaS admin DELETE on a platform-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("no-org SaaS admin PUT on a hidden workspace key → 403 (saasWritable gate already org-independent)", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin keeps platform-scope write access", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });
  });

  // ─── No-org SaaS session × workspace-scoped keys (#3395) ────────

  describe("no-org SaaS session cannot reach the global row of a workspace-scoped key (#3395)", () => {
    // Workspace-scope sibling of the #3389 platform-scope alignment: with
    // no org context, a workspace-scoped write lands on the global
    // (org_id IS NULL) row — the tier-2 default resolution applies to
    // EVERY workspace. The route must 403 on SaaS; self-hosted no-org
    // keeps the global-override path (legitimate self-hosted admin write).
    function asSaasNoOrgAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
    }

    function asSaasNoOrgPlatformAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin" },
        }),
      );
    }

    beforeEach(() => {
      mockConfigOverride = { deployMode: "saas" };
    });

    it("SaaS no-org admin PUT on a workspace-scoped key → 403 (same envelope as the platform-scope gate)", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("workspace-scoped");
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("SaaS no-org admin DELETE on a workspace-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("workspace-scoped");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin PUT on a workspace-scoped key still succeeds (global override path)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // No orgId → the write targets the global (org_id IS NULL) row
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "admin-1", undefined);
    });

    it("self-hosted no-org admin DELETE on a workspace-scoped key still succeeds (global override path)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "admin-1", undefined);
    });

    it("SaaS no-org platform admin PUT on a workspace-scoped key succeeds (gate never restricts platform admins)", async () => {
      asSaasNoOrgPlatformAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "platform-admin-1", undefined);
    });

    it("SaaS org-scoped workspace admin PUT on a workspace-scoped key is unaffected (org row, not global)", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "ws-admin-1", "org-1");
    });

    it("workspace-scope no-org gate is restrictive when the probe fails closed", async () => {
      // Same fail-closed contract as the #3389 gates: config-resolution
      // failure at request time ⇒ isSaasModeForGuard() → true ⇒ restrictive.
      mockConfigOverride = null;
      mockIsSaasModeForGuard.mockImplementation(() => true);
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("unloaded config (getConfig() → null) is treated as self-hosted — no-org workspace write allowed", async () => {
      mockConfigOverride = null;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Explicit platform-tier writes (#4669) ──────────────────────

  describe("explicit platform-tier writes (#4669)", () => {
    // The platform console writes the GLOBAL (org_id IS NULL) row of a
    // workspace-scoped key via ?tier=platform — explicit in the request,
    // never inferred from the session org, so a platform admin with an
    // active workspace still reaches the global row.
    function asPlatformAdminWithOrg() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    function asWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    it("platform admin WITH an active org: PUT ?tier=platform writes the global row (orgId NOT forwarded)", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // The whole point of #4669: activeOrganizationId is org-1, but the
      // explicit tier targets the global row → orgId undefined.
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "true", "platform-admin-1", undefined);
      // Audit trail records the row the write actually landed on.
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ platformTier: true }),
      );
    });

    it("platform admin WITH an active org: DELETE ?tier=platform clears the global row", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "platform-admin-1", undefined);
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ platformTier: true }),
      );
    });

    it("workspace admin PUT ?tier=platform → 403, write never reached", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("platform_admin");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("workspace admin DELETE ?tier=platform → 403, delete never reached", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("platform_admin");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    function asSaasNoOrgAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
    }

    it("SaaS no-org non-platform-admin PUT ?tier=platform → 403", async () => {
      mockConfigOverride = { deployMode: "saas" };
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    // The DELETE tier gate is a separate copy of the PUT gate — mirror the
    // probe-dependent arms so the two handlers cannot silently diverge on
    // who may clear the global row (a cross-workspace default reset).
    it("SaaS no-org non-platform-admin DELETE ?tier=platform → 403", async () => {
      mockConfigOverride = { deployMode: "saas" };
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin PUT ?tier=platform keeps the global-override path (#3395 parity)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "true", "admin-1", undefined);
    });

    it("self-hosted no-org admin DELETE ?tier=platform keeps the global-override path (#3395 parity)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "admin-1", undefined);
    });

    it("tier gate is restrictive when the mode probe fails closed", async () => {
      mockConfigOverride = null;
      mockIsSaasModeForGuard.mockImplementation(() => true);
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("DELETE tier gate is restrictive when the mode probe fails closed", async () => {
      mockConfigOverride = null;
      mockIsSaasModeForGuard.mockImplementation(() => true);
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("without ?tier, a workspace admin's PUT still lands on the WORKSPACE row (/admin/settings unchanged)", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "false" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "false", "ws-admin-1", "org-1");
      // Audit trail labels the workspace-row write accordingly.
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ platformTier: false }),
      );
    });

    it("?tier=platform on a platform-scoped key is accepted (already global) for platform admins", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "platform-admin-1", undefined);
    });

    it("unknown tier value is schema-rejected (422), no inference", async () => {
      // ⚠️ NO `asPlatformAdminWithOrg()` HERE, and its absence is the point.
      // `z.enum(["platform"])` rejects this in the router's shared
      // `validationHook`, BEFORE the handler — and `adminAuthAndContext`
      // authenticates inside the handler, so `authenticateRequest` is never
      // called. A session queued with `mockImplementationOnce` is therefore left
      // UNCONSUMED and leaks into the next test; nothing resets this mock between
      // tests at all.
      //
      // Measured: with the queue here, the "PUT passes the full entry" test below
      // received actor `platform-admin-1` / orgId `"org-1"` instead of the
      // `admin-1` default it never chose, and passed anyway because
      // `platformTier: expect.any(Boolean)` accepts either. The session was
      // pointless for a request that 422s at validation, so deleting it removes
      // the leak at source, and `createApiTestMocks` now exposes `resetPerTest()`
      // for the general case.
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      // The router's shared validationHook defaultHook → 422 Unprocessable Entity.
      expect(res.status).toBe(422);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });
  });

  // ─── what the route hands the audit seam (#5270) ───────────────

  describe("the route→seam audit contract (#5270)", () => {
    // ⚠️ EVERY OTHER ASSERTION ON THIS SEAM IS `objectContaining({
    // platformTier })`, which leaves `key`, `definition`, `value` and
    // `action` unobserved. That matters because `definition` and `value` are
    // the two inputs the redaction decision is made from, and both are
    // type-legal to break in one word:
    //
    //   `definition: def` → `definition: undefined`
    //        every write records `[withheld:secret-setting]` /
    //        `unknown_definition` — the audit trail's usefulness is gone
    //   `value` → `value: ""`
    //        every write records an empty value
    //
    // Neither is a brand violation (the value still goes through
    // `redactAuditValue`), so the type cannot see either. These are the
    // seam-preserving edits the module docstring says the brand does not
    // close.

    it("⭐ PUT passes the full entry — key, definition, value, action, tier, ip", async () => {
      // ⚠️ `x-forwarded-for` is SENT here. Round 1 asserted `ipAddress: null`,
      // which is also what a route that stopped reading the headers produces
      // — accidental equality, in the describe written to close exactly that.
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      // ⚠️ THE ACTOR AND ORG, which nothing here asserted. This describe's whole
      // premise is "every argument is observed", and it was observing a session
      // leaked from another test — see the 422 test above. Asserting the default
      // session makes that leak fail loudly instead of silently changing what
      // this test measures.
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "admin-1", undefined);
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith({
        key: "ATLAS_ROW_LIMIT",
        // The REAL definition for THIS key — not `undefined`, and not another
        // key's entry (which the seam now withholds on; see
        // `lib/audit/__tests__/settings-write.test.ts`).
        definition: expect.objectContaining({ key: "ATLAS_ROW_LIMIT" }),
        value: "500",
        action: "update",
        platformTier: expect.any(Boolean),
        ipAddress: "203.0.113.7",
      });
    });

    it("⭐ DELETE passes action reset_to_default and NO value", async () => {
      // The untested mirror half. `metadata.action` is the ONLY thing
      // separating the two verbs in `admin_action_log` — `ADMIN_ACTIONS
      // .settings` has a single member, so PUT and DELETE both file
      // `settings.update`. Flipping this to "update" made every DELETE
      // indistinguishable from a PUT with nothing red.
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith({
        key: "ATLAS_ROW_LIMIT",
        definition: expect.objectContaining({ key: "ATLAS_ROW_LIMIT" }),
        value: undefined,
        action: "reset_to_default",
        platformTier: expect.any(Boolean),
        ipAddress: null,
      });
    });

    it("⭐ neither verb writes a SECOND row through the fire-and-forget sink", async () => {
      // Re-adding the old `logAdminAction({ …, metadata: { key, value, tier }
      // })` next to the new call would restore the unredacted, workspace-
      // scoped durable row while every other test stayed green. `mockLog
      // AdminAction` was declared and cleared but never asserted on.
      await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", { method: "DELETE" });
      expect(mockLogAdminAction).not.toHaveBeenCalled();
    });

    it("does NOT reach the seam at all when the secret-key gate 403s", async () => {
      // ⚠️ THE REACHABILITY PREMISE, which had no test. `admin.ts` 403s a
      // `secret: true` key before the write, which is why the seam's
      // redaction is defense-in-depth rather than the live control #5270
      // claimed. Pinning the gate here means that if it is ever relaxed — to
      // let platform admins rotate a key from the UI, say — this test is what
      // says the redaction has just become load-bearing.
      // Uses the file's shared registry fixture rather than a
      // hand-built definition — a fixture written for this test could agree
      // with it by construction.
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-ant-live-secret" }),
      });
      expect(res.status).toBe(403);
      expect(mockAuditSettingsWrite).not.toHaveBeenCalled();
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("DELETE's secret gate also stops short of the seam", async () => {
      // The mirror half — the PUT twin above had this and DELETE did not.
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(mockAuditSettingsWrite).not.toHaveBeenCalled();
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("⭐ an EMPTY activeOrganizationId is a platform-tier write, not a workspace one", async () => {
      // ⚠️ The one input class where `!effectiveOrgId` and `=== undefined`
      // disagree, and the reason the delta table at the call sites exists.
      // `activeOrganizationId` is typed `string | undefined`, so `""` is in
      // the type; `setSetting` treats it as the GLOBAL row (its own checks
      // are truthiness), so the audit row must say platform. Under
      // `=== undefined` this lands `platformTier: false` → `scope:
      // "workspace"` → back onto the org-scoped read API this PR exists to
      // keep it off. Round 1 wrote the table and shipped no test for it.
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: {
            id: "ws-admin-1",
            mode: "better-auth",
            label: "Admin",
            role: "admin",
            activeOrganizationId: "",
          },
        }),
      );
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockAuditSettingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ platformTier: true }),
      );
    });
  });

  // ─── the audit row is awaited (#5262) ──────────────────────────

  describe("an audit row that cannot be committed (#5262)", () => {
    // The residual #5262 is actually about: `logAdminAction` DROPS the row
    // when the internal-DB circuit breaker is open, and past that breaker it
    // emits nothing at any level — only an anonymous counter. The mechanism
    // is stated once, in `lib/audit/settings-write.ts`'s header; this comment
    // deliberately does not restate it, because round 1 corrected the header
    // and left three restatements of the retracted version behind.
    // Awaiting the row turns a silently unrecorded config change into a
    // response the admin sees.
    const auditDown = () => {
      mockAuditSettingsWrite.mockImplementationOnce(() =>
        Promise.reject(new Error("circuit breaker open")),
      );
    };

    it("PUT 500s when the audit row is rejected", async () => {
      auditDown();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string; requestId: string };
      expect(body.error).toBe("audit_not_committed");
      // ⚠️ THE MESSAGE'S CLAIM, not just its presence. The write already
      // landed and the cache is already updated, so a body implying the
      // change did not apply would send the admin to re-check the wrong
      // thing. It has to say the setting DID change and is unaudited.
      expect(body.message).toContain("already in effect");
      expect(body.message).toContain("unaudited");
      expect(body.requestId).toBeTruthy();
    });

    it("⭐ and the write really did land — the 500 is about the record, not the write", async () => {
      // Without this, a handler that rolled the setting back on audit failure
      // would satisfy the status assertion above while doing something
      // completely different, and the message would then be a lie.
      auditDown();
      await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // The submitted value, not a rollback to anything else.
      expect(mockSetSetting).toHaveBeenCalledWith(
        "ATLAS_ROW_LIMIT",
        "500",
        expect.any(String),
        undefined,
      );
      // ⚠️ THE NEGATIVE, because the natural rollback is the OTHER verb.
      // `toHaveBeenCalledTimes(1)` on setSetting catches a rollback written
      // as a second `setSetting`; it cannot see `deleteSetting(key, …)` in
      // the audit catch — which would make "already in effect" a lie while
      // every assertion above stayed green.
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("DELETE 500s the same way — the clear path is a write too", async () => {
      auditDown();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", { method: "DELETE" });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string; requestId: string };
      expect(body.error).toBe("audit_not_committed");
      expect(body.message).toContain("reset to its default");
      expect(body.message).toContain("already in effect");
      // The PUT twin asserts this; the DELETE one did not. Every 500 in this
      // repo carries a requestId for log correlation, and this one more than
      // most — it is the ONLY handle on a config change that was not audited.
      expect(body.requestId).toBeTruthy();
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      // The mirror of the PUT negative: no rollback via the other verb.
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("⭐ resetPerTest drains a queued SESSION override, not just recorded calls", async () => {
      // ⚠️ THE FALSIFIER FOR `mocks.resetPerTest()`, which otherwise has none —
      // the auth leak was fixed at its source (the 422 test no longer queues a
      // pointless session), so nothing would notice the reset being removed.
      // Written order-independently: queue, drain, then observe, all in one test,
      // rather than relying on two tests running adjacently.
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "leaked-actor", role: "platform_admin", activeOrganizationId: "org-leak" },
        }),
      );
      mocks.resetPerTest();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      // The DEFAULT actor, not the queued one. `mockClear` would leave the queue
      // intact and this would read `leaked-actor`.
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "admin-1", undefined);
    });

    it("⭐ a queued audit rejection does NOT leak past a request that 403s before the seam", async () => {
      // ⚠️ THE FALSIFIER FOR THE `mockReset` IN `beforeEach`, which had none —
      // every existing `auditDown()` test consumes its own queued rejection, so
      // `mockReset` vs `mockClear` was behaviourally identical under this suite
      // and reverting the fix could not go red.
      //
      // This queues a rejection and then sends a request that 403s on
      // `def.secret` BEFORE reaching the seam, so the queue is left unconsumed.
      // The next test then decides whether `beforeEach` drained it: with
      // `mockClear` the parked rejection lands on the following request and
      // 500s it, far from the cause.
      auditDown();
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      });
      expect(res.status).toBe(403);
      expect(mockAuditSettingsWrite).not.toHaveBeenCalled();
    });

    it("stays 200 when the audit row commits — the arm that must NOT fail", async () => {
      // ⚠️ ALSO the assertion half of the leak test above: it runs immediately
      // after, so a rejection that survived `beforeEach` fails HERE with a 500.
      // The other half of the claim: a route that 500'd unconditionally would
      // pass all three tests above.
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── regionApiUrl in response ──────────────────────────────────

  describe("GET /api/v1/admin/settings regionApiUrl", () => {
    it("includes regionApiUrl when workspace has region with apiUrl", async () => {
      mockWorkspaceRegion = "eu-west";
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBe("https://api-eu.useatlas.dev");
    });

    it("omits regionApiUrl when workspace has no region", async () => {
      mockWorkspaceRegion = null;
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when region has no apiUrl configured", async () => {
      mockWorkspaceRegion = "us-east";
      mockConfigOverride = {
        residency: {
          regions: {
            "us-east": { label: "US East", databaseUrl: "postgresql://us-east/atlas" },
          },
          defaultRegion: "us-east",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when no residency config", async () => {
      // Default: mockConfigOverride = null → getConfig() returns null
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl for self-hosted admin (no org)", async () => {
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      // Default mock: no activeOrganizationId
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when workspace region is not in config (region drift)", async () => {
      mockWorkspaceRegion = "ap-south"; // region assigned but decommissioned from config
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("returns 200 and omits regionApiUrl when getWorkspaceRegion throws", async () => {
      mockWorkspaceRegion = null;
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      // Override getWorkspaceRegion to throw (simulating a DB error)
      const { getWorkspaceRegion: gwrMock } = await import("@atlas/api/lib/db/internal");
      (gwrMock as ReturnType<typeof mock>).mockImplementationOnce(() => {
        throw new Error("connection refused");
      });

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });
  });
});
