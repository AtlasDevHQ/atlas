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

  it("no env-var name is claimed by two different targets", () => {
    // Two targets sharing a key would make the self-host env rung ambiguous —
    // one operator value would arm both, and clearing it would disarm both.
    const seen = new Map<string, string>();
    for (const target of ACTION_TARGETS) {
      for (const field of target.fields) {
        const owner = seen.get(field.envVar);
        expect(
          owner,
          `${field.envVar} is declared by both "${owner}" and "${target.target}"`,
        ).toBeUndefined();
        seen.set(field.envVar, target.target);
      }
    }
  });

  it("only secret fields are marked multiline, and multiline is opt-in", () => {
    // Not a law of nature — a check that the attribute stays the narrow
    // presentational hint #5555 introduced (a pasted PEM) rather than drifting
    // into a general "big text field" flag on ordinary config.
    for (const target of ACTION_TARGETS) {
      for (const field of target.fields) {
        // Opt-in: a single-line field says nothing rather than `false`, so the
        // registry reads as "GITHUB_ACTION_PRIVATE_KEY is the odd one".
        if (field.multiline !== undefined) expect(field.multiline).toBe(true);
        if (field.multiline) expect(field.secret).toBe(true);
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

describe("GitHub — the App target (#5555)", () => {
  const github = getActionTarget("github");

  it("is registered", () => {
    expect(github).toBeDefined();
  });

  it("requires the three App fields and leaves the default repo optional", () => {
    expect(github?.fields.filter((f) => f.required).map((f) => f.envVar)).toEqual([
      "GITHUB_ACTION_APP_ID",
      "GITHUB_ACTION_INSTALLATION_ID",
      "GITHUB_ACTION_PRIVATE_KEY",
    ]);
    expect(
      github?.fields.find((f) => f.envVar === "GITHUB_ACTION_DEFAULT_REPO")?.required,
    ).toBe(false);
  });

  it("marks only the private key secret, and marks it multiline", () => {
    // The App id and installation id are public identifiers — masking them
    // would only stop an admin checking they typed the right ones.
    expect(github?.fields.filter((f) => f.secret).map((f) => f.envVar)).toEqual([
      "GITHUB_ACTION_PRIVATE_KEY",
    ]);
    expect(github?.fields.filter((f) => f.multiline).map((f) => f.envVar)).toEqual([
      "GITHUB_ACTION_PRIVATE_KEY",
    ]);
  });

  it("claims no `GITHUB_APP_*` name the operator-tier App already reads", () => {
    // `lib/github/installation-token.ts` reads GITHUB_APP_ID and
    // GITHUB_APP_PRIVATE_KEY for ATLAS's own App. Reusing either name here
    // would make this workspace-tier target's self-host rung read the operator
    // tier's registration — the coupling ADR-0046 keeps structural.
    for (const field of github?.fields ?? []) {
      expect(field.envVar.startsWith("GITHUB_APP_")).toBe(false);
    }
  });
});
