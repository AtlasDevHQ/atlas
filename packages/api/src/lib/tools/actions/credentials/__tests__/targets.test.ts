/**
 * Action target registry tests (#3766, #5554).
 *
 * The registry is the one-entry seam the remaining action targets (GitHub App,
 * Salesforce) extend, so the first block pins the invariants a new entry has to
 * keep — not just the shape of the entries present today. The per-target blocks
 * below pin what is specific to each.
 */

import { describe, expect, it } from "bun:test";
import { ACTION_TARGETS, getActionTarget } from "../targets";

describe("ACTION_TARGETS — registry invariants", () => {
  it("every target slug is unique", () => {
    const slugs = ACTION_TARGETS.map((t) => t.target);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every target declares at least one required field", () => {
    // A target with no required field would resolve as "configured" from an
    // empty row, which the resolver would then hand to an action as a
    // complete credential set.
    for (const target of ACTION_TARGETS) {
      expect(target.fields.some((f) => f.required)).toBe(true);
    }
  });

  it("every field name is unique within its target", () => {
    for (const target of ACTION_TARGETS) {
      const names = target.fields.map((f) => f.envVar);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("every field has a non-empty label and hint for the Admin form", () => {
    for (const target of ACTION_TARGETS) {
      for (const field of target.fields) {
        expect(field.label.length).toBeGreaterThan(0);
        expect(field.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it("every target marks at least one field secret", () => {
    // An action target with no secret at all would mean Atlas is dispatching
    // to a tenant system unauthenticated — worth failing loudly on.
    for (const target of ACTION_TARGETS) {
      expect(target.fields.some((f) => f.secret)).toBe(true);
    }
  });
});

describe("Jira — the pilot target", () => {
  const jira = getActionTarget("jira");

  it("is registered", () => {
    expect(jira).toBeDefined();
  });

  it("declares exactly the three globals the action used to read, plus the optional default", () => {
    // Keeping the same env-var NAMES is what makes the self-host rung a no-op
    // change for an existing operator — the resolver reads them straight.
    expect(jira?.fields.filter((f) => f.required).map((f) => f.envVar)).toEqual([
      "JIRA_BASE_URL",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
    ]);
    expect(jira?.fields.find((f) => f.envVar === "JIRA_DEFAULT_PROJECT")?.required).toBe(false);
  });

  it("marks only the API token secret", () => {
    expect(jira?.fields.filter((f) => f.secret).map((f) => f.envVar)).toEqual([
      "JIRA_API_TOKEN",
    ]);
  });
});

describe("Linear — the first target added on the seam (#5554)", () => {
  const linear = getActionTarget("linear");

  it("is registered", () => {
    expect(linear).toBeDefined();
  });

  it("requires the API key and nothing else", () => {
    // Two fields against Jira's four: Linear's endpoint is a fixed GraphQL URL
    // (no per-tenant base URL) and the key identifies the actor (no account
    // email). A field added here without a matching read in `linear.ts` would
    // show up in the Admin form as a credential that does nothing.
    expect(linear?.fields.filter((f) => f.required).map((f) => f.envVar)).toEqual([
      "LINEAR_API_KEY",
    ]);
  });

  it("keeps the default team key optional", () => {
    // Same standing as JIRA_DEFAULT_PROJECT: the agent may name a team per
    // call, so a workspace that sets only the key is fully configured.
    expect(
      linear?.fields.find((f) => f.envVar === "LINEAR_DEFAULT_TEAM_KEY")?.required,
    ).toBe(false);
  });

  it("marks only the API key secret", () => {
    expect(linear?.fields.filter((f) => f.secret).map((f) => f.envVar)).toEqual([
      "LINEAR_API_KEY",
    ]);
  });

  it("does not collide with the Linear INTEGRATION install's storage", () => {
    // ADR-0046: the query plugin's OAuth bundle lives in
    // `integration_credentials` keyed by catalog id; this target is keyed
    // `(workspace_id, "linear")` in `workspace_action_credentials`. The slug
    // being the plain platform name is fine precisely because the two tables
    // are separate — but the field names must not be the install's, or a
    // future shared helper would look plausible.
    expect(linear?.target).toBe("linear");
    expect(linear?.fields.map((f) => f.envVar)).not.toContain("api_key");
  });
});
