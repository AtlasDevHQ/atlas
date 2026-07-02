/**
 * Tests for mountBoth (#4202) — the single registration seam that replaces
 * the hand-written trailing-slash mount pairs in admin.ts / index.ts.
 *
 * Two layers:
 *   1. Unit — mountBoth registers a child at both `path` and `path + "/"`,
 *      with identical dispatch for every method, and rejects a path that
 *      already carries a trailing slash.
 *   2. Source-scan guard — the paired duplicates must not creep back: no
 *      trailing-slash mount paths remain in admin.ts / index.ts, and admin.ts
 *      registers sub-routers exclusively through mountBoth (a direct
 *      `admin.route(...)` is the half-registration footgun the helper exists
 *      to close).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { mountBoth } from "../mount";

function buildParent(): Hono {
  const child = new Hono();
  child.get("/", (c) => c.json({ hit: "root-get" }));
  child.post("/", (c) => c.json({ hit: "root-post" }));
  child.get("/items/:id", (c) => c.json({ hit: `item-${c.req.param("id")}` }));

  const parent = new Hono();
  mountBoth(parent, "/audit", child);
  return parent;
}

describe("mountBoth", () => {
  it("serves the child's root routes at both the bare path and the trailing-slash variant", async () => {
    const parent = buildParent();

    const bareGet = await parent.request("/audit");
    const slashGet = await parent.request("/audit/");
    expect(bareGet.status).toBe(200);
    expect(slashGet.status).toBe(200);
    expect(await bareGet.json()).toEqual(await slashGet.json());

    const barePost = await parent.request("/audit", { method: "POST" });
    const slashPost = await parent.request("/audit/", { method: "POST" });
    expect(barePost.status).toBe(200);
    expect(slashPost.status).toBe(200);
    expect(await barePost.json()).toEqual(await slashPost.json());
  });

  it("serves child sub-paths (unaffected by the pairing)", async () => {
    const parent = buildParent();
    const res = await parent.request("/audit/items/7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hit: "item-7" });
  });

  it("does not leak matches onto sibling prefixes", async () => {
    const parent = buildParent();
    expect((await parent.request("/auditx")).status).toBe(404);
    expect((await parent.request("/audi")).status).toBe(404);
  });

  it("rejects methods the child does not define, identically on both variants", async () => {
    const parent = buildParent();
    const bare = await parent.request("/audit", { method: "DELETE" });
    const slash = await parent.request("/audit/", { method: "DELETE" });
    expect(bare.status).toBe(404);
    expect(slash.status).toBe(bare.status);
  });

  it("throws at registration time when the path already ends with a trailing slash", () => {
    const parent = new Hono();
    const child = new Hono();
    expect(() => mountBoth(parent, "/audit/", child)).toThrow(/must not end with "\/"/);
    expect(() => mountBoth(parent, "/", child)).toThrow(/must not end with "\/"/);
  });
});

describe("trailing-slash mount pairs stay retired (#4202 source guard)", () => {
  const routesDir = path.resolve(import.meta.dir, "..");
  const adminSource = fs.readFileSync(path.join(routesDir, "admin.ts"), "utf-8");
  const indexSource = fs.readFileSync(
    path.resolve(routesDir, "..", "index.ts"),
    "utf-8",
  );

  // A mount whose quoted path ends with "/" (beyond a bare "/") is one half
  // of the old duplicate pattern — mountBoth registers that variant itself.
  const trailingSlashMount = /\.route\(\s*"[^"]+\/"/;

  it("admin.ts has no trailing-slash .route() mounts", () => {
    expect(adminSource).not.toMatch(trailingSlashMount);
  });

  it("index.ts has no trailing-slash .route() mounts", () => {
    expect(indexSource).not.toMatch(trailingSlashMount);
  });

  it("admin.ts registers sub-routers only via mountBoth — a direct admin.route() can be half-registered with no signal", () => {
    expect(adminSource).not.toMatch(/admin\.route\(/);
  });

  it("mountBoth call sites in admin.ts cover the full sub-router surface", () => {
    const count = (adminSource.match(/mountBoth\(admin, "/g) ?? []).length;
    // 49 static mounts + marketplace + semantic-improve. A drop below the
    // floor means mounts were converted back to raw .route() calls (or the
    // registration seam moved) — update this test alongside such a change.
    expect(count).toBeGreaterThanOrEqual(45);
  });
});
