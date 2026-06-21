/**
 * Render coverage for the progressive-disclosure polish on the schema-driven
 * install form (the Elasticsearch/OpenSearch auth-mode form is the showcase):
 *
 *   - secret fields render a reveal toggle that flips the input between
 *     `password` and `text`;
 *   - consecutive `showWhen` fields gated by the SAME controller render inside a
 *     grouping well (`data-testid="config-field-cluster"`); a lone gated field
 *     stays inline;
 *   - the required marker is the muted asterisk, not destructive red.
 *
 * `ConfigSchemaFields` needs a react-hook-form `control` (it `useWatch`es to
 * drive `showWhen` visibility), so each case renders it inside a `FormProvider`
 * seeded with `buildDefaultValues`. Parsing/validation rules live in
 * `form-install-modal.test.ts`; this file is purely the rendered output.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { ConfigSchemaFields } from "../config-schema-fields";
import { buildDefaultValues, type FormFieldDescriptor } from "../form-install-modal";

afterEach(cleanup);

// Mirrors the Elasticsearch catalog row: a select discriminator gating per-mode
// credential fields. `basic` reveals username + password (a 2-field cluster);
// `apiKey` reveals a single gated field (no cluster).
const ES_FIELDS: FormFieldDescriptor[] = [
  { key: "url", type: "string", label: "Connection URL", required: true },
  {
    key: "authMode",
    type: "select",
    label: "Authentication",
    required: true,
    default: "basic",
    options: [
      { value: "basic", label: "Username & password" },
      { value: "apiKey", label: "API key" },
    ],
  },
  { key: "username", type: "string", label: "Username", required: true, showWhen: { field: "authMode", equals: ["basic"] } },
  { key: "password", type: "string", label: "Password", required: true, secret: true, showWhen: { field: "authMode", equals: ["basic"] } },
  { key: "apiKey", type: "string", label: "API key", required: true, secret: true, showWhen: { field: "authMode", equals: ["apiKey"] } },
];

function renderFields(fields: FormFieldDescriptor[], defaults?: Record<string, unknown>) {
  function Harness() {
    const form = useForm({ defaultValues: defaults ?? buildDefaultValues(fields) });
    return (
      <FormProvider {...form}>
        <ConfigSchemaFields fields={fields} control={form.control} />
      </FormProvider>
    );
  }
  return render(<Harness />);
}

describe("ConfigSchemaFields — secret reveal toggle", () => {
  test("a secret field renders masked with a Show toggle that reveals it", () => {
    const { container } = renderFields(ES_FIELDS);

    const pw = container.querySelector('input[type="password"]');
    expect(pw, "password field starts masked").not.toBeNull();

    const toggle = screen.getByRole("button", { name: "Show Password" });
    fireEvent.click(toggle);

    // Now revealed: input is text, toggle flips to Hide.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hide Password" })).toBeDefined();

    // Toggling back re-masks.
    fireEvent.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  test("non-secret fields render no reveal toggle", () => {
    renderFields([{ key: "url", type: "string", label: "Connection URL", required: true }]);
    expect(screen.queryByRole("button", { name: /Show |Hide / })).toBeNull();
  });
});

describe("ConfigSchemaFields — showWhen grouping well", () => {
  test("consecutive fields gated by the same controller group into one cluster", () => {
    renderFields(ES_FIELDS); // authMode defaults to "basic"

    const clusters = screen.getAllByTestId("config-field-cluster");
    expect(clusters.length).toBe(1);

    // The cluster holds exactly the basic-auth credential pair.
    const cluster = within(clusters[0]);
    expect(cluster.getByText("Username")).toBeDefined();
    expect(cluster.getByText("Password")).toBeDefined();

    // The always-on Connection URL field is NOT inside the cluster.
    expect(cluster.queryByText("Connection URL")).toBeNull();
  });

  test("a lone gated field is not wrapped in a cluster", () => {
    renderFields(ES_FIELDS, { ...buildDefaultValues(ES_FIELDS), authMode: "apiKey" });
    // apiKey is the only visible gated field → rendered inline, no well. Assert
    // it's present via its (unique) secret reveal toggle rather than its label
    // text, which also appears on the authMode select's selected value.
    expect(screen.queryAllByTestId("config-field-cluster").length).toBe(0);
    expect(screen.getByRole("button", { name: "Show API key" })).toBeDefined();
  });
});

describe("ConfigSchemaFields — required marker", () => {
  test("the required asterisk is muted, not destructive red", () => {
    const { container } = renderFields([
      { key: "url", type: "string", label: "Connection URL", required: true },
    ]);
    const asterisks = Array.from(container.querySelectorAll("span")).filter((s) => s.textContent === "*");
    expect(asterisks.length).toBeGreaterThan(0);
    for (const star of asterisks) {
      expect(star.className).toContain("text-muted-foreground");
      expect(star.className).not.toContain("text-destructive");
    }
  });
});
