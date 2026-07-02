/**
 * Behavioral pin for #4202 — every admin sub-router mount answers identically
 * with and without a trailing slash.
 *
 * The mount list is extracted from admin.ts source (the mountBoth call sites)
 * rather than hardcoded, so a newly added sub-router is covered automatically.
 * For each mount path the real admin router is driven with several methods, at
 * both `<path>` and `<path>/`, and the two responses must carry the same status
 * per method. The assertion is equality (not a specific code): some roots have
 * no root route (404 on both), so a GET-only probe would pass vacuously as
 * `404 === 404` for the POST-style action roots (`/archive-connection`,
 * `/restore-connection`, …). Probing GET **and** POST means each such root is
 * exercised by a method its handler actually answers, so the parity assertion
 * observes a real (non-404) response rather than the trivial 404 pair — which
 * is exactly the divergence the old hand-written pairs allowed (`/organizations`
 * shipped bare-only before this refactor).
 *
 * Structural completeness — that a mount can never be *half*-registered in the
 * first place — is enforced separately by the source-scan guard in
 * routes/__tests__/mount.test.ts (no bare `admin.route(`); this file pins the
 * runtime behavior for the roots that answer at `/`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
  },
});

// --- Import the router AFTER mocks ---

const { admin } = await import("../routes/admin");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/admin", admin);

function request(p: string, method = "GET") {
  return app.request(`http://localhost${p}`, { method });
}

const adminSource = fs.readFileSync(
  path.resolve(import.meta.dir, "..", "routes", "admin.ts"),
  "utf-8",
);
const mountPaths = [...adminSource.matchAll(/mountBoth\(admin, "([^"]+)"/g)].map(
  (m) => m[1]!,
);

afterAll(() => {
  mocks.cleanup();
});

describe("admin sub-router mounts — trailing-slash parity (#4202)", () => {
  it("extracts the mount list from admin.ts (guards against a rotted regex)", () => {
    expect(mountPaths.length).toBeGreaterThanOrEqual(45);
    expect(mountPaths).toContain("/organizations");
    expect(mountPaths).toContain("/audit");
  });

  it("every mount answers with the same status with and without a trailing slash", async () => {
    // Probe GET and POST: a GET-only probe passes vacuously (404 === 404) for
    // the POST-style action roots, which have no root GET handler. POST hits
    // their real handler, so the parity assertion observes a non-404 response.
    for (const mountPath of mountPaths) {
      for (const method of ["GET", "POST"]) {
        const bare = await request(`/api/v1/admin${mountPath}`, method);
        const slash = await request(`/api/v1/admin${mountPath}/`, method);
        expect({ path: mountPath, method, status: slash.status }).toEqual({
          path: mountPath,
          method,
          status: bare.status,
        });
      }
    }
  });

  it("/organizations (the previously half-registered mount) resolves on both variants", async () => {
    // Before #4202 the trailing-slash variant was never registered, so
    // GET /organizations/ 404'd while GET /organizations resolved.
    const bare = await request("/api/v1/admin/organizations");
    const slash = await request("/api/v1/admin/organizations/");
    expect(bare.status).not.toBe(404);
    expect(slash.status).toBe(bare.status);
  });
});
