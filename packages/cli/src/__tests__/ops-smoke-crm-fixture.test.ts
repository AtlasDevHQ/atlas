/**
 * Unit tests for the persona fixture parser.
 *
 * The fixture is operator-authored, so the tests focus on:
 *  - Happy path: every LeadEvent variant round-trips correctly.
 *  - Error path: every required-field omission and unknown-source case
 *    surfaces a per-persona-indexed error (not a generic schema blob).
 *  - The shipped default fixture (`scripts/test-fixtures/crm-personas.yml`)
 *    matches the coverage matrix declared in issue #2866.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FixtureParseError,
  loadFixture,
  parseFixtureYaml,
} from "../../lib/smoke-crm/fixture";

describe("parseFixtureYaml — happy path", () => {
  test("parses a sales-form persona with all fields", () => {
    const yaml = `
personas:
  - source: sales-form
    email: alice@example.com
    name: Alice Anderson
    company: Acme Corp
    planInterest: Pro
    message: |
      Multi-line
      message body.
    ip: 1.2.3.4
`;
    const events = parseFixtureYaml(yaml);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "sales-form",
      email: "alice@example.com",
      name: "Alice Anderson",
      company: "Acme Corp",
      planInterest: "Pro",
      ip: "1.2.3.4",
      userAgent: null,
    });
    // js-yaml's literal block scalar (`|`) chomping keeps interior newlines;
    // exact trailing-newline behaviour depends on the chomp indicator and the
    // trailing-line presence, so we assert on substrings rather than equality.
    const msg = (events[0] as Extract<typeof events[0], { source: "sales-form" }>).message;
    expect(msg).toContain("Multi-line");
    expect(msg).toContain("message body.");
  });

  test("parses a demo persona with optional ip omitted", () => {
    const yaml = `
personas:
  - source: demo
    email: bob@example.com
`;
    const events = parseFixtureYaml(yaml);
    expect(events[0]).toEqual({
      source: "demo",
      email: "bob@example.com",
      ip: null,
      userAgent: null,
    });
  });

  test("parses a signup persona; name is optional", () => {
    const yamlNoName = `
personas:
  - source: signup
    email: carol@example.com
`;
    const events = parseFixtureYaml(yamlNoName);
    expect(events[0]).toEqual({ source: "signup", email: "carol@example.com" });

    const yamlWithName = `
personas:
  - source: signup
    email: dan@example.com
    name: Dan Davies
`;
    const events2 = parseFixtureYaml(yamlWithName);
    expect(events2[0]).toEqual({
      source: "signup",
      email: "dan@example.com",
      name: "Dan Davies",
    });
  });

  test("parses a conversion persona", () => {
    const yaml = `
personas:
  - source: conversion
    email: eve@example.com
    stripeCustomerId: cus_test_xyz
`;
    const events = parseFixtureYaml(yaml);
    expect(events[0]).toEqual({
      source: "conversion",
      email: "eve@example.com",
      stripeCustomerId: "cus_test_xyz",
    });
  });
});

describe("parseFixtureYaml — error paths", () => {
  test("rejects empty personas array", () => {
    expect(() => parseFixtureYaml(`personas: []`)).toThrow(/at least one persona/);
  });

  test("rejects missing personas key", () => {
    expect(() => parseFixtureYaml(`foo: bar`)).toThrow(/personas/);
  });

  test("rejects non-string source", () => {
    const yaml = `
personas:
  - source: 42
    email: x@y.com
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(/persona\[0\].*source/);
  });

  test("rejects unknown source — error message lists the valid set", () => {
    const yaml = `
personas:
  - source: webhook
    email: x@y.com
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(
      /persona\[0\].*unknown source "webhook".*sales-form, demo, signup, conversion/,
    );
  });

  test("error message includes the persona index for late personas", () => {
    // Catches a regression where the index resets per-persona.
    const yaml = `
personas:
  - source: demo
    email: a@b.com
  - source: demo
    email: c@d.com
  - source: sales-form
    email: e@f.com
    # missing name / company / planInterest / message
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(/persona\[2\]/);
  });

  test("sales-form requires every field — name", () => {
    const yaml = `
personas:
  - source: sales-form
    email: x@y.com
    company: A
    planInterest: Pro
    message: hi
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(/persona\[0\].*name/);
  });

  test("sales-form rejects empty-string fields", () => {
    // Empty strings would be uselessly written to Twenty Person.name —
    // catch them at the parser rather than letting the dispatcher PATCH
    // an empty name over an existing one.
    const yaml = `
personas:
  - source: sales-form
    email: x@y.com
    name: "  "
    company: A
    planInterest: Pro
    message: hi
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(/persona\[0\].*name/);
  });

  // The remaining error-path tests below pin every required field for every
  // variant. Closes pr-test-analyzer G4 — without these, a future refactor
  // that drops a required field from one variant ships green.

  test.each([
    ["company", "personas:\n  - source: sales-form\n    email: x@y.com\n    name: A B\n    planInterest: Pro\n    message: hi\n"],
    ["planInterest", "personas:\n  - source: sales-form\n    email: x@y.com\n    name: A B\n    company: Co\n    message: hi\n"],
    ["message", "personas:\n  - source: sales-form\n    email: x@y.com\n    name: A B\n    company: Co\n    planInterest: Pro\n"],
    ["email", "personas:\n  - source: sales-form\n    name: A B\n    company: Co\n    planInterest: Pro\n    message: hi\n"],
  ])("sales-form requires %s", (field, yaml) => {
    expect(() => parseFixtureYaml(yaml)).toThrow(new RegExp(`persona\\[0\\].*${field}`));
  });

  test("demo requires email", () => {
    expect(() => parseFixtureYaml(`personas:\n  - source: demo\n`)).toThrow(
      /persona\[0\].*email/,
    );
  });

  test("signup requires email", () => {
    expect(() => parseFixtureYaml(`personas:\n  - source: signup\n    name: Alice\n`)).toThrow(
      /persona\[0\].*email/,
    );
  });

  test("conversion requires stripeCustomerId", () => {
    // The variant exists in the parser today even though the default fixture
    // doesn't ship one yet (parked behind Stripe test-fixture wiring per
    // #2866). When that ships, this guard catches a drop of stripeCustomerId.
    expect(
      () => parseFixtureYaml(`personas:\n  - source: conversion\n    email: x@y.com\n`),
    ).toThrow(/persona\[0\].*stripeCustomerId/);
  });

  test("conversion requires email", () => {
    expect(
      () => parseFixtureYaml(`personas:\n  - source: conversion\n    stripeCustomerId: cus_x\n`),
    ).toThrow(/persona\[0\].*email/);
  });

  test("optionalString rejects non-string values (e.g. YAML coerces unquoted numerics)", () => {
    // YAML autoescapes `ip: 12345` into a JS number. Without the guard, the
    // parser would silently coerce it to "12345" — masking the operator's
    // likely typo (intended quoted IP literal).
    const yaml = `
personas:
  - source: demo
    email: x@y.com
    ip: 12345
`;
    expect(() => parseFixtureYaml(yaml)).toThrow(/persona\[0\].*ip.*must be a string/);
  });

  test("YAML syntax error surfaces with the file context", () => {
    expect(() => parseFixtureYaml(`personas: [\n  not closed`)).toThrow(FixtureParseError);
  });
});

describe("loadFixture — default fixture coverage matrix", () => {
  const fixturePath = resolve(
    import.meta.dir,
    "../../../../scripts/test-fixtures/crm-personas.yml",
  );

  test("default fixture exists and parses cleanly", () => {
    // Sanity — the shipped fixture must always parse, regardless of edits.
    const text = readFileSync(fixturePath, "utf-8");
    expect(() => parseFixtureYaml(text)).not.toThrow();
  });

  test("default fixture matches the issue #2866 coverage matrix", () => {
    // 4 sales-form + 1 demo + 1 signup + 2 (demo→signup) + 2 (demo→demo) = 10
    const events = loadFixture(fixturePath);
    expect(events).toHaveLength(10);
    const counts = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.source] = (acc[e.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["sales-form"]).toBe(4);
    expect(counts.demo).toBe(4); // 1 standalone + 1 (stickiness pair) + 2 (idempotency pair)
    expect(counts.signup).toBe(2); // 1 standalone + 1 (stickiness pair)
    expect(counts.conversion).toBeUndefined();
  });

  test("default fixture has a demo→signup stickiness pair on the same email", () => {
    const events = loadFixture(fixturePath);
    const pairs = new Map<string, string[]>();
    for (const e of events) {
      const sources = pairs.get(e.email) ?? [];
      sources.push(e.source);
      pairs.set(e.email, sources);
    }
    const stickinessPairs = [...pairs.values()].filter(
      (sources) => sources.length === 2 && sources[0] === "demo" && sources[1] === "signup",
    );
    expect(stickinessPairs).toHaveLength(1);
  });

  test("default fixture has a demo→demo idempotency pair on the same email", () => {
    const events = loadFixture(fixturePath);
    const pairs = new Map<string, string[]>();
    for (const e of events) {
      const sources = pairs.get(e.email) ?? [];
      sources.push(e.source);
      pairs.set(e.email, sources);
    }
    const idempotencyPairs = [...pairs.values()].filter(
      (sources) => sources.length === 2 && sources[0] === "demo" && sources[1] === "demo",
    );
    expect(idempotencyPairs).toHaveLength(1);
  });

  test("default fixture matches PR #2865 comment thread company list", () => {
    // The companies are pinned so manual smoke and automated smoke converge
    // on the same dataset — operators can spot-check Twenty against this
    // list. A future PR adding personas should extend, not replace.
    const events = loadFixture(fixturePath);
    const companies = events
      .filter((e): e is Extract<typeof e, { source: "sales-form" }> => e.source === "sales-form")
      .map((e) => e.company);
    expect(companies.sort()).toEqual(
      ["Initech", "Massive Dynamic", "Veridian Dynamics", "ENCOM"].sort(),
    );
  });
});

describe("loadFixture — file errors", () => {
  test("missing file surfaces an actionable FixtureParseError", () => {
    expect(() => loadFixture("/nonexistent/path/personas.yml")).toThrow(
      /cannot read fixture file/,
    );
  });
});
