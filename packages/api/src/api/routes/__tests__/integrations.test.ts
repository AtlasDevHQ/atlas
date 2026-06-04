/**
 * Tests for the platform-install routes (#2654, slice 6).
 *
 * Focus: the OAuth callback's response shape. Slice 5 already covered the
 * happy-path 302 + the credential-partial 302; slice 6 promotes hard
 * failures (`null` state, upstream `oauth.v2.access` non-OK) from JSON
 * 400/502 to 302 redirects when the caller is a browser (`Accept:
 * text/html`). JSON-Accept callers still get the original 400/502 so
 * curl-based debugging stays machine-readable.
 *
 * The test app mounts the integrations router at /api/v1/integrations
 * and stubs out the install handler's dispatch via a fake handler so the
 * tests don't depend on the real Slack `oauth.v2.access` round-trip or
 * the workspace_plugins INSERT.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Context, Effect, Layer } from "effect";
import {
  BillingCheckFailedError,
  ChatIntegrationLimitError,
  PlatformOAuthExchangeError,
  TelegramChatIdInvalidError,
} from "@atlas/api/lib/effect/errors";
import {
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
import {
  _resetInstallHandlerRegistries,
  registerFormHandler,
  registerOAuthDatasourceHandler,
  registerOAuthHandler,
  registerStaticBotHandler,
  type FormBasedInstallHandler,
  type OAuthDatasourceInstallHandler,
  type OAuthPlatformInstallHandler,
  type StaticBotInstallHandler,
} from "@atlas/api/lib/integrations/install";
import { FormInstallValidationError } from "@atlas/api/lib/integrations/install/email-form-handler";

// ---------------------------------------------------------------------------
// Auth — admin user with an org binding for the install route. The
// callback handler doesn't gate on auth (the state token is the gate),
// so the admin shape is only load-bearing for the install endpoint;
// callback tests pass anonymous requests through fine.
// ---------------------------------------------------------------------------

// Swappable auth result so individual tests can drive the route's
// auth-failure branches (F-04 SaaS mode=none, missing-org, 401, 403).
// Defaults to the admin happy path; per-suite `beforeEach` blocks
// override via `authResultImpl = …`.
type AuthResult = {
  authenticated: boolean;
  mode: "managed" | "none";
  user?: {
    id: string;
    role: string;
    activeOrganizationId?: string;
    // DELETE tests use `claims.twoFactorEnabled` to pass / fail the
    // `shouldRequireMfaForAuthResult` gate. Install/callback tests
    // can omit it — those branches don't reach the MFA check.
    claims?: Record<string, unknown>;
  };
  error?: string;
  status?: 401 | 403 | 500;
};
let authResultImpl: () => Promise<AuthResult> = async () => ({
  authenticated: true,
  mode: "managed",
  user: {
    id: "admin-1",
    role: "admin",
    activeOrganizationId: "ws-1",
    // Default test admin has MFA enrolled so the DELETE handler's
    // gate passes — the unenrolled branch gets its own test.
    claims: { twoFactorEnabled: true },
  },
});

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() => authResultImpl()),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

// Swappable deploy mode so F-04 SaaS-mode=none tests can simulate the
// SaaS posture without bleeding into the OAuth callback suites.
let deployModeImpl: () => string | undefined = () => undefined;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: deployModeImpl() }),
  defineConfig: (c: unknown) => c,
}));

// ---------------------------------------------------------------------------
// Internal DB — the catalog row lookup hits `internalQuery`. Default
// response is the Slack OAuth row; individual tests override via
// `mockInternalQuery.mockImplementationOnce` for the "platform not
// found" path.
// ---------------------------------------------------------------------------

// SQL-aware default: route the catalog query and the workspace
// entitlement query (#2701 / #2702) to distinct mock rows. Each
// test's `mockImplementation` override still receives both queries
// — to keep existing tests terse, the override only needs to supply
// the catalog row; the org row is patched in below if absent.
function defaultMockInternalQuery(sql: string): unknown[] {
  if (sql.includes("FROM organization")) {
    return [{ plan_tier: "business", is_operator_workspace: false }];
  }
  return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
}

const mockInternalQuery = mock(
  async (sql: string, _params?: unknown[]): Promise<unknown[]> => defaultMockInternalQuery(sql),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => Promise.resolve()),
  makeInternalDBShimLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  makeInternalDBLive: () => Layer.succeedContext(Context.empty()),
  createInternalDBTestLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  getInternalDB: () => ({
    query: mockInternalQuery,
    connect: () => ({ query: mockInternalQuery, release: () => {} }),
    end: async () => {},
    on: () => {},
  }),
  closeInternalDB: async () => {},
  queryEffect: (sql: string, params?: unknown[]) =>
    Effect.tryPromise({
      try: () => mockInternalQuery(sql, params),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  insertSemanticAmendment: async () => {},
  getPendingAmendmentCount: async () => 0,
  getAutoApproveThreshold: () => 0.95,
  getAutoApproveTypes: () => new Set<string>(),
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  isPlaintextUrl: () => true,
  _resetEncryptionKeyCache: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
}));

// ---------------------------------------------------------------------------
// Slack store — DELETE handler calls `deleteInstallation(teamId)` to
// drop the chat_cache row before deleting the workspace_plugins row.
// `callOrder` is a shared spool so the ADR-0003 ordering assertion has
// a single source of truth across both stores.
// ---------------------------------------------------------------------------

const callOrder: string[] = [];

const mockDeleteInstallation = mock(async (_teamId: string): Promise<void> => {
  callOrder.push("chat_cache.delete");
});

const mockDeleteCredentialBundle = mock(async (_workspaceId: string, _catalogId: string): Promise<boolean> => {
  callOrder.push("integration_credentials.delete");
  return true;
});

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  deleteCredentialBundle: mockDeleteCredentialBundle,
  // CLAUDE.md "Mock all exports" — the disconnect path only calls
  // `deleteCredentialBundle`; stub the read/write so other tests that
  // import this module don't see partial mocks.
  readCredentialBundle: mock(() => Promise.resolve(null)),
  saveCredentialBundle: mock(() => Promise.resolve()),
}));

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: mockDeleteInstallation,
  // mock.module() requires every named export to be mocked (CLAUDE.md
  // "Mock all exports"). The disconnect handler only calls
  // `deleteInstallation`; the rest are no-op stubs.
  getInstallation: mock(() => Promise.resolve(null)),
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  saveInstallation: mock(() => Promise.resolve()),
  deleteInstallationByOrg: mock(() => Promise.resolve(false)),
  getBotToken: mock(() => Promise.resolve(null)),
  ENV_TEAM_ID: "env",
  KEY_PREFIX: "slack:installation:",
  FIELD: {
    botToken: "botToken",
    teamName: "teamName",
    orgId: "orgId",
    workspaceName: "workspaceName",
    installedAt: "installedAt",
    botUserId: "botUserId",
  },
}));

// Misrouting — disconnect calls `detectMisrouting` + `isStrictRoutingEnabled`
// to refuse cross-region requests. Default to "not misrouted, strict off"
// so the happy path runs; the 421 test flips both.
let mockMisrouted:
  | {
      expectedRegion: string;
      actualRegion: string;
      correctApiUrl: string | undefined;
    }
  | null = null;
let mockStrictRouting = false;

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: () => Promise.resolve(mockMisrouted),
  isStrictRoutingEnabled: () => mockStrictRouting,
}));

// `verifyOAuthStateToken` needs an encryption key to round-trip a real
// token, but the test env doesn't configure one. Stub the module so
// tests can drive the route's `verifiedState` branch (used by the
// /callback mid-OAuth plan re-check) without standing up the keyset.
// CLAUDE.md: mock ALL named exports — partial mocks break other
// test files. `mintOAuthStateToken` is mocked too even though no
// test below calls it directly.
let stubVerifiedState: { workspaceId: string; catalogId: string } | null = null;
mock.module("@atlas/api/lib/integrations/install/oauth-state-token", () => ({
  mintOAuthStateToken: () => "stub",
  verifyOAuthStateToken: () => stubVerifiedState,
}));

// ---------------------------------------------------------------------------
// Web origin — fixes the absolute redirect target so tests can assert
// the full URL without depending on the host's env.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_CORS_ORIGIN ??= "https://app.atlas.example";

// ---------------------------------------------------------------------------
// Fake OAuth handler — swapped in per test via the install registry's
// idempotent registerOAuthHandler. Drives the callback's three branches:
//
//   - happy:    returns { credentialResult: { written: true } }
//   - reconnect: returns { credentialResult: { written: false } }
//   - invalid:  returns null
//   - upstream: throws PlatformOAuthExchangeError
//
// Slice 5 already covers the handler's internal contract; here we only
// need the route's view of the four outcomes.
// ---------------------------------------------------------------------------

type CallbackResult = Awaited<ReturnType<OAuthPlatformInstallHandler["handleCallback"]>>;
type ValidateResult = Awaited<ReturnType<FormBasedInstallHandler["validateConfig"]>>;

let callbackImpl: () => Promise<CallbackResult> = async () => null;

// startInstall is swapped per test so the `/install` error-passthrough tests
// can make it throw (#2998 — the route wraps startInstall in a try/catch that
// must re-throw anything that isn't ChatIntegrationLimitError unchanged).
type StartInstallResult = Awaited<ReturnType<OAuthPlatformInstallHandler["startInstall"]>>;
let startInstallImpl: () => Promise<StartInstallResult> = async () => ({
  redirectUrl: "https://slack.com/oauth/v2/authorize?client_id=test&state=stub",
  stateToken: "stub",
});

const fakeHandler: OAuthPlatformInstallHandler = {
  kind: "oauth" as const,
  startInstall: async () => startInstallImpl(),
  handleCallback: async () => callbackImpl(),
};

// Stubbed form handler — slug "email". The form-install tests below
// swap `validateImpl` per test so we can drive the validation /
// happy-path branches without depending on Postgres or real
// encryption. The real implementation is tested in
// `email-form-handler.test.ts`.
let validateImpl: (form: unknown) => Promise<ValidateResult> = async () => ({
  installRecord: { id: "install-email-1", workspaceId: "ws-1" as never, catalogId: "email" },
  credentialWritten: true,
});

const fakeFormHandler: FormBasedInstallHandler = {
  kind: "form" as const,
  validateConfig: async (_wsid, formData) => validateImpl(formData),
};

// ---------------------------------------------------------------------------
// Fake static-bot handler — slug "telegram" (#3140). The /install-form
// route's static-bot branch resolves the routing-identifier field from the
// catalog `config_schema` (first required string field), forwards its value
// to `confirmInstall`, and maps the handler's tagged failures to HTTP. We
// stub `confirmInstall` (swappable per test via `confirmInstallImpl`) and
// record its args so the routing-key resolution + extras split is asserted
// without standing up the real Telegram reachability round-trip. The cap
// gate's own behaviour (advisory lock, reconnect grandfathering) is covered
// by chat-cap-pg.test.ts + enforcement.test.ts; here we only need the
// route's view of confirmInstall's outcomes.
//
// `confirmArgs` captures the last call so tests assert the route resolved
// `chat_id` as the routing identifier and forwarded `display_name` as extras.
type ConfirmResult = Awaited<ReturnType<StaticBotInstallHandler["confirmInstall"]>>;
let confirmArgs: {
  workspaceId: string;
  routingIdentifier: string;
  verificationProof?: string;
  extras?: Record<string, unknown>;
} | null = null;
let confirmInstallImpl: () => Promise<ConfirmResult> = async () => ({
  installRecord: { id: "install-telegram-1", workspaceId: "ws-1" as never, catalogId: "telegram" },
});

const fakeStaticBotHandler: StaticBotInstallHandler = {
  kind: "static-bot" as const,
  // No `applicationId` — a form-shaped static-bot (Telegram/Teams/gchat/
  // WhatsApp). The OAuth-shaped rejection suite registers a separate handler
  // WITH applicationId under the "discord" slug.
  confirmInstall: async (workspaceId, routingIdentifier, verificationProof, extras) => {
    confirmArgs = { workspaceId: workspaceId as string, routingIdentifier, verificationProof, extras };
    return confirmInstallImpl();
  },
};

// OAuth-shaped static-bot — `oauthShaped: true` (Discord). The route must
// refuse a directly-typed routing id here (400 oauth_shaped_static_bot) because
// Discord's ownership proof rides on the OAuth bot-install redirect. Note it
// ALSO carries an `applicationId` (Discord's client id) — the route must key
// the refusal on `oauthShaped`, not `applicationId`.
let oauthShapedConfirmCalled = false;
const fakeOAuthShapedStaticBotHandler: StaticBotInstallHandler = {
  kind: "static-bot" as const,
  oauthShaped: true,
  applicationId: "operator-discord-client-id",
  confirmInstall: async () => {
    oauthShapedConfirmCalled = true;
    return { installRecord: { id: "should-not-happen", workspaceId: "ws-1" as never, catalogId: "discord" } };
  },
};

// Form-shaped static-bot that nonetheless exposes an `applicationId` — mirrors
// the real Teams (Microsoft App ID for the manifest URL) and WhatsApp (Meta App
// ID, for parity) handlers. `oauthShaped` is unset, so the route MUST accept it:
// keying the OAuth-shaped refusal on `applicationId` would wrongly reject these
// (the #3140 review trap). Registered under the "teams" slug.
let appIdConfirmCalled = false;
const fakeAppIdFormStaticBotHandler: StaticBotInstallHandler = {
  kind: "static-bot" as const,
  applicationId: "operator-teams-app-id",
  confirmInstall: async () => {
    appIdConfirmCalled = true;
    return { installRecord: { id: "install-teams-1", workspaceId: "ws-1" as never, catalogId: "teams" } };
  },
};

// Catalog `config_schema` for the static-bot suites — mirrors the real
// Telegram row: routing identifier first (required string), optional label
// second. The route picks `chat_id` as the routing key.
const TELEGRAM_CONFIG_SCHEMA = [
  { key: "chat_id", type: "string", label: "Chat ID", required: true },
  { key: "display_name", type: "string", label: "Display name", required: false },
];

// ---------------------------------------------------------------------------
// Late imports (after mocks)
// ---------------------------------------------------------------------------

const { integrations } = await import("../integrations");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/integrations", integrations);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// GitHub-shaped OAuth handler — exercises the route's installation_id
// branch (#2751). Same stub mechanism as the slack handler above, with
// the catalog slug pin so the route's `INSTALLATION_ID_PLATFORMS` set
// accepts the field for this callback URL.
const fakeGithubHandler: OAuthPlatformInstallHandler = {
  kind: "oauth" as const,
  startInstall: async () => ({
    redirectUrl: "https://github.com/apps/atlas-test/installations/new?state=stub",
    stateToken: "stub",
  }),
  handleCallback: async () => callbackImpl(),
};

beforeAll(() => {
  registerOAuthHandler("slack", fakeHandler);
  registerOAuthHandler("github", fakeGithubHandler);
  registerFormHandler("email", fakeFormHandler);
  registerStaticBotHandler("telegram", fakeStaticBotHandler);
  registerStaticBotHandler("discord", fakeOAuthShapedStaticBotHandler);
  registerStaticBotHandler("teams", fakeAppIdFormStaticBotHandler);
});

afterAll(() => {
  _resetInstallHandlerRegistries();
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  callbackImpl = async () => null;
  startInstallImpl = async () => ({
    redirectUrl: "https://slack.com/oauth/v2/authorize?client_id=test&state=stub",
    stateToken: "stub",
  });
  mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM organization")) {
      return [{ plan_tier: "business", is_operator_workspace: false }];
    }
    return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
  });
  authResultImpl = async () => ({
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      role: "admin",
      activeOrganizationId: "ws-1",
      claims: { twoFactorEnabled: true },
    },
  });
  deployModeImpl = () => undefined;
  callOrder.length = 0;
  mockDeleteInstallation.mockClear();
  mockDeleteInstallation.mockImplementation(async (_teamId: string) => {
    callOrder.push("chat_cache.delete");
  });
  mockDeleteCredentialBundle.mockClear();
  mockDeleteCredentialBundle.mockImplementation(async () => {
    callOrder.push("integration_credentials.delete");
    return true;
  });
  mockMisrouted = null;
  mockStrictRouting = false;
  // Static-bot fixtures — reset the swappable confirmInstall impl + arg
  // capture so each test starts from the happy default.
  confirmArgs = null;
  confirmInstallImpl = async () => ({
    installRecord: { id: "install-telegram-1", workspaceId: "ws-1" as never, catalogId: "telegram" },
  });
  oauthShapedConfirmCalled = false;
  appIdConfirmCalled = false;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function happyResult(): CallbackResult {
  return {
    workspaceId: "ws-1" as never,
    catalogId: "slack",
    installRecord: {
      id: "install-1",
      workspaceId: "ws-1" as never,
      catalogId: "slack",
    },
    credentialResult: { written: true },
  };
}

function partialResult(): CallbackResult {
  return {
    workspaceId: "ws-1" as never,
    catalogId: "slack",
    installRecord: {
      id: "install-1",
      workspaceId: "ws-1" as never,
      catalogId: "slack",
    },
    credentialResult: { written: false, reason: "Credential persist failed — admin should retry via Reconnect" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/slack/install — startInstall error passthrough (#2998)", () => {
  it("redirects to the handler's authorize URL on the happy path", async () => {
    const res = await request("/api/v1/integrations/slack/install", {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("slack.com/oauth/v2/authorize");
  });

  it("re-throws a non-cap error from startInstall unchanged (→ 500, NOT an admin redirect)", async () => {
    // The route's pre-redirect try/catch (#2998) special-cases only
    // ChatIntegrationLimitError. Every other throw — a state-token mint
    // failure, an unexpected DB error, a logic bug — must propagate to
    // runHandler's defect mapping (500 + requestId), never get silently
    // converted into a `reason=plan_limit_reached` redirect. This guards the
    // shared seam: the same route drives Salesforce / Jira / Linear / GitHub
    // startInstall, none of which run a chat cap.
    startInstallImpl = async () => {
      throw new Error("boom — unexpected startInstall failure");
    };
    const res = await request("/api/v1/integrations/slack/install", {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(500);
    // Did NOT degrade into a browser redirect to the admin UI.
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    // 500s carry a requestId for log correlation (CLAUDE.md).
    expect(body.requestId).toBeTypeOf("string");
  });
});

describe("GET /api/v1/integrations/slack/callback — happy path", () => {
  it("redirects to /admin/integrations?installed=slack on success", async () => {
    callbackImpl = async () => happyResult();

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/integrations?installed=slack",
    );
  });

  it("redirects with ?reconnect=slack when the credential write missed (ADR-0003 partial)", async () => {
    callbackImpl = async () => partialResult();

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/integrations?reconnect=slack",
    );
  });
});

describe("GET /api/v1/integrations/slack/callback — invalid state", () => {
  it("redirects to /admin/integrations?error=slack&reason=invalid_state for browser callers", async () => {
    callbackImpl = async () => null;

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=tampered",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://app.atlas.example/admin/integrations");
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=invalid_state");
  });

  it("still returns 400 JSON for application/json callers (back-compat for curl)", async () => {
    callbackImpl = async () => null;

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=tampered",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
  });
});

describe("GET /api/v1/integrations/slack/callback — upstream Slack failure", () => {
  it("redirects to /admin/integrations?error=slack&reason=upstream_error for browser callers", async () => {
    callbackImpl = async () => {
      throw new PlatformOAuthExchangeError({
        message: "Slack rejected the OAuth code.",
        platform: "slack",
        upstreamError: "invalid_code",
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=bad-code&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=upstream_error");
  });

  it("still returns 502 JSON for application/json callers", async () => {
    callbackImpl = async () => {
      throw new PlatformOAuthExchangeError({
        message: "Slack rejected the OAuth code.",
        platform: "slack",
        upstreamError: "invalid_code",
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=bad-code&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(502);
  });
});

describe("GET /api/v1/integrations/slack/callback — chat-integration cap (#2953)", () => {
  it("redirects to ?error=slack&reason=plan_limit_reached for browser callers when at cap", async () => {
    callbackImpl = async () => {
      throw new ChatIntegrationLimitError({
        message: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        workspaceId: "org-1",
        limit: 1,
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=plan_limit_reached");
  });

  it("returns 429 plan_limit_exceeded JSON (with limit) for application/json callers", async () => {
    callbackImpl = async () => {
      throw new ChatIntegrationLimitError({
        message: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        workspaceId: "org-1",
        limit: 1,
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; limit?: number };
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.limit).toBe(1);
  });

  it("returns 503 billing_check_failed (NOT a redirect / not 429) when the count check fails closed", async () => {
    // A count-check failure must surface as a transient 503 "try again",
    // never a misleading 429/upgrade redirect.
    callbackImpl = async () => {
      throw new BillingCheckFailedError({
        message: "Unable to verify plan limits. Please try again.",
        workspaceId: "org-1",
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).not.toBe(302);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/v1/integrations/slack/callback — non-OAuth-exchange failure", () => {
  // Slice 5's SlackOAuthInstallHandler re-throws raw errors when the
  // workspace_plugins INSERT fails — those must NOT be downgraded to a
  // "click Reconnect" toast. The browser caller still sees a 500 with a
  // request id so the admin reports an actual bug instead of cycling
  // through an unhelpful retry loop.
  it("rethrows non-PlatformOAuthExchangeError for browser callers — runHandler maps to 500", async () => {
    callbackImpl = async () => {
      throw new Error("workspace_plugins INSERT failed: connection refused");
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    // Definitely not a redirect masking the fault.
    expect(res.status).not.toBe(302);
    // runHandler's default mapper surfaces unknown errors as 500.
    expect(res.status).toBe(500);
  });

  it("rethrows non-PlatformOAuthExchangeError for JSON callers too", async () => {
    callbackImpl = async () => {
      throw new Error("workspace_plugins INSERT failed: connection refused");
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    // 500 responses always include a requestId for log correlation
    // (runHandler bridge invariant).
    expect(body.requestId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GitHub App callback — installation_id query-param branch (#2751).
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/github/callback — installation_id flow", () => {
  beforeEach(() => {
    // The catalog row lookup defaults to slack — override for this
    // suite so the route resolves the github catalog row.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization")) {
        return [{ plan_tier: "business", is_operator_workspace: false }];
      }
      return [{ slug: "github", install_model: "oauth", enabled: true, min_plan: "starter" }];
    });
  });

  it("accepts code + installation_id and redirects to /admin/integrations?installed=github on success", async () => {
    callbackImpl = async () => ({
      workspaceId: "ws-1" as never,
      catalogId: "github",
      installRecord: {
        id: "install-github-1",
        workspaceId: "ws-1" as never,
        catalogId: "github",
      },
      credentialResult: { written: true },
    });

    const res = await request(
      "/api/v1/integrations/github/callback?code=user-oauth&installation_id=123456789&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/integrations?installed=github",
    );
  });

  it("rejects github callback missing `installation_id` with 400 missing_credential_identifier", async () => {
    // Pin the route's defense against a forged callback URL: the
    // GitHub App install requires BOTH code (for user-OAuth ownership
    // verification) and installation_id. A callback with only one is
    // a tampered redirect or a misconfigured App.
    const res = await request(
      "/api/v1/integrations/github/callback?code=user-oauth&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("missing_credential_identifier");
    expect(body.requestId).toBeDefined();
  });

  it("rejects github callback missing `code` with 400 missing_credential_identifier", async () => {
    const res = await request(
      "/api/v1/integrations/github/callback?installation_id=123456789&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_credential_identifier");
  });
});

describe("GET /api/v1/integrations/slack/callback — installation_id rejection", () => {
  it("rejects installation_id on a non-GitHub callback URL with 400 unexpected_installation_id", async () => {
    // Defense against a tampered redirect: no upstream provider for
    // non-GitHub Platforms emits installation_id, so seeing it on a
    // Slack/Jira/etc. callback is unambiguously malicious. The route
    // must 400 before forwarding to the handler (which would otherwise
    // surface a misleading "Slack rejected the OAuth code" envelope).
    const res = await request(
      "/api/v1/integrations/slack/callback?installation_id=123&code=abc&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("unexpected_installation_id");
    expect(body.requestId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Salesforce-specific callback destination — slice 7 of 1.5.3 (#2745).
// Salesforce moved to `/admin/connections`, so its redirect targets must
// route there instead of `/admin/integrations`. Locks in the
// `adminDestinationForPlatform` exception so a future refactor that
// collapses the helper back to a single path is caught here.
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/salesforce/callback — redirects to /admin/connections", () => {
  let salesforceCallbackImpl: () => Promise<CallbackResult> = async () => null;

  const salesforceHandler: OAuthPlatformInstallHandler = {
    kind: "oauth" as const,
    startInstall: async () => ({
      redirectUrl: "https://login.salesforce.com/services/oauth2/authorize?client_id=test&state=stub",
      stateToken: "stub",
    }),
    handleCallback: async () => salesforceCallbackImpl(),
  };

  beforeAll(() => {
    registerOAuthHandler("salesforce", salesforceHandler);
  });

  beforeEach(() => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization")) {
        return [{ plan_tier: "business", is_operator_workspace: false }];
      }
      return [{ slug: "salesforce", install_model: "oauth", enabled: true, min_plan: "starter" }];
    });
    salesforceCallbackImpl = async () => null;
  });

  it("routes installed= to /admin/connections, not /admin/integrations", async () => {
    salesforceCallbackImpl = async () => ({
      workspaceId: "ws-1" as never,
      catalogId: "salesforce",
      installRecord: {
        id: "install-sf-1",
        workspaceId: "ws-1" as never,
        catalogId: "salesforce",
      },
      credentialResult: { written: true },
    });

    const res = await request(
      "/api/v1/integrations/salesforce/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/connections?installed=salesforce",
    );
  });

  it("routes reconnect= to /admin/connections when the credential write missed", async () => {
    salesforceCallbackImpl = async () => ({
      workspaceId: "ws-1" as never,
      catalogId: "salesforce",
      installRecord: {
        id: "install-sf-2",
        workspaceId: "ws-1" as never,
        catalogId: "salesforce",
      },
      credentialResult: { written: false, reason: "stub" },
    });

    const res = await request(
      "/api/v1/integrations/salesforce/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/connections?reconnect=salesforce",
    );
  });

  it("routes invalid_state error= to /admin/connections for browser callers", async () => {
    salesforceCallbackImpl = async () => null;

    const res = await request(
      "/api/v1/integrations/salesforce/callback?code=auth-abc&state=tampered",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://app.atlas.example/admin/connections");
    expect(location).toContain("error=salesforce");
    expect(location).toContain("reason=invalid_state");
  });
});

// ---------------------------------------------------------------------------
// github-data — oauth-datasource callback (v0.0.2 slice 6c, #3030).
//
// github-data shares the OAuth install/callback route with `oauth` but is a
// `pillar='datasource'` install that renders on `/admin/connections`. Two
// route-level invariants this suite pins (both untested when the slice landed):
//   1. The `install_model: 'oauth-datasource'` row is accepted on this route
//      and the github-data callback requires BOTH code + installation_id (the
//      same INSTALLATION_ID_PLATFORMS branch as the `github` action row).
//   2. The success / reconnect redirect lands on `/admin/connections` — NOT
//      `/admin/integrations` — because a datasource card lives there. A
//      regression collapsing `adminDestinationForPlatform` back to a single
//      path (or dropping github-data from INSTALLATION_ID_PLATFORMS) is caught
//      here.
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/github-data/callback — oauth-datasource flow", () => {
  let githubDataCallbackImpl: () => Promise<CallbackResult> = async () => null;

  const githubDataHandler: OAuthDatasourceInstallHandler = {
    kind: "oauth-datasource" as const,
    startInstall: async () => ({
      redirectUrl: "https://github.com/apps/atlas-test/installations/new?state=stub",
      stateToken: "stub",
    }),
    handleCallback: async () => githubDataCallbackImpl(),
  };

  beforeAll(() => {
    registerOAuthDatasourceHandler("github-data", githubDataHandler);
  });

  beforeEach(() => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization")) {
        return [{ plan_tier: "business", is_operator_workspace: false }];
      }
      return [{ slug: "github-data", install_model: "oauth-datasource", enabled: true, min_plan: "starter" }];
    });
    githubDataCallbackImpl = async () => null;
  });

  it("accepts code + installation_id and redirects to /admin/connections?installed=github-data on success", async () => {
    githubDataCallbackImpl = async () => ({
      workspaceId: "ws-1" as never,
      catalogId: "github-data",
      installRecord: { id: "install-gh-data-1", workspaceId: "ws-1" as never, catalogId: "github-data" },
      credentialResult: { written: true },
    });

    const res = await request(
      "/api/v1/integrations/github-data/callback?code=user-oauth&installation_id=123456789&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    // The fix: a datasource install lands on /admin/connections, not /admin/integrations.
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/connections?installed=github-data",
    );
  });

  it("routes reconnect= to /admin/connections when the credential health-check missed", async () => {
    githubDataCallbackImpl = async () => ({
      workspaceId: "ws-1" as never,
      catalogId: "github-data",
      installRecord: { id: "install-gh-data-2", workspaceId: "ws-1" as never, catalogId: "github-data" },
      credentialResult: { written: false, reason: "mint failed" },
    });

    const res = await request(
      "/api/v1/integrations/github-data/callback?code=user-oauth&installation_id=123456789&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/connections?reconnect=github-data",
    );
  });

  it("rejects github-data callback missing `installation_id` with 400 missing_credential_identifier", async () => {
    const res = await request(
      "/api/v1/integrations/github-data/callback?code=user-oauth&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("missing_credential_identifier");
    expect(body.requestId).toBeDefined();
  });

  it("rejects github-data callback missing `code` with 400 missing_credential_identifier", async () => {
    const res = await request(
      "/api/v1/integrations/github-data/callback?installation_id=123456789&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_credential_identifier");
  });
});

// ---------------------------------------------------------------------------
// POST /:platform/install-form — slice 7 (#2660)
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/:platform/install-form — happy path", () => {
  beforeEach(() => {
    // Catalog lookup returns the Email row for the form-install
    // branch; reset between tests since other suites pin "slack".
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    validateImpl = async () => ({
      installRecord: {
        id: "install-email-happy",
        workspaceId: "ws-1" as never,
        catalogId: "email",
      },
      credentialWritten: true,
    });
  });

  it("dispatches to the form handler and returns the install id on success", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "smtp.example.com",
        port: 587,
        username: "u",
        password: "p",
        fromAddress: "atlas@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installed: boolean; installId: string; platform: string };
    expect(body).toEqual({
      installed: true,
      platform: "email",
      installId: "install-email-happy",
    });
  });
});

describe("POST /api/v1/integrations/:platform/install-form — validation failure", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    // Simulate the real EmailFormInstallHandler refusing the form
    // for a missing password — the route must translate this to a
    // 400 with field-level detail.
    validateImpl = async () => {
      throw new FormInstallValidationError({
        fieldErrors: { password: ["password is required"] },
      });
    };
  });

  it("returns 400 with fieldErrors when the handler rejects the form", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      fieldErrors: Record<string, string[]>;
      requestId: string;
    };
    expect(body.error).toBe("invalid_form_data");
    expect(body.fieldErrors.password).toEqual(["password is required"]);
    expect(body.requestId).toBeDefined();
  });
});

describe("POST /api/v1/integrations/:platform/install-form — wrong install_model", () => {
  beforeEach(() => {
    // Catalog lookup returns the Slack row (oauth) but the caller
    // hit the form-install endpoint for it — must reject with 400.
    mockInternalQuery.mockImplementation(async () => [
      { slug: "slack", install_model: "oauth", enabled: true, min_plan: "free" },
    ]);
  });

  it("refuses with 400 wrong_install_model when the catalog row is OAuth", async () => {
    const res = await request("/api/v1/integrations/slack/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wrong_install_model");
  });
});

describe("POST /api/v1/integrations/:platform/install-form — unknown platform", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => []);
  });

  it("returns 404 when the catalog row doesn't exist", async () => {
    const res = await request("/api/v1/integrations/nope/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// F-04 install-hijack — SaaS deploy + mode=none must refuse outright.
// The OAuth route's mirror guard is exercised by slice 5 tests; here we
// pin the same posture for the new /install-form route so a managed-auth
// regression can't slip past both.
// ---------------------------------------------------------------------------

describe("POST /install-form — F-04 SaaS-mode-none guard", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      // Even with a user object present, mode=none under SaaS is a
      // misconfig — the route refuses without consulting it.
      user: { id: "anon", role: "admin", activeOrganizationId: undefined },
    });
  });

  it("refuses with 400 missing_org_binding under SaaS deploy + mode=none", async () => {
    deployModeImpl = () => "saas";
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
  });
});

// ---------------------------------------------------------------------------
// Missing org binding (managed mode, no activeOrganizationId) — pins
// the second auth-side fail-closed branch.
// ---------------------------------------------------------------------------

describe("POST /install-form — managed mode missing activeOrganizationId", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", role: "admin", activeOrganizationId: undefined },
    });
  });

  it("refuses with 400 missing_org_binding when the user has no active org", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
  });
});

// ---------------------------------------------------------------------------
// Dispatch failure modes — handler not registered (501) and kind
// mismatch (501). The kind mismatch is the "catalog says form but
// dispatch returns OAuth" canary — without it a registration typo
// would silently call .startInstall() on a form handler.
// ---------------------------------------------------------------------------

describe("POST /install-form — dispatch failures", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
  });

  it("returns 501 handler_unavailable when no form handler is registered for the slug", async () => {
    _resetInstallHandlerRegistries();
    try {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
    } finally {
      // Restore both handlers used by the rest of the suite.
      registerOAuthHandler("slack", fakeHandler);
      registerFormHandler("email", fakeFormHandler);
    }
  });

  it("returns 501 handler_unavailable when the registered handler's kind doesn't match the catalog row", async () => {
    // Force the kind mismatch: a real misconfig would land here if an
    // operator wired registerFormHandler against an OAuth handler.
    _resetInstallHandlerRegistries();
    registerFormHandler("email", fakeHandler as unknown as FormBasedInstallHandler);
    try {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
    } finally {
      registerOAuthHandler("slack", fakeHandler);
      registerFormHandler("email", fakeFormHandler);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan-tier gating (#2701 / #2702) — install + install-form + callback
// each return 403 plan_upgrade_required when the workspace's tier ranks
// below the catalog row's min_plan, and operator workspaces bypass the
// check entirely. Disconnect is intentionally NOT plan-checked so a
// downgraded customer can always clean up their existing install.
// ---------------------------------------------------------------------------

describe("plan-tier gating", () => {
  describe("GET /:platform/install — denies when plan is below min_plan", () => {
    beforeEach(() => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        // Slack ships at min_plan='starter' in the real catalog.
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });
    });

    it("redirects browser callers to /admin/integrations?error=slack&reason=plan_upgrade_required", async () => {
      const res = await request("/api/v1/integrations/slack/install", {
        headers: { Accept: "text/html" },
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("error=slack");
      expect(location).toContain("reason=plan_upgrade_required");
      expect(location).toContain("required_plan=starter");
    });

    it("returns 403 plan_upgrade_required JSON for non-browser callers", async () => {
      const res = await request("/api/v1/integrations/slack/install", {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
    });
  });

  describe("POST /:platform/install-form — denies when plan is below min_plan", () => {
    beforeEach(() => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: false }];
        }
        return [{ slug: "email", install_model: "form", enabled: true, min_plan: "business" }];
      });
    });

    it("returns 403 plan_upgrade_required with required_plan + current_plan", async () => {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "smtp.example.com" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("business");
      expect(body.current_plan).toBe("trial");
    });
  });

  describe("operator-workspace bypass — admits regardless of plan", () => {
    it("/install admits an operator workspace even when plan_tier=trial and min_plan=business", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: true }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "business" }];
      });

      const res = await request("/api/v1/integrations/slack/install");
      // Happy path — redirects to the upstream Slack OAuth page.
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("slack.com/oauth");
    });

    it("/install-form admits an operator workspace even with a starve-low plan_tier", async () => {
      // Reset validateImpl — earlier suites set it to throw a
      // FormInstallValidationError; here we want the happy path.
      validateImpl = async () => ({
        installRecord: { id: "install-email-op", workspaceId: "ws-1" as never, catalogId: "email" },
        credentialWritten: true,
      });
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: true }];
        }
        return [{ slug: "email", install_model: "form", enabled: true, min_plan: "business" }];
      });

      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "smtp.example.com" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { installed: boolean };
      expect(body.installed).toBe(true);
    });
  });

  // Catalog-drift branch: `plugin_catalog.min_plan` is not a recognized
  // plan tier. Pre-#2715 the gate emitted a 403 with the bogus tier name
  // in the body — confusing because the tier isn't buyable, and the
  // operator only saw it in the 403 log line. Post-#2715 the install /
  // install-form routes surface a 501 `handler_unavailable` with a
  // structured `log.error` so an operator can fix the row. The callback
  // route is intentionally lenient (logs + admits — see route comment)
  // so a single-use OAuth code isn't burned on a mid-OAuth catalog typo.
  describe("catalog_drift — unrecognized min_plan surfaces 501", () => {
    it("GET /:platform/install — returns 501 handler_unavailable for unknown min_plan", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "starter", is_operator_workspace: false }];
        }
        // `"team"` is the migration-0091 drop-survivor — exactly the
        // pre-#2715 footgun the new branch is designed to surface.
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "team" }];
      });

      const res = await request("/api/v1/integrations/slack/install", {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string; message: string; requestId: string };
      expect(body.error).toBe("handler_unavailable");
      expect(body.message).toContain("Internal configuration error");
      expect(body.requestId).toBeTruthy();
    });

    it("POST /:platform/install-form — returns 501 handler_unavailable for unknown min_plan", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "pro", is_operator_workspace: false }];
        }
        return [{ slug: "email", install_model: "form", enabled: true, min_plan: "enterprise" }];
      });

      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "smtp.example.com" }),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string; message: string; requestId: string };
      expect(body.error).toBe("handler_unavailable");
      expect(body.message).toContain("Internal configuration error");
      expect(body.requestId).toBeTruthy();
    });
  });

  describe("GET /:platform/callback — defensive mid-OAuth plan re-check", () => {
    afterEach(() => {
      stubVerifiedState = null;
    });

    it("denies when the workspace plan dropped below min_plan between /install and /callback", async () => {
      // Mid-OAuth downgrade: a workspace clicks Connect on Salesforce
      // (passes plan check at /install), then somewhere between the
      // Salesforce redirect and the callback the plan drops (billing
      // event, admin downgrade, whatever). The defensive re-check
      // at /callback must catch this — otherwise we'd write
      // workspace_plugins + integration_credentials for a workspace
      // the catalog won't admit, leaving the user with a card that
      // can't be reconnected and a credential that won't refresh.
      stubVerifiedState = { workspaceId: "ws-down", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      // JSON caller — structured 403 body
      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "application/json" } },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
    });

    it("redirects browser callers to /admin/integrations?error=<platform>&reason=plan_upgrade_required on mid-OAuth downgrade", async () => {
      stubVerifiedState = { workspaceId: "ws-down", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "text/html" } },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("error=slack");
      expect(location).toContain("reason=plan_upgrade_required");
      expect(location).toContain("required_plan=starter");
    });

    it("falls through to the handler when the entitlement read throws — does not burn the OAuth code", async () => {
      // DB-blip handling: if the mid-OAuth plan re-check fails
      // (transient pg outage between /install and /callback), the
      // upstream OAuth code is single-use — 500ing here means the
      // user retries with an expired code and gets a confusing
      // 502 from the provider. Log + fall through to the handler;
      // the original /install already plan-checked.
      stubVerifiedState = { workspaceId: "ws-blip", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          throw new Error("simulated transient pg outage");
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "text/html" } },
      );
      // Happy-path redirect — install lands despite the plan re-check
      // failing. A 5xx here would be the regression to guard against.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.atlas.example/admin/integrations?installed=slack",
      );
    });
  });

  describe("DELETE /:platform — not plan-checked (downgrade cleanup always works)", () => {
    it("permits a free-tier workspace to disconnect an install that requires business", async () => {
      // Worst case: the workspace downgraded post-install and is now
      // below the catalog gate. Disconnect must still succeed —
      // otherwise the install is stranded with no admin-visible UI to
      // clear its credentials.
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("DELETE FROM workspace_plugins")) {
          callOrder.push("workspace_plugins.delete");
          return [];
        }
        if (sql.includes("FROM plugin_catalog")) {
          return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true, min_plan: "business", pillar: "chat", config_schema: null }];
        }
        if (sql.includes("FROM workspace_plugins")) {
          return [{ id: "install-1", install_id: "install-1", team_id: "T-downgraded" }];
        }
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [];
      });

      const res = await request("/api/v1/integrations/slack", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/integrations/:platform — disconnect flow.
//
// Two-store teardown per ADR-0003: `chat_cache:<platform>:installation:<teamId>`
// is dropped BEFORE the `workspace_plugins` row, so credentials never
// outlive the install record. The ordering is load-bearing — if the
// install row went first and the chat_cache delete then failed, the
// bot token would still be sitting in the credential store with no
// admin-visible UI to reach it.
//
// Helpers below stage the workspace_plugins SELECT (config → teamId)
// and route the DELETE through `mockInternalQuery`'s SQL discrimination
// so the test can spool a single `callOrder` array across both stores.
// ---------------------------------------------------------------------------

function stageSlackInstallLookup(teamId: string | null) {
  mockInternalQuery.mockImplementation(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
    // Order matters: the DELETE statement also contains the substring
    // "FROM workspace_plugins", so DELETE must be matched before SELECT
    // or every DELETE would be mis-classified as a SELECT.
    if (sql.includes("DELETE FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.delete");
      return [];
    }
    if (sql.includes("FROM plugin_catalog")) {
      // Both the install-side helper (`getInstallableCatalogRowBySlug` —
      // gated on `enabled = true`) and the disconnect-side helper
      // (`getCatalogRowBySlugForDisconnect` — no gate) hit this branch.
      // Return a row with both shapes' fields populated so a single mock
      // serves both.
      return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true, pillar: "chat", config_schema: null }];
    }
    if (sql.includes("FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.select");
      // #2742 — WorkspaceInstaller.uninstall SELECTs `id, install_id, team_id`
      // for the row lookup; older route SELECTed `team_id` only.
      return teamId === null ? [] : [{ id: "install-1", install_id: "install-1", team_id: teamId }];
    }
    return [];
  });
}

describe("DELETE /api/v1/integrations/slack — dual-store teardown", () => {
  it("deletes chat_cache BEFORE workspace_plugins (ADR-0003 ordering)", async () => {
    stageSlackInstallLookup("T-abc-123");

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Two-store teardown: chat_cache MUST happen before workspace_plugins.
    // The SELECTs can interleave with the catalog lookup, so filter the
    // spool down to just the teardown writes and assert the exact
    // sequence. A future refactor that swapped the two would fail this
    // even if both calls still succeeded — that's the ADR-0003
    // load-bearing invariant the comment in `integrations.ts` claims.
    const teardownSequence = callOrder.filter(
      (c) => c === "chat_cache.delete" || c === "workspace_plugins.delete",
    );
    expect(teardownSequence).toEqual([
      "chat_cache.delete",
      "workspace_plugins.delete",
    ]);
    expect(mockDeleteInstallation).toHaveBeenCalledWith("T-abc-123");
  });

  it("aborts (no workspace_plugins delete) when chat_cache delete fails — credentials must not outlive install record", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockDeleteInstallation.mockImplementation(async () => {
      callOrder.push("chat_cache.delete");
      throw new Error("chat_cache table unavailable");
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(callOrder).toContain("chat_cache.delete");
    expect(callOrder).not.toContain("workspace_plugins.delete");
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });

  it("returns 404 when no install row exists for the workspace", async () => {
    stageSlackInstallLookup(null);

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 404 when the platform slug is not in the catalog", async () => {
    // Catalog SELECT returns no rows for the unknown slug. The
    // disconnect-side helper doesn't filter on `enabled`, so this
    // branch only fires for truly absent slugs — not for kill-switched
    // real Platforms.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("FROM plugin_catalog")) return [];
      return [];
    });

    const res = await request("/api/v1/integrations/unknown", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "Authentication required",
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(401);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 403 when the caller is authenticated but not an admin", async () => {
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        role: "member",
        activeOrganizationId: "ws-1",
        claims: { twoFactorEnabled: true },
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 501 for a real catalog platform whose disconnect path isn't wired", async () => {
    // Future-Platform safety net: catalog returns a `teams` row (a real
    // Platform), but the WorkspaceInstaller credential dispatch only
    // covers `slack` + INTEGRATION_CREDENTIALS_SLUGS today. The 501
    // must short-circuit before either store is touched.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("FROM plugin_catalog")) {
        return [{ id: "catalog:teams", slug: "teams", install_model: "oauth", enabled: true, pillar: "chat", config_schema: null }];
      }
      return [];
    });

    const res = await request("/api/v1/integrations/teams", { method: "DELETE" });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("disconnect_unavailable");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 400 missing_org_binding when managed-auth user has no active org", async () => {
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        // no activeOrganizationId
        claims: { twoFactorEnabled: true },
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 400 missing_org_binding when SaaS deploy lands a mode=none request (misconfig)", async () => {
    // SaaS pins managed auth in config, so a mode=none branch reaching
    // this endpoint means auth middleware regressed. Fail closed.
    stageSlackInstallLookup("T-abc-123");
    deployModeImpl = () => "saas";
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      user: undefined,
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 403 mfa_enrollment_required when a managed admin lacks an enrolled second factor", async () => {
    // Codex P1 — DELETE is destructive; bypass the MFA gate and an admin
    // who only knows a password could disconnect a tenant install. Keep
    // parity with the `mfaRequired` middleware applied to every other
    // admin write surface.
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        activeOrganizationId: "ws-1",
        // No twoFactorEnabled / passkeyCount → not enrolled.
        claims: {},
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mfa_enrollment_required");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 421 misdirected_request when strict routing detects a cross-region miss", async () => {
    // Codex P2 — `adminAuth`'s misrouting check is what every other
    // admin write inherits via `createAdminRouter`. This handler isn't
    // mounted under that router so the check is inlined.
    stageSlackInstallLookup("T-abc-123");
    mockMisrouted = {
      expectedRegion: "eu",
      actualRegion: "us",
      correctApiUrl: "https://api.eu.useatlas.dev",
    };
    mockStrictRouting = true;

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(421);
    const body = (await res.json()) as { error: string; expectedRegion: string };
    expect(body.error).toBe("misdirected_request");
    expect(body.expectedRegion).toBe("eu");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("proceeds when misrouting is detected but strict routing is disabled (graceful mode)", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockMisrouted = {
      expectedRegion: "eu",
      actualRegion: "us",
      correctApiUrl: undefined,
    };
    mockStrictRouting = false;

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
  });

  it("succeeds even when the catalog row is kill-switched (enabled=false)", async () => {
    // Codex P2 — ops disables a Platform via plugin_catalog.enabled=false
    // as a kill switch. Existing installs MUST still be tearable down,
    // otherwise the disable strands credentials in chat_cache.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("DELETE FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.delete");
        return [];
      }
      if (sql.includes("FROM plugin_catalog")) {
        // enabled: false — the kill-switched state. WorkspaceInstaller's
        // disconnect-side loader SELECTs `install_model, pillar,
        // config_schema` as well as `id, slug, enabled` so the row needs
        // every column (or the loader returns null → 404). Min-plan stays
        // off because disconnect doesn't plan-gate.
        return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: false, pillar: "chat", config_schema: null }];
      }
      if (sql.includes("FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.select");
        return [{ id: "install-1", install_id: "install-1", team_id: "T-kill-switched" }];
      }
      return [];
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(mockDeleteInstallation).toHaveBeenCalledWith("T-kill-switched");
    expect(callOrder).toContain("workspace_plugins.delete");
  });

  it("self-hosted mode=none falls back to the 'self-hosted' sentinel workspaceId for the install lookup", async () => {
    // Single-tenant self-hosted dev: no real auth identity, but the
    // install was written under the same sentinel by the install
    // handler, so the SELECT must use it.
    const capturedParams: unknown[][] = [];
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]): Promise<unknown[]> => {
      if (params) capturedParams.push(params);
      if (sql.includes("DELETE FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.delete");
        return [];
      }
      if (sql.includes("FROM plugin_catalog")) {
        return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true, pillar: "chat", config_schema: null }];
      }
      if (sql.includes("FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.select");
        return [{ id: "install-1", install_id: "install-1", team_id: "T-self-hosted" }];
      }
      return [];
    });
    // mode=none bypasses the MFA gate (managed-only) and the SaaS
    // misconfig branch (deploy mode stays undefined → not "saas").
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      user: undefined,
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Find the SELECT that resolved the install row and verify it was
    // keyed on the sentinel workspaceId.
    const selectParams = capturedParams.find(
      (p) => Array.isArray(p) && p[0] === "self-hosted" && p[1] === "catalog:slack",
    );
    expect(selectParams).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/integrations/salesforce — dual-store teardown for the
// first lazy OAuth integration (#2658).
//
// Same ADR-0003 ordering as Slack but the credential store is
// `integration_credentials` keyed by (workspace_id, catalog_id) rather
// than `chat_cache` keyed by team_id.
// ---------------------------------------------------------------------------

function stageSalesforceInstallLookup(present: boolean) {
  mockInternalQuery.mockImplementation(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
    if (sql.includes("DELETE FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.delete");
      return [];
    }
    if (sql.includes("FROM plugin_catalog")) {
      // #2742 — WorkspaceInstaller's catalog loader SELECTs `pillar` +
      // `config_schema` too; supply them so the row passes the
      // `isValidPillar` gate.
      return [{ id: "catalog:salesforce", slug: "salesforce", install_model: "oauth", enabled: true, pillar: "action", config_schema: null }];
    }
    if (sql.includes("FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.select");
      // Salesforce installs don't carry team_id — `team_id` resolves to NULL
      // through the JSONB extraction. The disconnect path tolerates a null
      // teamId for non-Slack platforms.
      return present ? [{ id: "install-sf", install_id: "install-sf", team_id: null }] : [];
    }
    return [];
  });
}

describe("DELETE /api/v1/integrations/salesforce — dual-store teardown", () => {
  it("deletes integration_credentials BEFORE workspace_plugins (ADR-0003 ordering)", async () => {
    stageSalesforceInstallLookup(true);

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(200);
    const teardownSequence = callOrder.filter(
      (c) => c === "integration_credentials.delete" || c === "workspace_plugins.delete",
    );
    expect(teardownSequence).toEqual([
      "integration_credentials.delete",
      "workspace_plugins.delete",
    ]);
    expect(mockDeleteCredentialBundle).toHaveBeenCalledWith("ws-1", "catalog:salesforce");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("aborts (no workspace_plugins delete) when integration_credentials delete fails", async () => {
    stageSalesforceInstallLookup(true);
    mockDeleteCredentialBundle.mockImplementationOnce(async () => {
      callOrder.push("integration_credentials.delete");
      throw new Error("integration_credentials write conflict");
    });

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(callOrder).toContain("integration_credentials.delete");
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 404 when no Salesforce install row exists for the workspace", async () => {
    stageSalesforceInstallLookup(false);

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mockDeleteCredentialBundle).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });
});

// ---------------------------------------------------------------------------
// POST /:platform/install-form — static-bot routing-identifier install
// spine (#3140). The route accepts `install_model: "static-bot"`, resolves
// the routing-identifier field from the catalog `config_schema` (first
// required string field), forwards its value to `confirmInstall` (which runs
// the cap gate), and maps the handler's tagged failures to HTTP.
// ---------------------------------------------------------------------------

describe("POST /:platform/install-form — static-bot install (#3140)", () => {
  // An earlier suite (`dispatch failures`) wipes all handler registries and
  // restores only slack + email, so re-register the static-bot fixtures here
  // to stay order-independent.
  beforeEach(() => {
    registerStaticBotHandler("telegram", fakeStaticBotHandler);
    registerStaticBotHandler("discord", fakeOAuthShapedStaticBotHandler);
    registerStaticBotHandler("teams", fakeAppIdFormStaticBotHandler);
  });

  function stageTelegramCatalog(planTier = "business", implementationStatus = "available") {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization")) {
        return [{ plan_tier: planTier, is_operator_workspace: false }];
      }
      return [
        {
          slug: "telegram",
          install_model: "static-bot",
          enabled: true,
          min_plan: "starter",
          config_schema: TELEGRAM_CONFIG_SCHEMA,
          implementation_status: implementationStatus,
        },
      ];
    });
  }

  describe("happy path", () => {
    beforeEach(() => stageTelegramCatalog());

    it("resolves the routing identifier from config_schema, forwards extras, and returns the install id", async () => {
      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "-1001234567890", display_name: "Data Team" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { installed: boolean; platform: string; installId: string };
      expect(body).toEqual({ installed: true, platform: "telegram", installId: "install-telegram-1" });

      // The route resolved `chat_id` (first required string field) as the
      // routing identifier and forwarded the rest as extras.
      expect(confirmArgs?.routingIdentifier).toBe("-1001234567890");
      expect(confirmArgs?.workspaceId).toBe("ws-1");
      expect(confirmArgs?.extras).toEqual({ display_name: "Data Team" });
      // No caller-supplied verification proof at this surface.
      expect(confirmArgs?.verificationProof).toBeUndefined();
    });

    it("trims copy-paste whitespace off the routing identifier before forwarding", async () => {
      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "  -1001234567890  " }),
      });

      expect(res.status).toBe(200);
      // The handler's anchored format regex would reject a padded id; the route
      // trims so a pasted value installs cleanly.
      expect(confirmArgs?.routingIdentifier).toBe("-1001234567890");
    });

    it("resolves the routing key even when it is not the first config_schema field", async () => {
      // The contract is "first REQUIRED STRING field", not "first field". A
      // leading optional label + a leading required-non-string field must both
      // be skipped so the route forwards the right value (guards against a
      // refactor that silently picks the wrong key).
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "business", is_operator_workspace: false }];
        }
        return [
          {
            slug: "telegram",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            implementation_status: "available",
            config_schema: [
              { key: "label", type: "string", required: false },
              { key: "priority", type: "number", required: true },
              { key: "chat_id", type: "string", required: true },
            ],
          },
        ];
      });

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Ops", priority: 5, chat_id: "-1009998887776" }),
      });

      expect(res.status).toBe(200);
      expect(confirmArgs?.routingIdentifier).toBe("-1009998887776");
      // The non-routing fields ride through as extras (the right key was deleted).
      expect(confirmArgs?.extras).toEqual({ label: "Ops", priority: 5 });
    });
  });

  describe("dormancy gate — coming_soon refused", () => {
    it("returns 409 platform_not_available for a coming_soon static-bot — confirmInstall not called", async () => {
      stageTelegramCatalog("business", "coming_soon");

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "-1001234567890" }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("platform_not_available");
      expect(confirmArgs).toBeNull();
    });
  });

  describe("form-shaped static-bot that exposes applicationId (Teams/WhatsApp)", () => {
    it("is accepted — the OAuth-shaped refusal keys on oauthShaped, not applicationId", async () => {
      // Regression guard (#3140 review): Teams/WhatsApp populate `applicationId`
      // for their manifest/parity URLs but are form-shaped (`oauthShaped` unset).
      // Keying the refusal on `applicationId` would wrongly 400 them.
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "business", is_operator_workspace: false }];
        }
        return [
          {
            slug: "teams",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            implementation_status: "available",
            config_schema: [{ key: "tenant_id", type: "string", required: true }],
          },
        ];
      });

      const res = await request("/api/v1/integrations/teams/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "00000000-0000-0000-0000-000000000000" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { installed: boolean; platform: string };
      expect(body.installed).toBe(true);
      expect(appIdConfirmCalled).toBe(true);
    });
  });

  describe("cap gate — over-cap blocked / billing-check failed", () => {
    beforeEach(() => stageTelegramCatalog());

    it("returns 429 plan_limit_exceeded (with limit) when confirmInstall hits the chat-integration cap", async () => {
      // `confirmInstall` runs `checkChatIntegrationLimitAndInstall`; an
      // over-cap workspace surfaces ChatIntegrationLimitError, which the
      // route maps to 429 via runHandler's classifyError.
      confirmInstallImpl = async () => {
        throw new ChatIntegrationLimitError({
          message: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
          workspaceId: "ws-1",
          limit: 1,
        });
      };

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "-1001234567890" }),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string; limit: number; requestId: string };
      expect(body.error).toBe("plan_limit_exceeded");
      expect(body.limit).toBe(1);
      expect(body.requestId).toBeTruthy();
    });

    it("returns 503 billing_check_failed when the cap count check fails closed", async () => {
      confirmInstallImpl = async () => {
        throw new BillingCheckFailedError({
          message: "Unable to verify plan limits. Please try again.",
          workspaceId: "ws-1",
        });
      };

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "-1001234567890" }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("billing_check_failed");
    });
  });

  describe("routing-identifier validation", () => {
    beforeEach(() => stageTelegramCatalog());

    it("returns 400 bad_request when the handler rejects the routing id format", async () => {
      confirmInstallImpl = async () => {
        throw new TelegramChatIdInvalidError({
          message: 'Telegram chat_id "@channel" is not a valid integer id.',
        });
      };

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "@channel" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("not a valid integer id");
    });

    it("returns 400 missing_routing_identifier when the routing field is absent — confirmInstall is not called", async () => {
      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: "no chat id here" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("missing_routing_identifier");
      expect(body.message).toContain("chat_id");
      // The route short-circuited before dispatching to the handler.
      expect(confirmArgs).toBeNull();
    });

    it("returns 400 missing_routing_identifier when the routing field is blank", async () => {
      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "   " }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("missing_routing_identifier");
      expect(confirmArgs).toBeNull();
    });
  });

  describe("OAuth-shaped static-bot rejection (Discord)", () => {
    beforeEach(() => {
      // Discord is a static-bot with a populated `applicationId` — its
      // routing id rides on an OAuth bot-install redirect, so the form
      // route refuses it.
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "business", is_operator_workspace: false }];
        }
        return [
          {
            slug: "discord",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            implementation_status: "available",
            config_schema: [{ key: "guild_id", type: "string", required: true }],
          },
        ];
      });
    });

    it("returns 400 oauth_shaped_static_bot and never calls confirmInstall", async () => {
      const res = await request("/api/v1/integrations/discord/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guild_id: "123456789012345678" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("oauth_shaped_static_bot");
      expect(oauthShapedConfirmCalled).toBe(false);
    });
  });

  describe("catalog misconfiguration", () => {
    it("returns 501 when the static-bot catalog row declares no required routing field", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "business", is_operator_workspace: false }];
        }
        // config_schema with only optional fields — no routing identifier.
        return [
          {
            slug: "telegram",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            config_schema: [{ key: "display_name", type: "string", required: false }],
          },
        ];
      });

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: "x" }),
      });

      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
      expect(confirmArgs).toBeNull();
    });
  });

  describe("plan-tier gate", () => {
    it("returns 403 plan_upgrade_required when the workspace plan ranks below min_plan", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [
          {
            slug: "telegram",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            config_schema: TELEGRAM_CONFIG_SCHEMA,
          },
        ];
      });

      const res = await request("/api/v1/integrations/telegram/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "-1001234567890" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; required_plan: string; current_plan: string };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
      // Denied before dispatch.
      expect(confirmArgs).toBeNull();
    });
  });

  describe("handler not registered", () => {
    it("returns 501 handler_unavailable when no static-bot handler is registered for the slug", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "business", is_operator_workspace: false }];
        }
        return [
          {
            slug: "whatsapp",
            install_model: "static-bot",
            enabled: true,
            min_plan: "starter",
            config_schema: [{ key: "phone_number_id", type: "string", required: true }],
          },
        ];
      });

      const res = await request("/api/v1/integrations/whatsapp/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone_number_id: "123456" }),
      });

      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
    });
  });
});
