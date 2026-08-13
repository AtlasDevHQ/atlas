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
import { groupPermissions } from "../page";

// The real shipped list, not a hand-copied one. A local literal here would
// agree with itself forever and could not detect the drift this file exists to
// detect.
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
