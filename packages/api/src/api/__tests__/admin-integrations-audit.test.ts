// Assert audit-row shape (action, target, metadata keys), not full
// snapshots — future metadata keys must not break this suite.

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
// Nullable union — per-test `mockImplementationOnce(() => null)` needs the
// nullable on the signature, which `mock(async () => ({...}))` doesn't infer.
type EmailInstallShape = import("@atlas/api/lib/email/store").EmailInstallationWithSecret | null;
const mockGetEmailInstallationByOrg: Mock<() => Promise<EmailInstallShape>> = mock(async () => ({
  org_id: "org-alpha",
  installed_at: new Date().toISOString(),
  config_id: "cfg-test",
  provider: "resend" as const,
  sender_address: "from@test.com",
  config: { provider: "resend" as const, apiKey: "re_test" },
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
// EMAIL_PROVIDERS feeds the Zod enum at module load — omitting it makes
// the router fail to register and every integrations route 404s.
mock.module("@atlas/api/lib/email/store", () => ({
  EMAIL_PROVIDERS: ["resend", "sendgrid", "postmark", "smtp", "ses"] as const,
  saveEmailInstallation: mock(async () => {}),
  deleteEmailInstallationByOrg: mock(async () => true),
  getEmailInstallationByOrg: mockGetEmailInstallationByOrg,
}));

// Narrow `typeof fetch` to the callable signature — the `preconnect`
// property isn't used by any handler.
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

  it("does not emit on invalid upstream credential (400) — represented by Slack", async () => {
    // Auth.test returns ok:false for bad tokens; handler returns 400 with
    // no audit emission (no credential was stored). One representative
    // platform covers the policy across all 8.
    setFetchJson({ ok: false, error: "invalid_auth" });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-bad-token",
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("emits failure-status integration.enable with hasSecret when save throws — represented by Slack", async () => {
    setFetchJson({ ok: true, team_id: "T-test", team: "Test WS" });
    mockSaveSlackInstallation.mockImplementationOnce(() =>
      Promise.reject(new Error("db write failed")),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      }),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.enable");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      platform: "slack",
      mode: "byot",
      hasSecret: true,
    });
    expect(typeof entry.metadata?.error).toBe("string");
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
    // Body ships only `recipientEmail`; no new credential in the request,
    // so no hasSecret marker.
    expect(entry.metadata).not.toHaveProperty("hasSecret");
  });

  it("emits integration.test with failure status on upstream 4xx", async () => {
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

    // Route returns 200 with success:false; audit row is status:"failure".
    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.test");
    expect(entry.targetType).toBe("integration");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      platform: "email",
      provider: "resend",
      success: false,
    });
    expect(typeof entry.metadata?.error).toBe("string");
  });

  it("emits integration.test with failure status on provider-returned success:false", async () => {
    // SMTP path returns `{ success: false, error }` without throwing when
    // ATLAS_SMTP_URL is unset — distinct from the fetch-4xx throw path.
    mockGetEmailInstallationByOrg.mockImplementationOnce(async () => ({
      org_id: "org-alpha",
      installed_at: new Date().toISOString(),
      config_id: "cfg-smtp",
      provider: "smtp" as const,
      sender_address: "from@test.com",
      config: {
        provider: "smtp" as const,
        host: "smtp.example.com",
        port: 587,
        username: "u",
        password: "p",
        tls: true,
      },
    }));
    const prevSmtpUrl = process.env.ATLAS_SMTP_URL;
    delete process.env.ATLAS_SMTP_URL;

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/integrations/email/test", {
        recipientEmail: "dest@test.com",
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("integration.test");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      platform: "email",
      provider: "smtp",
      success: false,
    });
    expect(typeof entry.metadata?.error).toBe("string");

    if (prevSmtpUrl !== undefined) process.env.ATLAS_SMTP_URL = prevSmtpUrl;
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
    // `requireOrgContext` middleware short-circuits before the handler.
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
