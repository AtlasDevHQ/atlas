/**
 * Unit tests for `OutlookMailFormInstallHandler` (#4966).
 *
 * Like its Zoom sibling this handler shipped with no test, in a directory where
 * every other handler has one. Mirrors `gitbook-form-handler.test.ts`'s
 * load-bearing blocks, and adds the one property that is Outlook's alone:
 *
 * ⚠️ **The mailbox scope is REQUIRED, and that is a blast-radius control.**
 * Graph's application `Mail.Read` is TENANT-WIDE — consenting to it grants the
 * app every mailbox in the organisation. Zoom's host list is optional because
 * blank sensibly means "the whole account this app was scoped to"; there is no
 * equivalent here, so an omitted mailbox list must be a validation error rather
 * than an implicit "everything". A regression that made it optional would turn
 * a blank field into tenant-wide mail ingestion, silently.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { WorkspaceId } from "@useatlas/types";

let CATALOG_ROWS: { id: string }[] = [{ id: "catalog:outlook-mail" }];
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

const { OutlookMailFormInstallHandler } = await import(
  "@atlas/api/lib/integrations/install/outlook-mail-form-handler"
);
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/persist-form-install"
);

const WORKSPACE = "org-1" as WorkspaceId;
const MAILBOX = "ada@contoso.com";
const VALID = {
  tenantId: "tenant-123",
  clientId: "client-abc",
  clientSecret: "SUPER-SECRET-VALUE",
  mailboxes: [MAILBOX],
};

/** A handler wired to fixture probes — no test touches Microsoft Graph. */
function handler(
  opts: {
    token?: { ok: boolean; token?: string; error?: string; retryAfterSeconds?: null };
    mailbox?: { ok: boolean; mailbox?: unknown; error?: string; retryAfterSeconds?: null };
    messages?: { ok: boolean; error?: string; retryAfterSeconds?: null };
  } = {},
): InstanceType<typeof OutlookMailFormInstallHandler> {
  return new OutlookMailFormInstallHandler({
    idGenerator: () => "fixed-id",
    fetchGraphAccessToken: (async () =>
      opts.token ?? { ok: true, token: "tok" }) as never,
    // `fetchMailbox` resolves to `{ ok, mailbox: { id, userPrincipalName, mail } }`
    // — the nested shape matters, because `verifyConnection` reads
    // `result.mailbox.id` to run its third probe by stable object ID.
    fetchMailbox: (async () =>
      opts.mailbox ?? {
        ok: true,
        mailbox: { id: "obj-1", userPrincipalName: MAILBOX, mail: MAILBOX },
      }) as never,
    fetchMailboxMessagesPage: (async () =>
      opts.messages ?? { ok: true, messages: [], nextLink: null }) as never,
  });
}

beforeEach(() => {
  CATALOG_ROWS = [{ id: "catalog:outlook-mail" }];
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

describe("field validation", () => {
  it("requires the tenant id, client id, and client secret", async () => {
    for (const missing of ["tenantId", "clientId", "clientSecret"]) {
      const form = { ...VALID, [missing]: "" };
      expect([missing, await fieldErrorOf(handler().validateConfig(WORKSPACE, form), missing)]).toEqual(
        [missing, expect.any(String)],
      );
    }
  });

  it("⭐ REQUIRES the mailbox scope — there is no spelling that means the whole tenant", async () => {
    // The asymmetry with Zoom, and the reason it exists: Graph's application
    // `Mail.Read` is tenant-wide, so an omitted list cannot safely default to
    // "everything". Both an absent field and a non-list are refused.
    //
    // MUTATION THIS CATCHES: making `mailboxes` optional, or defaulting it to
    // `[]` — either of which turns a blank field into tenant-wide ingestion.
    const { mailboxes: _omitted, ...withoutMailboxes } = VALID;
    const message = await fieldErrorOf(
      handler().validateConfig(WORKSPACE, withoutMailboxes),
      "mailboxes",
    );
    expect(message).toContain("no setting for every mailbox in the tenant");
  });

  it("accepts a comma-separated string as well as a list", async () => {
    await handler().validateConfig(WORKSPACE, { ...VALID, mailboxes: `${MAILBOX},bo@contoso.com` });
    const config = JSON.parse(insertCalls[0].params[4] as string) as { mailboxes: string[] };
    expect(config.mailboxes).toHaveLength(2);
  });

  it("refuses a non-string entry rather than silently narrowing the scope", async () => {
    // Dropping a bad entry would ingest a NARROWER set than the admin asked
    // for, while reporting success — the same silent-narrowing failure the
    // Slack channel config refuses.
    expect(
      await fieldErrorOf(
        handler().validateConfig(WORKSPACE, { ...VALID, mailboxes: [MAILBOX, 42] }),
        "mailboxes",
      ),
    ).toContain("email address or an object ID");
  });
});

describe("credential verification", () => {
  it("blames the client SECRET when Entra rejects the credential", async () => {
    const message = await fieldErrorOf(
      handler({
        token: { ok: false, error: "invalid_auth", retryAfterSeconds: null },
      }).validateConfig(WORKSPACE, VALID),
      "clientSecret",
    );
    expect(message).toBeDefined();
  });

  it("⭐ blames the MAILBOX list on a not_found, and the CLIENT ID on a missing scope", async () => {
    // Two different repairs in two different consoles. A mailbox typo is fixed
    // in the form; a missing `User.ReadBasic.All` consent is fixed in Entra by
    // someone who may not be the person installing. Collapsing them sends the
    // admin to the wrong place.
    //
    // MUTATION THIS CATCHES: routing both to one field.
    expect(
      await fieldErrorOf(
        handler({
          mailbox: { ok: false, error: "not_found", retryAfterSeconds: null },
        }).validateConfig(WORKSPACE, VALID),
        "mailboxes",
      ),
    ).toContain("does not recognise the mailbox");

    expect(
      await fieldErrorOf(
        handler({
          mailbox: { ok: false, error: "missing_scope", retryAfterSeconds: null },
        }).validateConfig(WORKSPACE, VALID),
        "clientId",
      ),
    ).toContain("User.ReadBasic.All");
  });

  it("⭐ never persists anything when verification fails", async () => {
    await handler({ token: { ok: false, error: "invalid_auth", retryAfterSeconds: null } })
      .validateConfig(WORKSPACE, VALID)
      .catch(() => undefined);
    expect(saveSyncCredential).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });
});

describe("successful install", () => {
  it("⭐ verifies, writes the credential, then upserts — the secret never reaches config", async () => {
    const rec = await handler().validateConfig(WORKSPACE, VALID);
    expect(rec.installRecord.id).toBe("fixed-id");
    expect(rec.credentialWritten).toBe(true);
    expect(saveSyncCredential).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveLength(1);

    const config = JSON.parse(insertCalls[0].params[4] as string) as Record<string, unknown>;
    expect(config.tenantId).toBe("tenant-123");
    expect(config.mailboxes).toBeDefined();
    // `workspace_plugins.config` is admin-readable — a secret here is a
    // disclosure. Asserted on the serialized row, so no fragment slips through.
    expect(insertCalls[0].params[4]).not.toContain("SUPER-SECRET-VALUE");
    expect(insertCalls[0].params[4]).not.toContain("client-abc");
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
