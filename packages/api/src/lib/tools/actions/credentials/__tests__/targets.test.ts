/**
 * Action target registry tests (#3766).
 *
 * The registry is the one-entry seam the remaining action targets (Linear,
 * GitHub App, Salesforce) extend, so these pin the invariants a new entry has
 * to keep — not just Jira's current shape.
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

describe("Salesforce — the first one-entry child (#5556)", () => {
  const salesforce = getActionTarget("salesforce");

  it("is registered", () => {
    expect(salesforce).toBeDefined();
  });

  it("declares the three client-credentials fields, plus the optional default object", () => {
    expect(salesforce?.fields.filter((f) => f.required).map((f) => f.envVar)).toEqual([
      "SALESFORCE_ACTION_INSTANCE_URL",
      "SALESFORCE_ACTION_CLIENT_ID",
      "SALESFORCE_ACTION_CLIENT_SECRET",
    ]);
    expect(
      salesforce?.fields.find((f) => f.envVar === "SALESFORCE_ACTION_DEFAULT_OBJECT")?.required,
    ).toBe(false);
  });

  it("marks only the consumer secret secret", () => {
    // Same convention as the operator tier: client IDs are not secret,
    // client secrets are.
    expect(salesforce?.fields.filter((f) => f.secret).map((f) => f.envVar)).toEqual([
      "SALESFORCE_ACTION_CLIENT_SECRET",
    ]);
  });

  it("shares no env-var name with the datasource connected-app pair", () => {
    // `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` / `SALESFORCE_LOGIN_URL`
    // are the OPERATOR's app for the datasource OAuth dance (ADR-0014) — a
    // different grant that cannot create a record in a tenant's org. Sharing a
    // name would make the self-host env rung report this target "configured"
    // out of credentials the action can never authenticate with.
    const datasourceEnv = [
      "SALESFORCE_CLIENT_ID",
      "SALESFORCE_CLIENT_SECRET",
      "SALESFORCE_LOGIN_URL",
    ];
    for (const field of salesforce?.fields ?? []) {
      expect(datasourceEnv).not.toContain(field.envVar);
    }
  });
});
