/**
 * Direct unit tests for {@link verifyCallbackState} — the shared step-1
 * catalog-slug state guard extracted from the seven OAuth handlers
 * (#4188).
 *
 * The fail-closed invariant under test: a state token bound to a catalog
 * OTHER than the handler's own slug is rejected (`null`), and a valid,
 * catalog-matched token yields the branded workspace id. Previously
 * re-asserted across seven handler suites; now it lives here once against
 * the REAL sign/verify path (`mintOAuthStateToken` +
 * `verifyOAuthStateToken`), so a signature regression can't slip past a
 * mock.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { mutateLastChar } from "../../../../__test-utils__/base64url";
import type { WorkspaceId } from "@useatlas/types";
import { mintOAuthStateToken } from "../oauth-state-token";
import { verifyCallbackState } from "../oauth-callback-verify";

const ORIGINAL_ENV = { ...process.env };
const WSID = "ws-verify-test-1" as WorkspaceId;
const REJECTION_MESSAGE = "Test OAuth callback received state bound to a different catalog — rejecting";

function makeLog(): { warn: ReturnType<typeof mock> } {
  return { warn: mock(() => undefined) };
}

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-one";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

describe("verifyCallbackState", () => {
  it("returns the branded workspaceId when the token is valid and catalog-matched", () => {
    const token = mintOAuthStateToken(WSID, "jira");
    const log = makeLog();

    const result = verifyCallbackState(token, "jira", log, REJECTION_MESSAGE);

    expect(result).toEqual({ workspaceId: WSID });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rejects (null) and logs when the token is bound to a DIFFERENT catalog", () => {
    // The fail-closed invariant: a token minted for salesforce must not
    // pass a jira handler's guard even though the signature is valid.
    const token = mintOAuthStateToken(WSID, "salesforce");
    const log = makeLog();

    const result = verifyCallbackState(token, "jira", log, REJECTION_MESSAGE);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { expected: "jira", got: "salesforce" },
      REJECTION_MESSAGE,
    );
  });

  it("returns null WITHOUT logging when the signature is tampered", () => {
    // A forged/tampered token fails signature verification — a distinct
    // rejection path from catalog mismatch, and one that must NOT log the
    // catalog-mismatch line (nothing to compare).
    const good = mintOAuthStateToken(WSID, "jira");
    const [h, p, s] = good.split(".");
    const tampered = `${h}.${mutateLastChar(p)}.${s}`;
    const log = makeLog();

    const result = verifyCallbackState(tampered, "jira", log, REJECTION_MESSAGE);

    expect(result).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns null on a garbage/empty token", () => {
    const log = makeLog();
    expect(verifyCallbackState("", "jira", log, REJECTION_MESSAGE)).toBeNull();
    expect(verifyCallbackState("not-a-token", "jira", log, REJECTION_MESSAGE)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
