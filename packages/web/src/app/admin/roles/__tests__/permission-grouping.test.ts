/**
 * #5189 — every permission the server offers must be reachable in the role
 * editor.
 *
 * The editor renders checkboxes by iterating a hardcoded group map, so before
 * this the map WAS the set of grantable flags: a flag the API returned but the
 * map omitted was simply not offered, with no error and no empty state. That is
 * how the dashboards pair shipped ungrantable — the API listed them, the dialog
 * did not, and an EE admin had no way to author a dashboard-capable role.
 *
 * `groupPermissions` now takes the server's list as the source of truth. These
 * tests are the tripwire for the class: adding a flag without giving it a home
 * still works (it lands in "Other"), and dropping one from the API stops
 * offering it. What can no longer happen is a server flag that appears nowhere.
 */

import { describe, it, expect } from "bun:test";
import { groupPermissions, offerablePermissions, permissionLabel } from "../page";

/**
 * ⚠️ STILL a hand-copy, and #5191 tried to remove it. Stating the constraint
 * honestly rather than pretending otherwise:
 *
 * `PERMISSIONS` lives in `packages/api/src/lib/auth/permissions.ts` and the web
 * speaks HTTP rather than importing from `@atlas/api`, so it genuinely cannot
 * be reached here. The fix is to promote it to `@useatlas/types` beside
 * `ATLAS_ROLES` — which was implemented, and then REVERTED: `create-atlas`
 * builds `packages/api` against the PUBLISHED `@useatlas/types`, so the api's
 * re-export failed Deploy Validation (a required check) with
 * `Export PERMISSIONS doesn't exist in target module`. The move is gated on a
 * `/publish` of that package landing first; tracked as a follow-up.
 *
 * Drift is therefore possible and DELIBERATELY SAFE: `groupPermissions` is
 * driven by the SERVER's list, so a flag this copy has never heard of still
 * reaches the editor via "Other" — which the "unrecognised flag" test pins, and
 * which is the real guarantee. This literal only fixes the input to the other
 * cases.
 */
const ALL = [
  "query",
  "query:raw_data",
  "dashboards:read",
  "dashboards:write",
  // #5192 — the third dashboards flag.
  "dashboards:share",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
];

describe("groupPermissions", () => {
  it("offers every server-known permission exactly once", () => {
    const offered = groupPermissions(ALL).flatMap(([, perms]) => perms);
    expect(offered.sort()).toEqual([...ALL].sort());
  });

  it("puts all three dashboards flags in their own group", () => {
    const groups = Object.fromEntries(groupPermissions(ALL));
    expect(groups["Dashboards"]).toEqual([
      "dashboards:read",
      "dashboards:write",
      // #5192 — grantable in the editor, or an EE admin has no way to author a
      // role that can publish a public link and the flag is admin-only by
      // accident of the UI rather than by decision.
      "dashboards:share",
    ]);
  });

  it("labels every flag the server can send", () => {
    // #5191 — `PERMISSION_LABELS` is now exhaustive over `Permission` at the
    // TYPE level, which catches a missing label at build time. This is the
    // runtime half: it proves the labels are real copy rather than the raw id
    // the `?? p` fallback would render, which type-checks perfectly.
    for (const p of ALL) {
      expect(permissionLabel(p), `${p} has no label`).not.toBe(p);
      expect(permissionLabel(p).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw id for a flag this build has never heard of", () => {
    // The other side of the same coin — a newer server must not render blank.
    expect(permissionLabel("reports:export")).toBe("reports:export");
  });

  it("returns a STRING for a prototype key, not a Function or an Object", () => {
    // ⚠️ The label map is looked up through a `Map`, not by indexing the object
    // literal. Indexed, `permissionLabel("toString")` returned a **Function**
    // and `"__proto__"` an **Object** — past a `?? p` fallback that can never
    // fire for an inherited key — from a function declaring `: string`. React
    // then throws "Objects are not valid as a React child" and takes out the
    // whole roles page instead of rendering an unknown badge.
    //
    // `permissions` is a free string from a `custom_roles` row, so this is
    // reachable by data, not only by a hostile server. Same class as the
    // prototype hole `permission-resolve.ts` closed with a Map.
    for (const key of ["toString", "constructor", "__proto__", "valueOf"]) {
      expect(typeof permissionLabel(key), `${key} did not return a string`).toBe("string");
      expect(permissionLabel(key)).toBe(key);
    }
  });

  it("collects an unrecognised flag under Other rather than dropping it", () => {
    // The failure mode this replaces, driven directly: a flag the server ships
    // and this file has never heard of.
    const groups = Object.fromEntries(
      groupPermissions([...ALL, "reports:export"]),
    );
    expect(groups["Other"]).toEqual(["reports:export"]);
  });

  it("omits a group whose flags the server does not offer", () => {
    // Self-hosted without EE may return a narrower list; an empty "Dashboards"
    // heading with no checkboxes under it is chrome, not information.
    const groups = Object.fromEntries(groupPermissions(["query"]));
    expect(groups["Dashboards"]).toBeUndefined();
    expect(groups["Data Access"]).toEqual(["query"]);
  });

  it("returns nothing for an empty server list", () => {
    expect(groupPermissions([])).toEqual([]);
  });
});

describe("offerablePermissions — no client-side substitute for the server list", () => {
  it("returns the server's list when it arrived", () => {
    expect(offerablePermissions(ALL)).toEqual(ALL);
  });

  it("returns EMPTY when the fetch has not landed or failed", () => {
    // The regression this pins: the fallback used to be
    // `Object.keys(PERMISSION_LABELS)`, so a failed fetch silently offered a
    // hardcoded list and an admin authored a role from stale data with no
    // signal. Empty is what makes the editor degrade to an explicit empty
    // state instead of a confident wrong one.
    expect(offerablePermissions(undefined)).toEqual([]);
  });

  it("an empty offer groups to nothing, so the editor has nothing to show", () => {
    expect(groupPermissions(offerablePermissions(undefined))).toEqual([]);
  });
});
