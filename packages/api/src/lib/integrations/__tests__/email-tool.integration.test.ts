/**
 * Integration test for the Email agent-tool wire.
 *
 * Stands in for the browser e2e mentioned in the issue's acceptance
 * criteria. A true browser-driven test would have to drive the
 * non-deterministic agent loop end-to-end and observe an out-of-process
 * nodemailer stub — too brittle and too slow for CI. Instead this test
 * exercises every layer between the install form and the actual
 * `transport.sendMail` call:
 *
 *   1. `lazyPluginLoader` (the real singleton, not a mock) reads
 *      `workspace_plugins.config` via the real `internalQuery` (mocked
 *      at the SQL boundary so no Postgres is required).
 *   2. The Email lazy-builder decrypts the secret fields, constructs a
 *      `nodemailer.streamTransport` (buffer-only — no socket, no relay)
 *      and exposes `sendEmail()`.
 *   3. The `sendEmail` agent tool resolves the active workspace from
 *      `getRequestContext`, calls
 *      `lazyPluginLoader.getOrInstantiate("catalog:email")`, dispatches.
 *   4. The streamTransport's buffer captures the raw RFC-822 message;
 *      the test reads it back to assert recipient + subject made it
 *      through.
 *
 * Two scenarios pinned:
 *   - **Install present + cached on second call**: first send constructs
 *     the transport, second send re-uses the cached `PluginLike` (the
 *     mocked `internalQuery` is called once — proves the cache is hit).
 *   - **No install row**: surfaces `no_install` status with the
 *     `/admin/integrations` copy. The tool's actionable-error contract
 *     is what keeps the agent from looping on retries.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import nodemailer from "nodemailer";

import { withRequestContext } from "@atlas/api/lib/logger";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { EMAIL_CATALOG_ID } from "../install/email-secret-schema";

// `internalQuery` is the seam the real LazyPluginLoader uses to read
// `workspace_plugins.config`. Mocking it lets the real loader drive
// the real builder without booting Postgres.
//
// The other named exports below are mock-all-exports filler — this
// test's transitive graph only reaches `internalQuery`, but partial
// mocks `SyntaxError` other test files that import from this module.
// The `encryptSecret` / `decryptSecret` stubs in particular are NOT
// on the production decrypt path here: the Email builder reaches for
// `db/secret-encryption.ts` via `decryptSecretFields`, not these
// `db/internal.ts` re-exports. The test exercises the real decrypt
// path via `decryptSecretFields`' un-prefixed-plaintext passthrough
// (see the F-42 row at `plugins/secrets.ts:secrets-passthrough`). To
// genuinely exercise ciphertext decrypt, set `ATLAS_ENCRYPTION_KEYS`
// in the test env and store an `enc:v1:...` value in STORED_CONFIG.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);
mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  getInternalDB: mock(() => null),
  getInternalPool: mock(() => null),
  initializeInternalDB: mock(() => Promise.resolve()),
  closeInternalDB: mock(() => Promise.resolve()),
  hasInternalDB: mock(() => true),
  encryptSecret: mock((v: string) => v),
  decryptSecret: mock((v: string) => v),
  MANAGED_AUTH_MIGRATIONS: new Set<string>(),
}));

// Now we can import the real loader + tool — they'll use the mocked
// internalQuery.
type LoaderMod = typeof import("@atlas/api/lib/plugins/lazy-loader");
type ToolMod = typeof import("../email-tool");
let loaderMod!: LoaderMod;
let toolMod!: ToolMod;

beforeEach(async () => {
  loaderMod = await import("@atlas/api/lib/plugins/lazy-loader");
  toolMod = await import("../email-tool");
  // Reset the singleton between tests — registerBuilder is idempotent
  // but cached instances should NOT leak across scenarios.
  loaderMod.lazyPluginLoader._reset();
  mockInternalQuery.mockReset();
});

afterEach(() => {
  loaderMod.lazyPluginLoader._reset();
});

const WSID = "ws-email-integration";

const STORED_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  username: "atlas@example.com",
  // Plaintext password — decryptSecretFields passes un-prefixed values
  // through unchanged (the F-42 legacy-row passthrough path).
  password: "smtp-password",
  fromAddress: "Atlas <atlas@example.com>",
  secure: true,
};

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<T = unknown>(tool: any, args: unknown): Promise<T> {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool.execute(args, undefined as any)) as T;
}

describe("Email agent-tool — install-present path through the real lazy loader", () => {
  it("delivers the message via the workspace transport, then re-uses the cached instance on a second send", async () => {
    // streamTransport buffers the full RFC-822 message instead of
    // opening a TCP / TLS connection. The test reads the buffer to
    // assert recipient + subject made it through every layer of the
    // wire.
    const capturedTransport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    });

    // Capture the RFC-822 buffer streamTransport produces (buffer:true →
    // `info.message` is a Buffer) so the test can read back what the real
    // nodemailer serializer wrote. The unit test mocks `createTransport`,
    // so this wrapper is the only place a serializer regression across a
    // nodemailer major bump would surface.
    let serializedMessage = "";
    const realSendMail = capturedTransport.sendMail.bind(capturedTransport);
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    capturedTransport.sendMail = (async (message: any) => {
      const info = await realSendMail(message);
      const raw = (info as { message?: Buffer | string }).message;
      serializedMessage = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
      return info;
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    loaderMod.lazyPluginLoader.registerBuilder(
      EMAIL_CATALOG_ID,
      toolMod.createEmailLazyBuilder({
        // `createTransport` is overloaded across nodemailer's many transport
        // types — the test's streamTransport returns a different narrowed
        // generic than the SMTP-typed signature the builder's parameter
        // declares. They are structurally identical for `.sendMail()` /
        // `.close()` so `unknown` widens past the overload mismatch.
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        createTransport: (() => capturedTransport) as any,
      }),
    );

    mockInternalQuery.mockImplementation(async () => [{ config: STORED_CONFIG }]);

    const tool = toolMod.createSendEmailTool({
      // Recipient gate (#3341): seam keeps the internalQuery call-count
      // contract (one config read) intact while allowing the fixture recipient.
      resolveMemberEmails: async () => ["dest@example.com", "another@example.com"],
    });

    const result1 = await withRequestContext(
      {
        requestId: "req-1",
        user: createAtlasUser("u-test", "simple-key", "Test", {
          activeOrganizationId: WSID,
        }),
      },
      async () =>
        runTool<{ status: string; messageId: string | undefined }>(tool, {
          to: ["dest@example.com"],
          subject: "Q1 revenue summary",
          body: "<p>Revenue up 12%.</p>",
        }),
    );
    expect(result1.status).toBe("sent");
    expect(result1.messageId).toBeTruthy();
    // The streamTransport's last-message buffer carries the RFC-822
    // serialization; assert the recipient + subject the tool was handed
    // survived message construction through nodemailer's real serializer.
    expect(serializedMessage).toContain("dest@example.com");
    expect(serializedMessage).toContain("Q1 revenue summary");
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);

    // Second send re-uses the cached instance — the loader memoizes
    // the PluginLike for the (workspaceId, catalogId) pair and the
    // builder runs only once. Without caching, every send would
    // re-open SMTP sockets and re-decrypt the stored row.
    const result2 = await withRequestContext(
      {
        requestId: "req-2",
        user: createAtlasUser("u-test", "simple-key", "Test", {
          activeOrganizationId: WSID,
        }),
      },
      async () =>
        runTool<{ status: string }>(tool, {
          to: ["another@example.com"],
          subject: "Followup",
          body: "<p>Follow-up</p>",
        }),
    );
    expect(result2.status).toBe("sent");
    // Cache hit: internalQuery was NOT called a second time.
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("returns no_install with actionable copy when workspace_plugins has no enabled row for catalog:email", async () => {
    loaderMod.lazyPluginLoader.registerBuilder(
      EMAIL_CATALOG_ID,
      toolMod.createEmailLazyBuilder({
        // No transport factory needed — the loader short-circuits
        // before the builder runs when the row is missing.
        createTransport: ((): never => {
          throw new Error("builder should not run when there is no install");
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      }),
    );

    mockInternalQuery.mockImplementation(async () => []);

    const tool = toolMod.createSendEmailTool({
      // Recipient gate (#3341): seam keeps the internalQuery call-count
      // contract (one config read) intact while allowing the fixture recipient.
      resolveMemberEmails: async () => ["dest@example.com", "another@example.com"],
    });
    const result = await withRequestContext(
      {
        requestId: "req-no-install",
        user: createAtlasUser("u-test", "simple-key", "Test", {
          activeOrganizationId: WSID,
        }),
      },
      async () =>
        runTool<{ status: string; message: string }>(tool, {
          to: ["dest@example.com"],
          subject: "Hi",
          body: "Hi",
        }),
    );
    expect(result.status).toBe("no_install");
    expect(result.message).toMatch(/\/admin\/integrations/);
  });
});
