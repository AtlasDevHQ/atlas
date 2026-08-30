import { describe, expect, test } from "bun:test";
import {
  ActionCredentialsResponseSchema,
  EMPTY_DRAFT,
  buildUpdatePayload,
  fieldPlaceholder,
  isDraftDirty,
  missingRequiredFields,
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

  test("an env-sourced field says so rather than claiming it is saved here", () => {
    expect(fieldPlaceholder(field({ envVar: "X", source: "env", present: true }))).toContain(
      "environment",
    );
  });

  test("an unset field distinguishes required from optional", () => {
    expect(fieldPlaceholder(field({ envVar: "X", required: true }))).toBe("Required");
    expect(fieldPlaceholder(field({ envVar: "X", required: false }))).toBe("Optional");
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
