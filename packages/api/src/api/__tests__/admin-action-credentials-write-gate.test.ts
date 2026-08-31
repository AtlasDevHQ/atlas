/**
 * The PUT completeness gate on /api/v1/admin/action-credentials/{target} (#5564).
 *
 * `missingRequired` had no caller on the write path, so a half-filled save
 * persisted a row that — under ADR-0046's all-or-nothing rung rule — SHADOWS
 * the environment rung rather than being topped up by it. On a self-hosted
 * deploy that silently breaks a target that was working from `process.env`,
 * and nothing in the status response could say so. These tests pin the gate
 * that now refuses such a write.
 *
 * ── Why this mounts the router rather than booting the app ────────────────
 *
 * The sibling route suites (`admin-email-provider-route.test.ts` and friends)
 * build the whole Hono app so they can exercise auth, MFA and org scoping end
 * to end. Those are already pinned for this router by `createAdminRouter` +
 * `requireOrgContext` + `requirePermission`, which it mounts unmodified and
 * which no change here touches. What IS new is the merge-then-validate-then-
 * persist ordering inside the handler, so the router is mounted directly with
 * the org context stubbed — the smallest harness that can still observe
 * whether `saveActionCredentials` was called.
 *
 * @see ADR-0046 — per-workspace action credentials
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

const ORG = "org-tenant-1";
const REQUEST_ID = "req-test-1";

const mockRead: Mock<
  (workspaceId: string, target: string) => Promise<Record<string, string> | null>
> = mock(() => Promise.resolve(null));
const mockSave: Mock<
  (workspaceId: string, target: string, bundle: Record<string, string>) => Promise<void>
> = mock(() => Promise.resolve());
const mockDelete: Mock<(workspaceId: string, target: string) => Promise<boolean>> = mock(() =>
  Promise.resolve(true),
);
const mockAudit: Mock<(entry: unknown) => Promise<void>> = mock(() => Promise.resolve());

void mock.module("@atlas/api/lib/tools/actions/credentials/store", () => ({
  readActionCredentials: mockRead,
  saveActionCredentials: mockSave,
  deleteActionCredentials: mockDelete,
}));
void mock.module("@atlas/api/lib/db/internal", () => ({ hasInternalDB: () => true }));
void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: "self-hosted" }),
}));
void mock.module("@atlas/api/lib/audit", () => ({
  logAdminActionAwait: mockAudit,
  ADMIN_ACTIONS: {
    workspaceActionCredential: {
      update: "workspace_action_credential.update",
      delete: "workspace_action_credential.delete",
    },
  },
}));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// The gates this suite is NOT about — admin role, MFA, org scoping — are the
// router factory's, mounted unmodified. Stubbed to a fixed org so the handler
// under test is what the request reaches.
void mock.module("../routes/admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  // Typed to the two members the stub actually touches rather than to Hono's
  // full generic context — narrower than `any`, and it states exactly what the
  // handler under test depends on: an `orgContext` put there by middleware.
  requireOrgContext:
    () =>
    async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set("orgContext", { orgId: ORG, requestId: REQUEST_ID });
      await next();
    },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { adminActionCredentials } = await import("../routes/admin-action-credentials");

/** Every required Jira field — the shape a save must reach to be persisted. */
const COMPLETE = {
  JIRA_BASE_URL: "https://tenant.atlassian.net",
  JIRA_EMAIL: "admin@tenant.example",
  JIRA_API_TOKEN: "tenant-token",
};

// `async` + `await`: Hono's `request()` is typed `Response | Promise<Response>`,
// so returning it straight from a `Promise<Response>` function does not check.
async function put(target: string, body: unknown): Promise<Response> {
  return await adminActionCredentials.request(`/${target}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRead.mockReset();
  mockRead.mockResolvedValue(null);
  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
  mockDelete.mockReset();
  mockDelete.mockResolvedValue(true);
  mockAudit.mockReset();
  mockAudit.mockResolvedValue(undefined);
});

describe("PUT — a merged result that would be partial is refused", () => {
  it("rejects with 400 and persists NOTHING", async () => {
    const res = await put("jira", { fields: { JIRA_BASE_URL: COMPLETE.JIRA_BASE_URL } });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
    // Nothing was written, so nothing is worth auditing either — an audit row
    // for a save that did not happen is a false trail through the one log a
    // workspace admin's actions are reconstructed from.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("names every unsatisfied required field, and no satisfied one", async () => {
    const res = await put("jira", { fields: { JIRA_BASE_URL: COMPLETE.JIRA_BASE_URL } });
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("incomplete_credentials");
    expect(body.message).toContain("JIRA_EMAIL");
    expect(body.message).toContain("JIRA_API_TOKEN");
    expect(body.message).not.toContain("JIRA_BASE_URL");
  });

  it("leaks no credential value — not the submitted one, not the stored one", async () => {
    mockRead.mockResolvedValue({ JIRA_API_TOKEN: "already-stored-token" });
    const res = await put("jira", { fields: { JIRA_BASE_URL: "https://leaky.example" } });
    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).not.toContain("already-stored-token");
    expect(body).not.toContain("leaky.example");
  });

  it("refuses a clearFields that would empty a required field of a complete row", async () => {
    // The row is fine today; the request would break it. Blank values in
    // `fields` preserve, so `clearFields` is the only way to reach this — and
    // it is the exact move that turns a working target into a shadowing one.
    mockRead.mockResolvedValue(COMPLETE);
    const res = await put("jira", { fields: {}, clearFields: ["JIRA_API_TOKEN"] });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("validates the MERGED value, so clearing and re-supplying in one request succeeds", async () => {
    mockRead.mockResolvedValue(COMPLETE);
    const res = await put("jira", {
      fields: { JIRA_API_TOKEN: "rotated-token" },
      clearFields: ["JIRA_API_TOKEN"],
    });
    // `clearFields` wins over `fields` by design, so this DOES leave the token
    // unset — the check sees the same merged object the write would persist,
    // which is the whole reason it is asked there and not of the request body.
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("counts a whitespace-only value as unset, exactly as the resolver would", async () => {
    const res = await put("jira", { fields: { ...COMPLETE, JIRA_API_TOKEN: "   " } });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("PUT — a complete merged result is persisted", () => {
  it("accepts a save that supplies every required field at once", async () => {
    const res = await put("jira", { fields: COMPLETE });
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0]?.[2]).toMatchObject(COMPLETE);
  });

  it("accepts a save that COMPLETES an existing partial row", async () => {
    // The one path a partial row is still reachable by (a target's spec gaining
    // a required field after rows are stored) ends here: the admin supplies the
    // one missing field and the row goes complete. Refusing this would leave
    // them with DELETE and a full re-entry of credentials they cannot read.
    mockRead.mockResolvedValue({
      JIRA_BASE_URL: COMPLETE.JIRA_BASE_URL,
      JIRA_EMAIL: COMPLETE.JIRA_EMAIL,
    });
    const res = await put("jira", { fields: { JIRA_API_TOKEN: "the-missing-token" } });
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0]?.[2]).toMatchObject({
      ...COMPLETE,
      JIRA_API_TOKEN: "the-missing-token",
    });
  });

  it("accepts clearing an OPTIONAL field — all-or-nothing is about required ones", async () => {
    mockRead.mockResolvedValue({ ...COMPLETE, JIRA_DEFAULT_PROJECT: "TEN" });
    const res = await put("jira", { fields: {}, clearFields: ["JIRA_DEFAULT_PROJECT"] });
    expect(res.status).toBe(200);
    expect(mockSave.mock.calls[0]?.[2]).not.toHaveProperty("JIRA_DEFAULT_PROJECT");
  });

  it("returns the reshaped status, with no `configured` / `resolvedFrom`", async () => {
    mockRead.mockResolvedValue(null);
    // The status read after the save sees the persisted row.
    mockSave.mockImplementation(async (_ws, _target, bundle) => {
      mockRead.mockResolvedValue(bundle);
    });
    const res = await put("jira", { fields: COMPLETE });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("workspace");
    expect(body).not.toHaveProperty("configured");
    expect(body).not.toHaveProperty("resolvedFrom");
  });
});

describe("DELETE — the escape hatch is never gated on completeness", () => {
  it("clears a PARTIAL row", async () => {
    // Refusing the write without this would trap an admin inside the state the
    // write gate exists to prevent.
    mockRead.mockResolvedValue({ JIRA_BASE_URL: COMPLETE.JIRA_BASE_URL });
    const res = await adminActionCredentials.request("/jira", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("clears a COMPLETE row", async () => {
    mockRead.mockResolvedValue(COMPLETE);
    const res = await adminActionCredentials.request("/jira", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
