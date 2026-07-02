/**
 * Behavioral pin for #4202 — every admin sub-router mount answers identically
 * with and without a trailing slash.
 *
 * The mount list is extracted from admin.ts source (the mountBoth call sites)
 * rather than hardcoded, so a newly added sub-router is covered automatically.
 * For each mount path the real admin router is driven twice — `GET <path>` and
 * `GET <path>/` — and the two responses must carry the same status. The
 * assertion is equality (not a specific code): some sub-router roots have no
 * GET route (404 on both), others answer 200/4xx under the unified mocks —
 * either way the slash variant may never diverge, which is exactly the bug
 * class the old hand-written pairs allowed (`/organizations` shipped bare-only
 * before this refactor).
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

function request(p: string) {
  return app.request(`http://localhost${p}`);
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
    for (const mountPath of mountPaths) {
      const bare = await request(`/api/v1/admin${mountPath}`);
      const slash = await request(`/api/v1/admin${mountPath}/`);
      expect({ path: mountPath, status: slash.status }).toEqual({
        path: mountPath,
        status: bare.status,
      });
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
