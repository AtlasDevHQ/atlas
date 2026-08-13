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
import { groupPermissions, offerablePermissions } from "../page";

// ⚠️ This IS a hand-copied list, and an earlier version of this comment claimed
// the opposite directly above it. Stating the constraint honestly instead:
// `PERMISSIONS` lives in `packages/api/src/lib/auth/permissions.ts` and is
// exported from no published package, and the web package speaks HTTP rather
// than importing from `@atlas/api` — so it genuinely cannot be reached here.
//
// Drift is therefore possible and DELIBERATELY SAFE: `groupPermissions` is
// driven by the server's list, so a flag this copy has never heard of still
// reaches the editor via "Other" — which is what the third test pins, and which
// is the real guarantee. This literal only fixes the input to the other cases.
// Making the copy unnecessary means promoting `PERMISSIONS` to
// `@useatlas/types` alongside `ATLAS_ROLES`; filed as follow-up.
const PERMISSIONS = [
  "query",
  "query:raw_data",
  "dashboards:read",
  "dashboards:write",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
];

describe("groupPermissions", () => {
  it("offers every server-known permission exactly once", () => {
    const offered = groupPermissions(PERMISSIONS).flatMap(([, perms]) => perms);
    expect(offered.sort()).toEqual([...PERMISSIONS].sort());
  });

  it("puts the dashboards pair in its own group", () => {
    const groups = Object.fromEntries(groupPermissions(PERMISSIONS));
    expect(groups["Dashboards"]).toEqual(["dashboards:read", "dashboards:write"]);
  });

  it("collects an unrecognised flag under Other rather than dropping it", () => {
    // The failure mode this replaces, driven directly: a flag the server ships
    // and this file has never heard of.
    const groups = Object.fromEntries(
      groupPermissions([...PERMISSIONS, "reports:export"]),
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
    expect(offerablePermissions(PERMISSIONS)).toEqual(PERMISSIONS);
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
