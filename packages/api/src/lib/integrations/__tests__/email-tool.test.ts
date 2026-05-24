/**
 * Tests for the Email LazyPluginLoader builder + `sendEmail` agent tool
 * (#2698).
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
 *   - Tool install-present path: dispatches into the cached instance's
 *     `sendEmail`. Verifies the loader is hit exactly once (transport
 *     caching is the loader's responsibility, but the tool must not
 *     bypass it).
 *   - Tool send-failure path: the transport throws → status
 *     `send_failure` with `requestId` echoed back.
 *
 * Mock-all-exports note: the `lazyPluginLoader` mock provides the full
 * named-export surface (`LazyPluginLoader`, `LazyPluginBuilderMissingError`,
 * `LazyPluginInstallNotFoundError`, plus the singleton itself) so other
 * test files importing the loader don't `SyntaxError` on missing
 * exports. Same convention used by `salesforce/__tests__/lazy-builder.test.ts`.
 */

import { beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

import {
  createEmailLazyBuilder,
  createSendEmailTool,
  EmailDecryptFailureError,
  type EmailPluginInstance,
} from "../email-tool";
import { LazyPluginInstallNotFoundError } from "@atlas/api/lib/plugins/lazy-loader";
import type { PluginLike } from "@atlas/api/lib/plugins/registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WSID = "ws-email-test";
const CATALOG_ID = "catalog:email";

const HAPPY_DECRYPTED_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "atlas@example.com",
  password: "smtp-password",
  fromAddress: "Atlas <atlas@example.com>",
  secure: true,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  if (!tool?.execute) throw new Error("tool has no execute");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  });

  it("second send re-uses the loader's cached instance — does NOT rebuild the transport", async () => {
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
    });

    await runTool(tool, { to: ["a@example.com"], subject: "1", body: "1" });
    await runTool(tool, { to: ["b@example.com"], subject: "2", body: "2" });

    // The lazy loader's caching contract is what guarantees the
    // transport survives across sends. The tool path defers to it
    // every time — caching happens *in* the loader. Both calls call
    // getOrInstantiate; the loader returns the same cached instance.
    expect(loader.getOrInstantiate).toHaveBeenCalledTimes(2);
    expect(lastInstanceSendMail).toHaveBeenCalledTimes(2);
  });

  it("returns status=send_failure with the requestId when transport.sendMail throws", async () => {
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

  it("returns status=no_install when no active workspaceId is in the request context", async () => {
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
    expect(result.status).toBe("no_install");
    expect(result.message).toMatch(/workspace/i);
  });
});
