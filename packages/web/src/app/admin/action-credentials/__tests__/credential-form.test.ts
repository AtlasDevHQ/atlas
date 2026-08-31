import { describe, expect, test } from "bun:test";
import {
  ActionCredentialsResponseSchema,
  EMPTY_DRAFT,
  buildUpdatePayload,
  fieldPlaceholder,
  isDraftDirty,
  mayHaveStoredRow,
  missingRequiredFields,
  requiredFieldsUnsatisfied,
  setValue,
  summarizeTarget,
  toggleCleared,
  type FieldStatus,
  type TargetStatus,
} from "../credential-form";

/**
 * The PUT contract this page rides has one rule that is easy to break and
 * expensive when broken: a BLANK field preserves the stored secret rather than
 * clearing it. An admin editing only a base URL must not lose the API token
 * they cannot see. These pin that, plus the `clearFields` escape hatch that is
 * the only way to unset a stored value.
 *
 * Every fixture is a SYNTHETIC target. Nothing here mentions `jira`, because
 * the page has no per-target branches (#3766's seam) and a test that asserted
 * against the pilot target would pass just as well if it did.
 */

function field(over: Partial<FieldStatus> & { envVar: string }): FieldStatus {
  return {
    label: over.envVar,
    hint: "",
    secret: false,
    required: false,
    multiline: false,
    present: false,
    source: "unset",
    ...over,
  };
}

const TARGET: TargetStatus = {
  target: "widgetron",
  label: "Widgetron",
  configured: true,
  resolvedFrom: "workspace",
  fields: [
    field({ envVar: "WIDGETRON_URL", label: "Base URL", required: true, present: true, source: "workspace" }),
    field({ envVar: "WIDGETRON_TOKEN", label: "Token", required: true, secret: true, present: true, source: "workspace" }),
    field({ envVar: "WIDGETRON_PROJECT", label: "Project" }),
  ],
};

describe("buildUpdatePayload", () => {
  test("omits blank fields so a stored secret survives a partial edit", () => {
    const draft = setValue(EMPTY_DRAFT, "WIDGETRON_URL", "https://widgets.acme.dev");

    expect(buildUpdatePayload(draft)).toEqual({
      fields: { WIDGETRON_URL: "https://widgets.acme.dev" },
    });
  });

  test("a whitespace-only value counts as blank, not as a value", () => {
    const draft = setValue(EMPTY_DRAFT, "WIDGETRON_TOKEN", "   ");

    expect(buildUpdatePayload(draft)).toEqual({ fields: {} });
  });

  test("trims what it does send", () => {
    const draft = setValue(EMPTY_DRAFT, "WIDGETRON_TOKEN", "  tok_abc  ");

    expect(buildUpdatePayload(draft)).toEqual({ fields: { WIDGETRON_TOKEN: "tok_abc" } });
  });

  test("omits clearFields entirely when nothing is marked for removal", () => {
    const payload = buildUpdatePayload(setValue(EMPTY_DRAFT, "WIDGETRON_URL", "x"));

    expect(payload.clearFields).toBeUndefined();
  });

  test("a cleared field goes to clearFields", () => {
    const draft = toggleCleared(EMPTY_DRAFT, "WIDGETRON_PROJECT", true);

    expect(buildUpdatePayload(draft)).toEqual({ fields: {}, clearFields: ["WIDGETRON_PROJECT"] });
  });

  test("a field both typed into and cleared is sent only as a removal", () => {
    // The route applies removals after the merge, so sending both would
    // discard the typed value silently. The payload states one intent.
    const draft = toggleCleared(
      setValue(EMPTY_DRAFT, "WIDGETRON_PROJECT", "ACME"),
      "WIDGETRON_PROJECT",
      true,
    );

    expect(buildUpdatePayload(draft)).toEqual({ fields: {}, clearFields: ["WIDGETRON_PROJECT"] });
  });

  test("un-marking a clear removes it from the payload", () => {
    const draft = toggleCleared(
      toggleCleared(EMPTY_DRAFT, "WIDGETRON_PROJECT", true),
      "WIDGETRON_PROJECT",
      false,
    );

    expect(buildUpdatePayload(draft)).toEqual({ fields: {} });
  });

  test("marking the same field twice does not duplicate it", () => {
    const draft = toggleCleared(
      toggleCleared(EMPTY_DRAFT, "WIDGETRON_PROJECT", true),
      "WIDGETRON_PROJECT",
      true,
    );

    expect(buildUpdatePayload(draft).clearFields).toEqual(["WIDGETRON_PROJECT"]);
  });
});

describe("isDraftDirty", () => {
  test("an untouched draft is clean, so Save cannot fire a no-op PUT", () => {
    expect(isDraftDirty(EMPTY_DRAFT)).toBe(false);
  });

  test("a blanked-out field is still clean", () => {
    const draft = setValue(setValue(EMPTY_DRAFT, "WIDGETRON_URL", "typed"), "WIDGETRON_URL", "");

    expect(isDraftDirty(draft)).toBe(false);
  });

  test("a typed value is dirty", () => {
    expect(isDraftDirty(setValue(EMPTY_DRAFT, "WIDGETRON_URL", "x"))).toBe(true);
  });

  test("a clear with nothing typed is dirty — removal is a change", () => {
    expect(isDraftDirty(toggleCleared(EMPTY_DRAFT, "WIDGETRON_PROJECT", true))).toBe(true);
  });
});

describe("summarizeTarget", () => {
  test("a workspace-resolved target reads as configured", () => {
    const summary = summarizeTarget(TARGET, "saas");

    expect(summary.tone).toBe("configured");
    expect(summary.detail).toContain("this workspace");
  });

  test("an env-resolved target names the environment rung (criterion 3)", () => {
    const summary = summarizeTarget(
      { ...TARGET, resolvedFrom: "env", fields: TARGET.fields.map((f) => ({ ...f, source: "env" as const })) },
      "self-hosted",
    );

    expect(summary.tone).toBe("environment");
    expect(summary.detail).toContain("environment variables");
  });

  test("unconfigured on self-hosted explains the all-or-nothing rung rule", () => {
    const summary = summarizeTarget(
      { ...TARGET, configured: false, resolvedFrom: null, fields: TARGET.fields.map((f) => ({ ...f, present: false, source: "unset" as const })) },
      "self-hosted",
    );

    expect(summary.tone).toBe("unconfigured");
    expect(summary.detail).toContain("environment variables");
    expect(summary.detail).toContain("all-or-nothing");
  });

  test("unconfigured on SaaS never mentions environment variables — that rung does not exist", () => {
    const summary = summarizeTarget(
      { ...TARGET, configured: false, resolvedFrom: null, fields: TARGET.fields.map((f) => ({ ...f, present: false, source: "unset" as const })) },
      "saas",
    );

    expect(summary.detail).not.toContain("environment");
  });

  test("unconfigured names the required fields still missing", () => {
    const summary = summarizeTarget(
      {
        ...TARGET,
        configured: false,
        resolvedFrom: null,
        fields: [
          { ...TARGET.fields[0]!, present: false, source: "unset" },
          { ...TARGET.fields[1]!, present: false, source: "unset" },
          TARGET.fields[2]!,
        ],
      },
      "saas",
    );

    expect(summary.detail).toContain("Base URL");
    expect(summary.detail).toContain("Token");
    // Optional fields never block `configured`, so they are never listed.
    expect(summary.detail).not.toContain("Project");
  });
});

describe("missingRequiredFields", () => {
  test("counts only required fields that do not resolve", () => {
    const target: TargetStatus = {
      ...TARGET,
      fields: [
        { ...TARGET.fields[0]!, present: true },
        { ...TARGET.fields[1]!, present: false },
        { ...TARGET.fields[2]!, present: false },
      ],
    };

    expect(missingRequiredFields(target).map((f) => f.envVar)).toEqual(["WIDGETRON_TOKEN"]);
  });
});

describe("fieldPlaceholder", () => {
  test("a saved field says the value is kept when left blank", () => {
    expect(fieldPlaceholder(field({ envVar: "X", source: "workspace", present: true }))).toContain(
      "leave blank to keep",
    );
  });

  test("an env-sourced field is NOT told that leaving it blank keeps it working", () => {
    // Under the all-or-nothing rung rule it only keeps working while nothing
    // is saved for the workspace. "Leave blank to keep using it" would be an
    // instruction to create the partial row that makes the target throw.
    const placeholder = fieldPlaceholder(field({ envVar: "X", source: "env", present: true }));

    expect(placeholder).toContain("environment");
    expect(placeholder).not.toContain("leave blank");
  });

  test("an unset field distinguishes required from optional", () => {
    expect(fieldPlaceholder(field({ envVar: "X", required: true }))).toBe("Required");
    expect(fieldPlaceholder(field({ envVar: "X", required: false }))).toBe("Optional");
  });
});

describe("mayHaveStoredRow", () => {
  test("a workspace-resolved target has a row", () => {
    expect(mayHaveStoredRow(TARGET)).toBe(true);
  });

  test("an env-resolved target provably has none — that rung is only consulted when the row is absent", () => {
    expect(mayHaveStoredRow({ ...TARGET, resolvedFrom: "env" })).toBe(false);
  });

  test("an unconfigured target MIGHT have a partial row, so removal stays offered", () => {
    // The state ADR-0046 warns about: a row missing a required field shadows
    // the env rung and makes the target throw, while reporting exactly like no
    // row at all. Hiding removal here would leave no way out of it.
    expect(mayHaveStoredRow({ ...TARGET, configured: false, resolvedFrom: null })).toBe(true);
  });
});

describe("requiredFieldsUnsatisfied", () => {
  const unconfigured: TargetStatus = {
    ...TARGET,
    configured: false,
    resolvedFrom: null,
    fields: TARGET.fields.map((f) => ({ ...f, present: false, source: "unset" as const })),
  };

  test("an untouched target with nothing stored lists every required field", () => {
    expect(requiredFieldsUnsatisfied(unconfigured, EMPTY_DRAFT).map((f) => f.envVar)).toEqual([
      "WIDGETRON_URL",
      "WIDGETRON_TOKEN",
    ]);
  });

  test("a typed value satisfies its field", () => {
    const draft = setValue(EMPTY_DRAFT, "WIDGETRON_URL", "https://widgets.acme.dev");

    expect(requiredFieldsUnsatisfied(unconfigured, draft).map((f) => f.envVar)).toEqual([
      "WIDGETRON_TOKEN",
    ]);
  });

  test("a value already stored for the workspace satisfies its field when left blank", () => {
    // The whole point of blank-preserves: an admin editing only the base URL
    // is not warned about the token they cannot see.
    expect(requiredFieldsUnsatisfied(TARGET, setValue(EMPTY_DRAFT, "WIDGETRON_URL", "x"))).toEqual(
      [],
    );
  });

  test("an ENV-sourced value does not satisfy the row being written", () => {
    // It lives in the environment, not in the workspace row — so saving a
    // sibling field creates a row that is missing this one, and the
    // all-or-nothing rule then stops the env fallback entirely.
    const envTarget: TargetStatus = {
      ...TARGET,
      resolvedFrom: "env",
      fields: TARGET.fields.map((f) => ({ ...f, source: f.present ? ("env" as const) : ("unset" as const) })),
    };
    const draft = setValue(EMPTY_DRAFT, "WIDGETRON_URL", "https://widgets.acme.dev");

    expect(requiredFieldsUnsatisfied(envTarget, draft).map((f) => f.envVar)).toEqual([
      "WIDGETRON_TOKEN",
    ]);
  });

  test("clearing a stored required field makes it unsatisfied", () => {
    const draft = toggleCleared(EMPTY_DRAFT, "WIDGETRON_TOKEN", true);

    expect(requiredFieldsUnsatisfied(TARGET, draft).map((f) => f.envVar)).toEqual([
      "WIDGETRON_TOKEN",
    ]);
  });

  test("optional fields never count, cleared or not", () => {
    const draft = toggleCleared(EMPTY_DRAFT, "WIDGETRON_PROJECT", true);

    expect(requiredFieldsUnsatisfied(TARGET, draft)).toEqual([]);
  });

  test("a fully stored target with an untouched draft is satisfied", () => {
    expect(requiredFieldsUnsatisfied(TARGET, EMPTY_DRAFT)).toEqual([]);
  });
});

describe("ActionCredentialsResponseSchema", () => {
  test("accepts a target the web bundle has never heard of", () => {
    const parsed = ActionCredentialsResponseSchema.parse({
      deployMode: "saas",
      targets: [{ ...TARGET, target: "some-future-target" }],
    });

    expect(parsed.targets[0]!.target).toBe("some-future-target");
  });

  test("carries multiline through — the attribute the form branches on for textareas", () => {
    // #5561 added `multiline` to the API's field spec (the GitHub App PEM
    // key) and this schema initially stripped it as an unknown key, leaving
    // the PEM to render as a single-line input. Mirroring the route means
    // mirroring ALL of it.
    const parsed = ActionCredentialsResponseSchema.parse({
      deployMode: "saas",
      targets: [
        { ...TARGET, fields: [field({ envVar: "X", secret: true, multiline: true })] },
      ],
    });

    expect(parsed.targets[0]!.fields[0]!.multiline).toBe(true);
  });

  test("rejects an unknown field source rather than rendering a blank chip", () => {
    // `source` drives a branch in the UI, so a new member has to be taught
    // here before it can reach a user as an unlabelled badge.
    expect(() =>
      ActionCredentialsResponseSchema.parse({
        deployMode: "saas",
        targets: [{ ...TARGET, fields: [field({ envVar: "X", source: "operator" as never })] }],
      }),
    ).toThrow();
  });
});
