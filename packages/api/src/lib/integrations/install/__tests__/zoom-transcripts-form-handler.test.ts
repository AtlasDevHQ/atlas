/**
 * Unit tests for `ZoomTranscriptsFormInstallHandler` (#4965).
 *
 * This handler shipped with no test at all, in a directory where every one of
 * its siblings has one — the gap the M3 review panel found. Mirrors
 * `gitbook-form-handler.test.ts`'s five load-bearing blocks, because this
 * handler is the same shape: verify loudly before persisting, credential into
 * `knowledge_sync_credentials`, NEVER into `workspace_plugins.config`, and roll
 * the credential back if the install row does not land.
 *
 * The credential-rollback block is the one that matters most. It is the only
 * thing standing between a failed install and an encrypted client secret that
 * outlives it: the install row never landed, so uninstall can never reach the
 * credential to clean it up.
 *
 * Field ATTRIBUTION is the other focus. Zoom reports three different faults
 * through the same probe, and each blames a different field — blaming the secret
 * for an account-id typo sends an admin to regenerate a credential that was
 * fine, which is a support round-trip and a rotated secret for nothing.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:zoom-transcripts" }];
let INSERT_RETURNS_ID = true;
let CROSS_CATALOG_ROWS: { catalog_id: string }[] = [];
const insertCalls: { sql: string; params: unknown[] }[] = [];

const internalQuery = mock(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  if (sql.includes("FROM plugin_catalog")) return CATALOG_ROWS;
  if (sql.includes("catalog_id <> $3")) return CROSS_CATALOG_ROWS;
  if (sql.includes("INSERT INTO workspace_plugins")) {
    insertCalls.push({ sql, params });
    return INSERT_RETURNS_ID ? [{ id: params[0] }] : [];
  }
  throw new Error(`unexpected SQL: ${sql.slice(0, 50)}`);
});

void mock.module("@atlas/api/lib/db/internal", () => buildInternalDbMockDefaults({ internalQuery }));
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const saveSyncCredential = mock(async (_w: string, _c: string, _s: string) => {});
const deleteSyncCredential = mock(async (_w: string, _c: string) => {});
const readSyncCredential = mock(async () => null);
void mock.module("@atlas/api/lib/knowledge/sync-credentials", () => ({
  SYNC_CREDENTIAL_UPSERT_SQL: "INSERT ...",
  saveSyncCredential,
  deleteSyncCredential,
  readSyncCredential,
}));

const { ZoomTranscriptsFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/zoom-transcripts-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const VALID = {
  accountId: "acct-123",
  clientId: "client-abc",
  clientSecret: "SUPER-SECRET-VALUE",
};

type TokenResult = { ok: true; token: string } | { ok: false; error: string; retryAfterSeconds: null };
type ProbeResult = { ok: true; meetings: unknown[]; nextPageToken: null } | { ok: false; error: string; retryAfterSeconds: null };

/**
 * A handler wired to fixture probes. Both Zoom calls are injected, so no test
 * touches the network and each failure arm is reachable directly.
 */
function handler(
  opts: { token?: TokenResult; probe?: ProbeResult } = {},
): InstanceType<typeof ZoomTranscriptsFormInstallHandler> {
  return new ZoomTranscriptsFormInstallHandler({
    idGenerator: () => "fixed-id",
    fetchZoomAccessToken: (async () =>
      opts.token ?? { ok: true, token: "tok" }) as never,
    fetchAccountRecordingsPage: (async () =>
      opts.probe ?? { ok: true, meetings: [], nextPageToken: null }) as never,
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:zoom-transcripts" }];
  INSERT_RETURNS_ID = true;
  CROSS_CATALOG_ROWS = [];
  insertCalls.length = 0;
  internalQuery.mockClear();
  saveSyncCredential.mockClear();
  deleteSyncCredential.mockClear();
});
afterEach(() => internalQuery.mockClear());

async function fieldErrorOf(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.fieldErrors[field]?.[0];
    throw err;
  }
  return undefined;
}

async function formErrorOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FormInstallValidationError) return err.formErrors[0];
    throw err;
  }
  return undefined;
}

describe("field validation", () => {
  it("requires the account id, client id, and client secret", async () => {
    for (const missing of ["accountId", "clientId", "clientSecret"]) {
      const form = { ...VALID, [missing]: "" };
      expect([missing, await fieldErrorOf(handler().validateConfig(WORKSPACE, form), missing)]).toEqual(
        [missing, expect.any(String)],
      );
    }
  });

  it("rejects a non-object body with a form-level error", async () => {
    expect(await formErrorOf(handler().validateConfig(WORKSPACE, "nope"))).toContain(
      "JSON object",
    );
  });
});

describe("credential verification", () => {
  it("blames the client SECRET when Zoom rejects the credential", async () => {
    const message = await fieldErrorOf(
      handler({ token: { ok: false, error: "invalid_auth", retryAfterSeconds: null } }).validateConfig(
        WORKSPACE,
        VALID,
      ),
      "clientSecret",
    );
    expect(message).toContain("Zoom rejected these credentials");
  });

  it("⭐ blames the ACCOUNT ID on a 404, not the secret", async () => {
    // The attribution that costs the most when wrong. A 404 from the recordings
    // probe means this app cannot read that account — an account-id typo.
    // Blaming `clientSecret` sends the admin to regenerate a working credential.
    //
    // MUTATION THIS CATCHES: collapsing the probe's field mapping to one field.
    const message = await fieldErrorOf(
      handler({ probe: { ok: false, error: "not_found", retryAfterSeconds: null } }).validateConfig(
        WORKSPACE,
        VALID,
      ),
      "accountId",
    );
    expect(message).toContain("does not recognise this account ID");
  });

  it("blames the client ID for a missing scope, and names the scopes", async () => {
    const message = await fieldErrorOf(
      handler({ probe: { ok: false, error: "missing_scope", retryAfterSeconds: null } }).validateConfig(
        WORKSPACE,
        VALID,
      ),
      "clientId",
    );
    expect(message).toContain("cloud_recording:read:admin");
  });

  it("routes a rate-limit (429) verification failure to a form-level error, not a field", async () => {
    // Nothing the admin typed is wrong, so no field may be reddened — a field
    // error here reads as "you got this value wrong" about a correct value.
    const err = await handler({
      token: { ok: false, error: "ratelimited", retryAfterSeconds: null },
    })
      .validateConfig(WORKSPACE, VALID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormInstallValidationError);
    const validation = err as InstanceType<typeof FormInstallValidationError>;
    expect(validation.fieldErrors).toEqual({});
    expect(validation.formErrors[0]).toContain("Could not reach Zoom");
  });

  it("⭐ never persists anything when verification fails", async () => {
    // Verify-before-persist is the whole ordering. A handler that wrote the
    // credential first would leave one behind for every failed install attempt.
    await handler({ token: { ok: false, error: "invalid_auth", retryAfterSeconds: null } })
      .validateConfig(WORKSPACE, VALID)
      .catch(() => undefined);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});

describe("successful install", () => {
  it("⭐ verifies, writes the credential, then upserts — the secret never reaches config", async () => {
    // The routing rule for every knowledge install: secrets go to
    // `knowledge_sync_credentials` (encrypted), and `workspace_plugins.config`
    // is admin-readable, so a secret landing there is a disclosure.
    const rec = await handler().validateConfig(WORKSPACE, {
      ...VALID,
      hosts: ["host@corp.test"],
    });
    expect(rec.installRecord.id).toBe("fixed-id");
    expect(rec.credentialWritten).toBe(true);
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);

    const config = JSON.parse(insertCalls[0].params[4] as string) as Record<string, unknown>;
    expect(config).toEqual({ accountId: "acct-123", hosts: ["host@corp.test"] });
    // Asserted on the serialized form, not just the parsed object: the point is
    // that no substring of the secret reaches the row at all.
    expect(insertCalls[0].params[4]).not.toContain("SUPER-SECRET-VALUE");
    expect(insertCalls[0].params[4]).not.toContain("client-abc");
  });

  it("omits an ABSENT host list — blank means the whole account, by design", () => {
    // Unlike Outlook's mailbox scope, Zoom's host field is optional and its
    // absence is meaningful. Pinned so a later "consistency" edit does not make
    // it required.
    return handler()
      .validateConfig(WORKSPACE, VALID)
      .then(() => {
        const config = JSON.parse(insertCalls[0].params[4] as string) as Record<string, unknown>;
        expect(config).toEqual({ accountId: "acct-123" });
      });
  });

  it("⭐ rolls back the credential when the install-row upsert fails", async () => {
    // The install row never landed, so uninstall will never reach the
    // credential — without this rollback an encrypted client secret outlives
    // the failed install with nothing pointing at it.
    //
    // MUTATION THIS CATCHES: dropping the `deleteSyncCredential` call in the
    // upsert's catch.
    INSERT_RETURNS_ID = false;
    await expect(handler().validateConfig(WORKSPACE, VALID)).rejects.toThrow();
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(deleteSyncCredential).toHaveBeenCalledTimes(1);
  });

  it("a rollback FAILURE does not mask the original error", async () => {
    // The cleanup is best-effort. If it throws too, the error the admin sees
    // must still be the one that actually failed the install.
    INSERT_RETURNS_ID = false;
    deleteSyncCredential.mockImplementationOnce(async () => {
      throw new Error("cleanup exploded");
    });
    const err = await handler()
      .validateConfig(WORKSPACE, VALID)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("cleanup exploded");
  });
});
