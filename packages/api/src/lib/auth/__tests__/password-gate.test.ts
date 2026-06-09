/**
 * Forced-password-change gate (#3345).
 *
 * `password_change_required` must be enforced server-side on every
 * managed-mode authenticated path — not just the web admin layout's
 * client-side redirect. These tests cover the gate unit surface and its
 * wiring inside `authenticateRequest` (the chokepoint REST and the agent
 * share); the hosted-MCP edge has its own tests in `@atlas/mcp`.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { AuthResult } from "../types";
import { createAtlasUser } from "../types";
import { resetAuthModeCache } from "../detect";
import {
  authenticateRequest,
  _setValidatorOverrides,
  _setSSOEnforcementOverride,
} from "../middleware";
import {
  checkPasswordChangeGate,
  invalidatePasswordGate,
  isPasswordGateExemptPath,
  _resetPasswordGateCache,
  _setPasswordGateLookupOverride,
  PASSWORD_CHANGE_REQUIRED_ERROR,
} from "../password-gate";

const USER_ID = "user-flagged";

describe("checkPasswordChangeGate", () => {
  beforeEach(() => {
    _resetPasswordGateCache();
  });

  afterEach(() => {
    _resetPasswordGateCache();
  });

  it("exempts the change-password endpoints", () => {
    expect(isPasswordGateExemptPath("/api/v1/admin/me/password")).toBe(true);
    expect(isPasswordGateExemptPath("/api/v1/admin/me/password-status")).toBe(true);
    expect(isPasswordGateExemptPath("/api/v1/chat")).toBe(false);
  });

  it("returns null for an unflagged user", async () => {
    _setPasswordGateLookupOverride(async () => false);
    const result = await checkPasswordChangeGate(USER_ID, "http://localhost/api/v1/chat");
    expect(result).toBeNull();
  });

  it("returns 403 with the password_change_required marker for a flagged user", async () => {
    _setPasswordGateLookupOverride(async () => true);
    const result = await checkPasswordChangeGate(USER_ID, "http://localhost/api/v1/chat");
    expect(result).not.toBeNull();
    expect(result!.authenticated).toBe(false);
    if (!result!.authenticated) {
      expect(result!.status).toBe(403);
      expect(result!.error).toContain(PASSWORD_CHANGE_REQUIRED_ERROR);
    }
  });

  it("allows the change-password endpoint even for a flagged user", async () => {
    _setPasswordGateLookupOverride(async () => true);
    const result = await checkPasswordChangeGate(
      USER_ID,
      "http://localhost/api/v1/admin/me/password",
    );
    expect(result).toBeNull();
  });

  it("fails closed (500) when the lookup throws", async () => {
    _setPasswordGateLookupOverride(async () => {
      throw new Error("db down");
    });
    const result = await checkPasswordChangeGate(USER_ID, "http://localhost/api/v1/chat");
    expect(result).not.toBeNull();
    if (!result!.authenticated) {
      expect(result!.status).toBe(500);
    }
  });

  it("invalidatePasswordGate drops the cached flagged verdict", async () => {
    let flagged = true;
    _setPasswordGateLookupOverride(async () => flagged);
    const blocked = await checkPasswordChangeGate(USER_ID, "http://localhost/api/v1/chat");
    expect(blocked).not.toBeNull();

    // Flag cleared in the DB + cache invalidated → next check passes.
    flagged = false;
    invalidatePasswordGate(USER_ID);
    const allowed = await checkPasswordChangeGate(USER_ID, "http://localhost/api/v1/chat");
    expect(allowed).toBeNull();
  });
});

describe("authenticateRequest — managed-mode password gate wiring", () => {
  const origAuthMode = process.env.ATLAS_AUTH_MODE;
  const origDatabaseUrl = process.env.DATABASE_URL;
  const origBetterAuth = process.env.BETTER_AUTH_SECRET;

  const managedUser = createAtlasUser(USER_ID, "managed", "temp@corp.example", {
    activeOrganizationId: "org-1",
  });

  const mockValidateManaged = mock((): Promise<AuthResult> =>
    Promise.resolve({
      authenticated: true as const,
      mode: "managed" as const,
      user: managedUser,
    }),
  );

  beforeEach(() => {
    process.env.ATLAS_AUTH_MODE = "managed";
    delete process.env.DATABASE_URL;
    resetAuthModeCache();
    _resetPasswordGateCache();
    _setSSOEnforcementOverride(async () => null);
    _setValidatorOverrides({ managed: mockValidateManaged });
  });

  afterEach(() => {
    if (origAuthMode !== undefined) process.env.ATLAS_AUTH_MODE = origAuthMode;
    else delete process.env.ATLAS_AUTH_MODE;
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    if (origBetterAuth !== undefined) process.env.BETTER_AUTH_SECRET = origBetterAuth;
    resetAuthModeCache();
    _resetPasswordGateCache();
    _setSSOEnforcementOverride(null);
    _setValidatorOverrides({});
  });

  it("blocks a flagged managed user on a non-exempt path (REST/agent chokepoint)", async () => {
    _setPasswordGateLookupOverride(async () => true);
    const result = await authenticateRequest(
      new Request("http://localhost/api/v1/chat", { method: "POST" }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.status).toBe(403);
      expect(result.error).toContain(PASSWORD_CHANGE_REQUIRED_ERROR);
    }
  });

  it("lets a flagged managed user reach the change-password endpoint", async () => {
    _setPasswordGateLookupOverride(async () => true);
    const result = await authenticateRequest(
      new Request("http://localhost/api/v1/admin/me/password", { method: "POST" }),
    );
    expect(result.authenticated).toBe(true);
  });

  it("does not block an unflagged managed user", async () => {
    _setPasswordGateLookupOverride(async () => false);
    const result = await authenticateRequest(
      new Request("http://localhost/api/v1/chat", { method: "POST" }),
    );
    expect(result.authenticated).toBe(true);
  });
});
