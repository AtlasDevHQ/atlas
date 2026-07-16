/**
 * Tests for the Email LazyPluginLoader builder + `sendEmail` agent tool.
 *
 * Coverage:
 *   - Builder happy path: decrypts `password` via the shared secret
 *     schema, hands every SMTP field through to `createTransport`,
 *     surfaces `sendEmail()` that round-trips through the transport.
 *   - Builder decrypt failure: `decryptSecretFields` throw → builder
 *     wraps it in `EmailDecryptFailureError` (so the tool surface can
 *     attach a `requestId` to the agent-visible payload).
 *   - Builder malformed config: missing `host` short-circuits with a
 *     clear "disconnect + reinstall" error before reaching the
 *     transport factory.
 *   - Tool no-install path: `LazyPluginInstallNotFoundError` → status
 *     `no_install` with `/admin/integrations` copy. No agent-visible
 *     stack trace.
 *   - Tool decrypt-failure path: `EmailDecryptFailureError` → status
 *     `decrypt_failure` with `requestId` echoed back.
 *   - Tool misconfigured path: `LazyPluginBuilderMissingError` → status
 *     `misconfigured` with `requestId`, distinct from `send_failure` so
 *     the agent doesn't retry a deploy-side bug.
 *   - Tool install-present path: dispatches into the cached instance's
 *     `sendEmail`. Verifies the loader is hit exactly once (transport
 *     caching is the loader's responsibility, but the tool must not
 *     bypass it).
 *   - Tool send-failure path: the transport throws → status
 *     `send_failure` with `requestId` echoed back; underlying error
 *     scrubbed via `errorMessage()`.
 *
 * The unit test injects fakes via the `SendEmailToolDeps` constructor
 * (no `mock.module()`); the integration test in `email-tool.integration.test.ts`
 * mirrors the full `db/internal` named-export surface for the mock-all-exports
 * rule.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

import {
  createEmailLazyBuilder,
  createSendEmailTool,
  EmailDecryptFailureError,
  type EmailPluginInstance,
} from "../email-tool";
import {
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
} from "@atlas/api/lib/plugins/lazy-loader";
import { EMAIL_CATALOG_ID } from "../install/email-secret-schema";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WSID = "ws-email-test";
const CATALOG_ID = EMAIL_CATALOG_ID;

const HAPPY_DECRYPTED_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "atlas@example.com",
  password: "smtp-password",
  fromAddress: "Atlas <atlas@example.com>",
  secure: true,
};

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

// ---------------------------------------------------------------------------
// Builder — happy path
// ---------------------------------------------------------------------------

describe("createEmailLazyBuilder — happy path", () => {
  it("decrypts the password, constructs a transport with every SMTP field, and sendEmail routes through transport.sendMail", async () => {
    const mockSendMail = mock(() =>
      Promise.resolve({
        messageId: "<test-message-id@example.com>",
        envelope: { from: HAPPY_DECRYPTED_CONFIG.fromAddress, to: ["dest@example.com"] },
      }),
    );
    const mockClose = mock(() => undefined);
    let lastTransportOptions: unknown = null;
    const mockCreateTransport: Mock<(opts: unknown) => unknown> = mock((opts: unknown) => {
      lastTransportOptions = opts;
      return { sendMail: mockSendMail, close: mockClose };
    });

    const build = createEmailLazyBuilder({
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      createTransport: mockCreateTransport as any,
    });

    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      // Plaintext config — `decryptSecretFields` passes through
      // un-ciphertext values (the F-42 backfill tolerance path), so the
      // builder's decrypt step is a no-op on a plain dev row. The
      // ciphertext path is exercised separately under "decrypt failure".
      config: HAPPY_DECRYPTED_CONFIG,
    })) as EmailPluginInstance;

    expect(instance.id).toBe(`email:${WSID}`);
    expect(lastTransportOptions).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: true,
      auth: { user: "atlas@example.com", pass: "smtp-password" },
    });

    const result = await instance.sendEmail({
      to: ["dest@example.com"],
      subject: "Hello",
      body: "<p>Body</p>",
    });
    expect(result.messageId).toBe("<test-message-id@example.com>");
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const firstCall = mockSendMail.mock.calls[0] as readonly unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({
      from: "Atlas <atlas@example.com>",
      to: ["dest@example.com"],
      subject: "Hello",
      html: "<p>Body</p>",
    });

    // teardown closes the transport so socket pools don't leak across
    // disconnect/reinstall cycles.
    await instance.teardown?.();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("defaults secure=true when the stored config omits the field", async () => {
    let lastTransportOptions: unknown = null;
    const mockCreateTransport: Mock<(opts: unknown) => unknown> = mock((opts: unknown) => {
      lastTransportOptions = opts;
      return { sendMail: mock(() => Promise.resolve({})), close: mock(() => undefined) };
    });

    const build = createEmailLazyBuilder({
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      createTransport: mockCreateTransport as any,
    });

    // Drop `secure` from the config — older installs that pre-date the
    // Zod schema's default value land with `secure` absent. The builder
    // must default to TLS-on, not silently to plaintext SMTP.
    const { secure: _secure, ...rest } = HAPPY_DECRYPTED_CONFIG;
    await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: rest,
    });

    expect((lastTransportOptions as { secure: boolean }).secure).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Builder — malformed / decrypt-failure
// ---------------------------------------------------------------------------

describe("createEmailLazyBuilder — error paths", () => {
  it("throws when the decrypted config is missing a required field", async () => {
    const build = createEmailLazyBuilder({
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      createTransport: mock(() => ({ sendMail: mock(), close: mock() })) as any,
    });

    const { host: _omitted, ...withoutHost } = HAPPY_DECRYPTED_CONFIG;
    await expect(
      build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: withoutHost,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it("wraps a decryptSecretFields throw in EmailDecryptFailureError", async () => {
    // `decryptSecret` throws on ciphertext we can't actually decrypt
    // (e.g. wrong key version after rotation). Pass an `enc:v9:…`
    // string for the `password` field — the live secrets module sees
    // the version prefix, attempts decrypt with the current keyset,
    // and throws. The builder must wrap that throw so the tool layer
    // can attach a `requestId` to the agent-visible payload.
    const build = createEmailLazyBuilder({
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      createTransport: mock(() => ({ sendMail: mock(), close: mock() })) as any,
    });

    const corruptConfig = {
      ...HAPPY_DECRYPTED_CONFIG,
      password: "enc:v99:AAAA:BBBB:CCCC",
    };

    let caught: unknown = null;
    try {
      await build({
        workspaceId: WSID,
        catalogId: CATALOG_ID,
        config: corruptConfig,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailDecryptFailureError);
    expect((caught as EmailDecryptFailureError).workspaceId).toBe(WSID);
  });
});

// ---------------------------------------------------------------------------
// Builder — staging outbound clamp (#3095)
// ---------------------------------------------------------------------------

describe("createEmailLazyBuilder — staging outbound clamp (#3095)", () => {
  /** Documented default sink when STAGING_MAIL_SINK is unset (clamp.ts). */
  const DEFAULT_SINK = "staging-mail@useatlas.dev";

  // The clamp region is resolved from ATLAS_DEPLOY_ENV / ATLAS_API_REGION at
  // call time (`resolveOutboundClampRegion`, read fresh from `process.env`).
  // Save/restore both around every case so the staging branch is deterministic
  // regardless of the surrounding shell/CI env and can't leak into siblings.
  let savedDeployEnv: string | undefined;
  let savedApiRegion: string | undefined;
  let savedSink: string | undefined;

  beforeEach(() => {
    savedDeployEnv = process.env.ATLAS_DEPLOY_ENV;
    savedApiRegion = process.env.ATLAS_API_REGION;
    savedSink = process.env.STAGING_MAIL_SINK;
    delete process.env.ATLAS_DEPLOY_ENV;
    delete process.env.ATLAS_API_REGION;
    delete process.env.STAGING_MAIL_SINK;
  });

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore("ATLAS_DEPLOY_ENV", savedDeployEnv);
    restore("ATLAS_API_REGION", savedApiRegion);
    restore("STAGING_MAIL_SINK", savedSink);
  });

  async function sendVia(): Promise<unknown> {
    let lastMessage: unknown = null;
    const mockSendMail = mock((message: unknown) => {
      lastMessage = message;
      return Promise.resolve({ messageId: "<id@example.com>", envelope: {} });
    });
    const build = createEmailLazyBuilder({
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      createTransport: mock(() => ({ sendMail: mockSendMail, close: mock() })) as any,
    });
    const instance = (await build({
      workspaceId: WSID,
      catalogId: CATALOG_ID,
      config: HAPPY_DECRYPTED_CONFIG,
    })) as EmailPluginInstance;
    await instance.sendEmail({ to: ["real.customer@example.com"], subject: "Hi", body: "<p>Hi</p>" });
    return lastMessage;
  }

  it("redirects the recipient to the staging sink when ATLAS_DEPLOY_ENV=staging", async () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    const message = (await sendVia()) as { to: unknown };
    // Array `to` shape is preserved → one-element [sink]. The real recipient
    // never reaches the transport on a staging soak box.
    expect(message.to).toEqual([DEFAULT_SINK]);
  });

  it("redirects the recipient when ATLAS_API_REGION=staging (deploy env unset)", async () => {
    process.env.ATLAS_API_REGION = "staging";
    const message = (await sendVia()) as { to: unknown };
    expect(message.to).toEqual([DEFAULT_SINK]);
  });

  it("sends to the real recipient off staging (no clamp)", async () => {
    // Neither staging signal set → resolveOutboundClampRegion() is null → the
    // message rides through untouched, so prod/self-hosted/dev are unaffected.
    const message = (await sendVia()) as { to: unknown };
    expect(message.to).toEqual(["real.customer@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// Tool — execute paths
// ---------------------------------------------------------------------------

describe("createSendEmailTool — execute paths", () => {
  let lastInstanceSendMail: Mock<(args: unknown) => Promise<unknown>>;

  function makeLoader(handler: (workspaceId: string, catalogId: string) => Promise<PluginLike>) {
    return {
      getOrInstantiate: mock(async (workspaceId: string, catalogId: string): Promise<PluginLike> => {
        return handler(workspaceId, catalogId);
      }),
    };
  }

  beforeEach(() => {
    lastInstanceSendMail = mock(() =>
      Promise.resolve({ messageId: "<sent@example.com>", envelope: {} }),
    );
  });

  it("returns status=no_install when the loader throws LazyPluginInstallNotFoundError", async () => {
    const tool = createSendEmailTool({
      loader: makeLoader(async () => {
        throw new LazyPluginInstallNotFoundError(WSID, CATALOG_ID);
      }),
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
      resolveRequestId: () => "req-no-install",
    });

    const result = await runTool<{ status: string; message: string }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("no_install");
    expect(result.message).toMatch(/\/admin\/integrations/);
  });

  it("returns status=decrypt_failure with the requestId when the loader throws EmailDecryptFailureError", async () => {
    const tool = createSendEmailTool({
      loader: makeLoader(async () => {
        throw new EmailDecryptFailureError(WSID, new Error("key version 99 not loaded"));
      }),
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
      resolveRequestId: () => "req-decrypt-99",
    });

    const result = await runTool<{
      status: string;
      message: string;
      requestId: string | undefined;
    }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("decrypt_failure");
    expect(result.requestId).toBe("req-decrypt-99");
    expect(result.message).toContain("req-decrypt-99");
  });

  it("returns status=sent when the loader yields a cached instance and sendMail succeeds", async () => {
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: lastInstanceSendMail as unknown as EmailPluginInstance["sendEmail"],
    };

    const loader = makeLoader(async () => fakeInstance);
    const tool = createSendEmailTool({
      loader,
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
      resolveRequestId: () => "req-sent",
    });

    const result = await runTool<{
      status: string;
      messageId: string | undefined;
    }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("sent");
    expect(result.messageId).toBe("<sent@example.com>");
    expect(lastInstanceSendMail).toHaveBeenCalledTimes(1);
    expect(loader.getOrInstantiate).toHaveBeenCalledTimes(1);
    // Pin the catalog id flowing through the tool to the shared
    // constant — a drift between `EMAIL_CATALOG_ID` and what the tool
    // requests would silently bypass the registered Email builder.
    expect(loader.getOrInstantiate).toHaveBeenCalledWith(WSID, CATALOG_ID);
  });

  it("second send defers to the loader rather than bypassing it (caching is the loader's contract)", async () => {
    // The lazy loader's caching contract is what guarantees the
    // transport survives across sends — pinned in
    // `email-tool.integration.test.ts` via `internalQuery` call-count.
    // This unit test ONLY verifies the tool path doesn't short-circuit
    // around the loader after the first build; the mocked loader here
    // returns the same fake instance on every call, so caching isn't
    // exercised at this layer.
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: lastInstanceSendMail as unknown as EmailPluginInstance["sendEmail"],
    };
    const loader = makeLoader(async () => fakeInstance);
    const tool = createSendEmailTool({
      loader,
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
    });

    await runTool(tool, { to: ["a@example.com"], subject: "1", body: "1" });
    await runTool(tool, { to: ["b@example.com"], subject: "2", body: "2" });

    expect(loader.getOrInstantiate).toHaveBeenCalledTimes(2);
    expect(lastInstanceSendMail).toHaveBeenCalledTimes(2);
  });

  it("returns status=misconfigured with the requestId when the loader has no builder for catalog:email", async () => {
    // Boot-DAG-misconfigured failure mode — `register.ts` pairs the
    // form handler with the builder, so the only way this fires is if
    // `registerBuiltinInstallHandlers` itself didn't run. Distinct
    // from `send_failure` so the agent stops looping and surfaces an
    // operator-actionable error.
    const tool = createSendEmailTool({
      loader: makeLoader(async () => {
        throw new LazyPluginBuilderMissingError(CATALOG_ID);
      }),
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
      resolveRequestId: () => "req-misconfig",
    });

    const result = await runTool<{
      status: string;
      message: string;
      requestId: string | undefined;
    }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("misconfigured");
    expect(result.requestId).toBe("req-misconfig");
    expect(result.message).toContain("req-misconfig");
    expect(result.message).toMatch(/operator/i);
  });

  it("returns status=send_failure with the scrubbed requestId when transport.sendMail throws", async () => {
    const failingSendMail = mock(() => Promise.reject(new Error("SMTP relay 5.7.0 rejected")));
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: failingSendMail as unknown as EmailPluginInstance["sendEmail"],
    };
    const tool = createSendEmailTool({
      loader: makeLoader(async () => fakeInstance),
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
      resolveRequestId: () => "req-send-fail",
    });

    const result = await runTool<{
      status: string;
      message: string;
      requestId: string | undefined;
    }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("send_failure");
    expect(result.message).toContain("SMTP relay 5.7.0 rejected");
    expect(result.requestId).toBe("req-send-fail");
  });

  it("scrubs connection-string userinfo from send_failure messages", async () => {
    // A nodemailer / outbound-proxy error that embeds `scheme://user:pass@host`
    // would leak creds into the agent's tool output without
    // `errorMessage()` scrubbing. Pin the redaction at the tool boundary.
    const leakySendMail = mock(() =>
      Promise.reject(new Error("Could not connect to socks5://leak:secret@proxy:1080")),
    );
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: leakySendMail as unknown as EmailPluginInstance["sendEmail"],
    };
    const tool = createSendEmailTool({
      loader: makeLoader(async () => fakeInstance),
      resolveWorkspaceId: () => WSID,
      // Recipient gate (#3341): allow the fixture recipients as workspace members.
      resolveMemberEmails: async () => ["dest@example.com", "a@example.com", "b@example.com"],
    });

    const result = await runTool<{ status: string; message: string }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("send_failure");
    expect(result.message).not.toContain("leak:secret");
    expect(result.message).toContain("socks5://***@proxy:1080");
  });

  it("returns status=no_workspace with non-install copy when no active workspaceId is in the request context", async () => {
    // Distinct from `no_install` so the agent doesn't tell a user
    // who already installed Email to "go install Email" — the actual
    // remediation here is "open a workspace-scoped session".
    const tool = createSendEmailTool({
      loader: makeLoader(async () => {
        throw new Error("should not be called");
      }),
      resolveWorkspaceId: () => undefined,
    });

    const result = await runTool<{ status: string; message: string }>(tool, {
      to: ["dest@example.com"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("no_workspace");
    expect(result.message).toMatch(/workspace/i);
    // Must NOT recommend /admin/integrations — they already have it
    // installed; the issue is request context, not the install state.
    expect(result.message).not.toContain("/admin/integrations");
  });
});

// ---------------------------------------------------------------------------
// Recipient allowlist gate (#3341)
// ---------------------------------------------------------------------------

describe("sendEmail recipient allowlist (#3341)", () => {
  const SETTING = "ATLAS_EMAIL_ALLOWED_RECIPIENT_DOMAINS";
  // Since #4479 the gate also honors the deprecated ATLAS_EMAIL_ALLOWED_DOMAINS
  // env knob as a fallback — clear both so ambient env can't flip these tests.
  const GATE_ENV_KEYS = [SETTING, "ATLAS_EMAIL_ALLOWED_DOMAINS"] as const;
  const savedDomains: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of GATE_ENV_KEYS) {
      savedDomains[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of GATE_ENV_KEYS) {
      if (savedDomains[key] === undefined) delete process.env[key];
      else process.env[key] = savedDomains[key];
    }
  });

  function makeNeverLoader() {
    return {
      getOrInstantiate: mock(async (): Promise<PluginLike> => {
        throw new Error("loader must not be reached when the recipient gate blocks");
      }),
    };
  }

  it("blocks a non-member recipient and never reaches the loader", async () => {
    const loader = makeNeverLoader();
    const tool = createSendEmailTool({
      loader,
      resolveWorkspaceId: () => WSID,
      resolveMemberEmails: async () => ["member@corp.example"],
    });

    const result = await runTool<{
      status: string;
      message: string;
      blockedRecipients: string[];
    }>(tool, {
      to: ["attacker@evil.example"],
      subject: "Exfil",
      body: "rows",
    });

    expect(result.status).toBe("recipient_blocked");
    expect(result.blockedRecipients).toEqual(["attacker@evil.example"]);
    expect(loader.getOrInstantiate).not.toHaveBeenCalled();
  });

  it("blocks when only SOME recipients are outside the allowlist", async () => {
    const tool = createSendEmailTool({
      loader: makeNeverLoader(),
      resolveWorkspaceId: () => WSID,
      resolveMemberEmails: async () => ["member@corp.example"],
    });

    const result = await runTool<{ status: string; blockedRecipients: string[] }>(tool, {
      to: ["member@corp.example", "outsider@evil.example"],
      subject: "Hi",
      body: "Hi",
    });

    expect(result.status).toBe("recipient_blocked");
    expect(result.blockedRecipients).toEqual(["outsider@evil.example"]);
  });

  it("allows workspace members case-insensitively", async () => {
    const sendMail = mock(() =>
      Promise.resolve({ messageId: "<ok@example.com>", envelope: {} }),
    );
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: sendMail,
    };
    const tool = createSendEmailTool({
      loader: { getOrInstantiate: mock(async () => fakeInstance) },
      resolveWorkspaceId: () => WSID,
      resolveMemberEmails: async () => ["Member@Corp.Example"],
    });

    const result = await runTool<{ status: string }>(tool, {
      to: ["member@corp.example"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("sent");
  });

  it("allows recipients on an admin-allowlisted domain", async () => {
    process.env[SETTING] = "partner.example, Other.Example";
    const sendMail = mock(() =>
      Promise.resolve({ messageId: "<ok@example.com>", envelope: {} }),
    );
    const fakeInstance: EmailPluginInstance = {
      id: `email:${WSID}`,
      types: ["action"],
      version: "0.1.0",
      name: "Email",
      sendEmail: sendMail,
    };
    const tool = createSendEmailTool({
      loader: { getOrInstantiate: mock(async () => fakeInstance) },
      resolveWorkspaceId: () => WSID,
      resolveMemberEmails: async () => [],
    });

    const result = await runTool<{ status: string }>(tool, {
      to: ["anyone@partner.example", "x@other.example"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("sent");
  });

  it("fails closed when the member list cannot be resolved", async () => {
    const loader = makeNeverLoader();
    const tool = createSendEmailTool({
      loader,
      resolveWorkspaceId: () => WSID,
      resolveMemberEmails: async () => {
        throw new Error("internal DB unavailable");
      },
    });

    const result = await runTool<{ status: string; message: string }>(tool, {
      to: ["member@corp.example"],
      subject: "Hi",
      body: "Hi",
    });
    expect(result.status).toBe("recipient_blocked");
    expect(result.message).toMatch(/blocked/i);
    expect(loader.getOrInstantiate).not.toHaveBeenCalled();
  });
});
