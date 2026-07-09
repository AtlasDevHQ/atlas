/**
 * Lib-layer tests for REST/OpenAPI provisioning over MCP (#3547):
 * `provisionRestDatasource`, which routes the elicited form config through the
 * `openapi-generic` form-install handler (probe-on-install) rather than the
 * native/plugin `createFromConfig` path.
 *
 * Two invariants the `create_rest_datasource` tool relies on:
 *   1. A `FormInstallValidationError` (bad spec URL / auth / failed probe)
 *      becomes a typed `validation` outcome — never a throw, nothing installed.
 *   2. The credential (`auth_value`) is scrubbed from that validation message.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { createConnectionMock } from "../../../__mocks__/connection";
import { FormInstallValidationError } from "@atlas/api/lib/integrations/install/persist-form-install";

// Heavy graph: keep the real modules, mock only the I/O boundaries.
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mock(async () => []),
  hasInternalDB: mock(() => true),
}));
void mock.module("@atlas/api/lib/db/connection", () => createConnectionMock({}));

// The openapi-generic form-install handler — fully controllable per test.
let validateConfigImpl: (orgId: string, formData: Record<string, unknown>) => Promise<unknown> = async () => ({
  installRecord: { id: "rest-xyz", workspaceId: "org_1", catalogId: "openapi-generic" },
});
const validateConfigSpy = mock((orgId: string, formData: Record<string, unknown>) => validateConfigImpl(orgId, formData));
const realDispatch = await import("@atlas/api/lib/integrations/install/dispatch");
void mock.module("@atlas/api/lib/integrations/install/dispatch", () => ({
  ...realDispatch,
  getInstallHandler: mock(() => ({ kind: "form", validateConfig: validateConfigSpy })),
}));
const realRegister = await import("@atlas/api/lib/integrations/install/register");
void mock.module("@atlas/api/lib/integrations/install/register", () => ({
  ...realRegister,
  registerBuiltinInstallHandlers: mock(() => {}),
}));

const { provisionRestDatasource } = await import("../mcp-lifecycle.js");

const SPEC_URL = "https://api.example.com/openapi.json";
const AUTH_SECRET = "sk-super-secret-token";

beforeEach(() => {
  validateConfigSpy.mockClear();
  validateConfigImpl = async () => ({
    installRecord: { id: "rest-xyz", workspaceId: "org_1", catalogId: "openapi-generic" },
  });
});

describe("provisionRestDatasource", () => {
  it("installs via the openapi-generic handler and returns the minted install id", async () => {
    const outcome = await provisionRestDatasource(
      "org_1",
      { openapi_url: SPEC_URL, auth_kind: "bearer", auth_value: AUTH_SECRET },
      ["auth_value"],
    );
    expect(outcome).toEqual({ kind: "ok", installId: "rest-xyz" });
    // The handler received the full formData (credential included).
    expect((validateConfigSpy.mock.calls[0][1] as Record<string, unknown>).auth_value).toBe(AUTH_SECRET);
  });

  it("maps a FormInstallValidationError to a `validation` outcome, scrubbing the credential", async () => {
    validateConfigImpl = async () => {
      throw new FormInstallValidationError({
        fieldErrors: { openapi_url: [`spec fetch failed for ${SPEC_URL} with token ${AUTH_SECRET}`] },
        formErrors: [],
      });
    };
    const outcome = await provisionRestDatasource(
      "org_1",
      { openapi_url: SPEC_URL, auth_kind: "bearer", auth_value: AUTH_SECRET },
      ["auth_value"],
    );
    expect(outcome.kind).toBe("validation");
    if (outcome.kind === "validation") {
      expect(outcome.message).toContain("openapi_url:");
      // The secret credential never rides the surfaced message.
      expect(outcome.message).not.toContain(AUTH_SECRET);
      expect(outcome.message).toContain("[redacted]");
    }
  });

  it("re-throws a non-validation error for the caller's internal_error path", async () => {
    validateConfigImpl = async () => {
      throw new Error("internal DB pool exhausted");
    };
    await expect(
      provisionRestDatasource("org_1", { openapi_url: SPEC_URL }, []),
    ).rejects.toThrow(/DB pool exhausted/);
  });

  it("scrubs the credential from a re-thrown non-validation error", async () => {
    validateConfigImpl = async () => {
      throw new Error(`probe blew up with Authorization: Bearer ${AUTH_SECRET}`);
    };
    await expect(
      provisionRestDatasource(
        "org_1",
        { openapi_url: SPEC_URL, auth_value: AUTH_SECRET },
        ["auth_value"],
      ),
    ).rejects.toThrow(/\[redacted\]/);
    // And the secret itself never rides the thrown message.
    await provisionRestDatasource("org_1", { openapi_url: SPEC_URL, auth_value: AUTH_SECRET }, ["auth_value"]).catch(
      (e: unknown) => {
        expect(e instanceof Error ? e.message : String(e)).not.toContain(AUTH_SECRET);
      },
    );
  });
});
