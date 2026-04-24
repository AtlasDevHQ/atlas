/**
 * Audit regression suite for `admin-integrations.ts` —
 *   - F-29 residuals (#1828): orphan `POST /email/test` → `integration.test`
 *   - F-46 (#1819): BYOT / connect handlers gain `hasSecret: true`
 *
 * Covers the 8 BYOT / OAuth-connect paths listed in the F-46 issue body
 * (Slack/Teams/Discord BYOT + Telegram/GChat/GitHub/Linear/WhatsApp connect)
 * by pinning the `hasSecret: true` marker on the audit metadata. Each
 * handler's response path is mocked at the store layer so the test never
 * talks to the real installation store.
 *
 * Pattern: mock the upstream API validator for each platform so the handler
 * succeeds and reaches the audit emission; the test asserts the emitted
 * row shape (actionType, targetType, metadata keys + values), NOT a full
 * snapshot — adding a future metadata key must not break the suite.
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
// Mocks — declared before the app import
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

// Mock the installation stores used by each BYOT / connect path. Defaults
// resolve to success — per-test overrides can drive failure branches.
const mockSaveSlackInstallation = mock(async () => {});
const mockSaveTeamsInstallation = mock(async () => {});
const mockSaveDiscordInstallation = mock(async () => {});
const mockSaveTelegramInstallation = mock(async () => {});
const mockSaveGChatInstallation = mock(async () => {});
const mockSaveGitHubInstallation = mock(async () => {});
const mockSaveLinearInstallation = mock(async () => {});
const mockSaveWhatsAppInstallation = mock(async () => {});
// `mock(async () => ({...}))` infers a non-nullable return type from the
// default fixture, which blocks per-test `mockImplementationOnce(() => null)`
// for the "no install" branch. Hand-annotate to the nullable union so
// narrowing tests compile.
type EmailInstallShape = {
  provider: "resend" | "sendgrid" | "postmark" | "smtp" | "ses";
  sender_address: string;
  config: { provider: string; [k: string]: unknown };
};
const mockGetEmailInstallationByOrg: Mock<() => Promise<EmailInstallShape | null>> = mock(async () => ({
  provider: "resend",
  sender_address: "from@test.com",
  config: { provider: "resend", apiKey: "re_test" },
}));

mock.module("@atlas/api/lib/slack/store", () => ({
  saveInstallation: mockSaveSlackInstallation,
  deleteInstallationByOrg: mock(async () => true),
  getInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/teams/store", () => ({
  saveTeamsInstallation: mockSaveTeamsInstallation,
  deleteTeamsInstallationByOrg: mock(async () => true),
  getTeamsInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/discord/store", () => ({
  saveDiscordInstallation: mockSaveDiscordInstallation,
  deleteDiscordInstallationByOrg: mock(async () => true),
  getDiscordInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/telegram/store", () => ({
  saveTelegramInstallation: mockSaveTelegramInstallation,
  deleteTelegramInstallationByOrg: mock(async () => true),
  getTelegramInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/gchat/store", () => ({
  saveGChatInstallation: mockSaveGChatInstallation,
  deleteGChatInstallationByOrg: mock(async () => true),
  getGChatInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/github/store", () => ({
  saveGitHubInstallation: mockSaveGitHubInstallation,
  deleteGitHubInstallationByOrg: mock(async () => true),
  getGitHubInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/linear/store", () => ({
  saveLinearInstallation: mockSaveLinearInstallation,
  deleteLinearInstallationByOrg: mock(async () => true),
  getLinearInstallationByOrg: mock(async () => null),
}));
mock.module("@atlas/api/lib/whatsapp/store", () => ({
  saveWhatsAppInstallation: mockSaveWhatsAppInstallation,
  deleteWhatsAppInstallationByOrg: mock(async () => true),
  getWhatsAppInstallationByOrg: mock(async () => null),
}));
// Note: `admin-integrations.ts` imports `EMAIL_PROVIDERS` + the
// `EmailProvider` / `ProviderConfig` types from this module. The Zod
// `EmailProviderEnum` schema is built from `EMAIL_PROVIDERS` at module
// load time — leaving it out here makes the whole router fail to register
// (try/catch in `api/index.ts` swallows it and every integrations route
// 404s). Mirror the real export shape precisely.
mock.module("@atlas/api/lib/email/store", () => ({
  EMAIL_PROVIDERS: ["resend", "sendgrid", "postmark", "smtp", "ses"] as const,
  saveEmailInstallation: mock(async () => {}),
  deleteEmailInstallationByOrg: mock(async () => true),
  getEmailInstallationByOrg: mockGetEmailInstallationByOrg,
}));

// `fetch` is used by every platform's upstream validation call. Mock it
// so the handler-side API validation resolves to an "ok" shape for each
// platform. `typeof fetch` includes a `preconnect` property that the mock
// doesn't provide — narrow the mock type to the callable signature only
// (which is all the platform handlers use) and cast once at install time.
type FetchSignature = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;
const mockFetch: Mock<FetchSignature> = mock(() =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

const { app } = await import("../index");

afterAll(() => {
  globalThis.fetch = originalFetch;
  mocks.cleanup();
});

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

/**
 * Set a fixed fetch response for the duration of one test. Uses
 * `mockImplementation` (not `mockImplementationOnce`) so any stray
 * fetch from the app init or auth layer never eats our expected response.
 * Each test that depends on a specific upstream shape should call this
 * first — tests that don't care leave the beforeEach default in place.
 */
function setFetchJson(body: unknown, status = 200): void {
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockFetch.mockClear();
  // Default: generic `ok: true` 200. Individual tests override via
  // setFetchJson() when the platform's validator needs a specific shape.
  mockFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  mockSaveSlackInstallation.mockClear();
  mockSaveTeamsInstallation.mockClear();
  mockSaveDiscordInstallation.mockClear();
  mockSaveTelegramInstallation.mockClear();
  mockSaveGChatInstallation.mockClear();
  mockSaveGitHubInstallation.mockClear();
  mockSaveLinearInstallation.mockClear();
  mockSaveWhatsAppInstallation.mockClear();
});

// ---------------------------------------------------------------------------
// F-46 — hasSecret: true on BYOT / connect metadata
// ---------------------------------------------------------------------------

describe("admin-integrations BYOT / connect — F-46 hasSecret marker", () => {
  it("POST /slack/byot emits integration.enable with hasSecret: true", async () => {
    setFetchJson({ ok: true, team_id: "T-test", team: "Test WS" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.targetType).toBe("integration");
    expect(entry.metadata).toMatchObject({
      platform: "slack",
      mode: "byot",
      hasSecret: true,
    });
  });

  it("POST /teams/byot emits integration.enable with hasSecret: true", async () => {
    // Teams uses Microsoft OAuth — returns an access_token on success
    setFetchJson({
      access_token: "teams-test-token",
      expires_in: 3600,
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/teams/byot", {
        appId: "00000000-0000-0000-0000-000000000001",
        appPassword: "test-app-password",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "teams",
      mode: "byot",
      hasSecret: true,
    });
  });

  it("POST /discord/byot emits integration.enable with hasSecret: true", async () => {
    setFetchJson({ id: "bot-id", username: "TestBot" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-123",
        publicKey: "pubkey-abc",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "discord",
      mode: "byot",
      hasSecret: true,
    });
  });

  it("POST /telegram emits integration.enable with hasSecret: true", async () => {
    setFetchJson({
      ok: true,
      result: { id: 123, username: "test_bot", first_name: "Test" },
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/telegram", {
        botToken: "telegram-bot-token",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "telegram",
      hasSecret: true,
    });
  });

  it("POST /gchat emits integration.enable with hasSecret: true", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/gchat", {
        credentialsJson: JSON.stringify({
          client_email: "sa@proj.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
          project_id: "gcp-proj",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "gchat",
      hasSecret: true,
    });
  });

  it("POST /github emits integration.enable with hasSecret: true", async () => {
    setFetchJson({ id: 42, login: "testuser" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/github", {
        accessToken: "ghp_test_token",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "github",
      hasSecret: true,
    });
  });

  it("POST /linear emits integration.enable with hasSecret: true", async () => {
    setFetchJson({
      data: {
        viewer: {
          id: "u-123",
          name: "Test User",
          email: "u@test.com",
        },
      },
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "linear",
      hasSecret: true,
    });
  });

  it("POST /whatsapp emits integration.enable with hasSecret: true", async () => {
    setFetchJson({ id: "phone-id", display_phone_number: "+1-555-test" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/whatsapp", {
        phoneNumberId: "1234567890",
        accessToken: "wa-access-token",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.metadata).toMatchObject({
      platform: "whatsapp",
      hasSecret: true,
    });
  });
});

// ---------------------------------------------------------------------------
// F-29 residuals — POST /email/test orphan
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/integrations/email/test — audit emission (F-29 residuals)", () => {
  it("emits integration.test with success status when delivery succeeds", async () => {
    // Resend success response
    setFetchJson({ id: "rsnd_test_123" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/email/test", {
        recipientEmail: "dest@test.com",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.test");
    expect(entry.targetType).toBe("integration");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      platform: "email",
      provider: "resend",
      success: true,
    });
    // The test endpoint does NOT carry `hasSecret: true` — the request
    // body only ships `recipientEmail`; the credential exercised is the
    // previously-saved one. Pinned so a future over-eager change can't
    // flip this to match the F-46 install-path pattern by mistake.
    expect(entry.metadata).not.toHaveProperty("hasSecret");
  });

  it("emits integration.test with failure status on upstream 4xx", async () => {
    // Resend returns 401 for bad API key
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/email/test", {
        recipientEmail: "dest@test.com",
      }),
    );

    // The route returns 200 with success:false in body — the audit row
    // status is "failure" regardless, so compliance queries filtering
    // on status catch every delivery failure.
    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.test");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      platform: "email",
      provider: "resend",
      success: false,
    });
    expect(typeof entry.metadata?.error).toBe("string");
  });

  it("does not emit when no email configuration is saved (400)", async () => {
    mockGetEmailInstallationByOrg.mockImplementationOnce(async () => null);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/email/test", {
        recipientEmail: "dest@test.com",
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when internal DB is unavailable (404)", async () => {
    // The `requireOrgContext` middleware short-circuits with 404 when
    // `hasInternalDB()` is false — we never reach the handler. Pinned so
    // a future change that moves the DB check into the handler body (and
    // swaps the status to 400) is an explicit decision, not a regression.
    mocks.hasInternalDB = false;

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/email/test", {
        recipientEmail: "dest@test.com",
      }),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
