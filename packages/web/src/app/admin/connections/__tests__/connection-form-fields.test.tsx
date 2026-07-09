/**
 * Component tests for the watch-driven slivers of the Add/Edit Connection
 * dialog (#3846).
 *
 * The bug: on Admin → Connections → Add database, the footer **Test** button
 * stayed disabled even with a valid Connection URL filled, so you couldn't
 * pre-flight a connection before persisting. Root cause was that the button's
 * `disabled` gate read `form.watch("url")` from inside `FormDialog`'s
 * `extraFooter` render-prop, and React Compiler memoized that stable
 * `extraFooter?.(form)` call — `watch` never re-ran, so the gate was frozen at
 * its empty initial value. The conditional Environment-name and Postgres-schema
 * fields shared the same latent staleness.
 *
 * The fix moves each watched read into its own component that owns a `useWatch`
 * subscription, so it re-renders on field changes independent of the parent.
 *
 * NOTE: bun:test does NOT run the React Compiler transform, so these tests
 * can't reproduce the compiler-specific staleness directly (the old inline
 * code would pass here too). They lock the intended reactive contract — the
 * button tracks the URL field, the conditional fields mount on their trigger —
 * and guard against a refactor that drops the `useWatch` subscription. The
 * compiler-safety itself comes from the structural extraction.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import React, { type ReactNode } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { Form } from "@/components/ui/form";
import { ENV_SENTINEL_NONE, ENV_SENTINEL_CREATE } from "../generate-prompt";
import {
  type ConnectionFormValues,
  TestConnectionButton,
  NewEnvNameField,
  PostgresSchemaField,
} from "../connection-form-fields";

function baseValues(
  overrides: Partial<ConnectionFormValues> = {},
): ConnectionFormValues {
  return {
    id: "",
    dbType: "postgres",
    url: "",
    schema: "",
    description: "",
    envSelection: ENV_SENTINEL_NONE,
    newGroupName: "",
    ...overrides,
  };
}

/**
 * Renders a real react-hook-form around the field under test and exposes the
 * `form` instance to the test body via a ref-style callback, mirroring how
 * `ConnectionFormDialog` hands `form` to its render props.
 */
function Harness({
  defaults,
  onForm,
  children,
}: {
  defaults?: Partial<ConnectionFormValues>;
  onForm: (form: UseFormReturn<ConnectionFormValues>) => void;
  children: (form: UseFormReturn<ConnectionFormValues>) => ReactNode;
}) {
  const form = useForm<ConnectionFormValues>({
    defaultValues: baseValues(defaults),
  });
  onForm(form);
  return (
    <Form {...form}>
      <input data-testid="url-input" {...form.register("url")} />
      {children(form)}
    </Form>
  );
}

afterEach(() => {
  cleanup();
});

describe("TestConnectionButton (#3846)", () => {
  test("is disabled with an empty URL and enables once a URL is present", async () => {
    const onTest = mock(() => {});

    const { getByText, getByTestId } = render(
      <Harness onForm={() => {}}>
        {(form) => (
          <TestConnectionButton form={form} saving={false} onTest={onTest} />
        )}
      </Harness>,
    );

    const button = getByText("Test").closest("button");
    if (!button) throw new Error("Test button not found");
    expect(button.disabled).toBe(true);

    fireEvent.change(getByTestId("url-input"), {
      target: { value: "mysql://user:pass@host:3306/db" },
    });

    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
  });

  test("clicking reads the latest url + schema at click time, not a stale snapshot", async () => {
    const onTest = mock((_url: string, _schema: string) => {});
    const captured: { current: UseFormReturn<ConnectionFormValues> | null } = { current: null };

    const { getByText, getByTestId } = render(
      <Harness onForm={(f) => (captured.current = f)}>
        {(form) => (
          <TestConnectionButton form={form} saving={false} onTest={onTest} />
        )}
      </Harness>,
    );

    fireEvent.change(getByTestId("url-input"), {
      target: { value: "postgresql://u:p@h:5432/db" },
    });

    // Mutate schema AFTER mount: the button reads it via `getValues` at click
    // time, so a regression that snapshots schema into a prop/closure at mount
    // would surface the old (empty) value here.
    const form = captured.current;
    if (!form) throw new Error("form not captured");
    act(() => form.setValue("schema", "analytics"));

    const button = getByText("Test").closest("button");
    if (!button) throw new Error("Test button not found");
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(onTest).toHaveBeenCalledWith("postgresql://u:p@h:5432/db", "analytics");
  });

  test("stays disabled while a test is in flight even with a URL present", () => {
    const onTest = mock(() => {});

    const { getByText } = render(
      <Harness
        defaults={{ url: "mysql://u:p@h:3306/db" }}
        onForm={() => {}}
      >
        {(form) => (
          <TestConnectionButton form={form} saving={true} onTest={onTest} />
        )}
      </Harness>,
    );

    const button = getByText("Test").closest("button");
    if (!button) throw new Error("Test button not found");
    expect(button.disabled).toBe(true);
  });
});

describe("NewEnvNameField (#3846)", () => {
  test("hidden until envSelection becomes the create-sentinel, then mounts", async () => {
    const captured: { current: UseFormReturn<ConnectionFormValues> | null } = { current: null };

    const { queryByTestId } = render(
      <Harness onForm={(f) => (captured.current = f)}>
        {(form) => <NewEnvNameField form={form} />}
      </Harness>,
    );

    expect(queryByTestId("env-new-name-input")).toBeNull();

    const form = captured.current;
    if (!form) throw new Error("form not captured");
    act(() => form.setValue("envSelection", ENV_SENTINEL_CREATE));

    await waitFor(() => {
      expect(queryByTestId("env-new-name-input")).not.toBeNull();
    });
  });
});

describe("PostgresSchemaField (#3846)", () => {
  test("shown for postgres and hidden once dbType changes away", async () => {
    const captured: { current: UseFormReturn<ConnectionFormValues> | null } = { current: null };

    const { queryByText } = render(
      <Harness defaults={{ dbType: "postgres" }} onForm={(f) => (captured.current = f)}>
        {(form) => <PostgresSchemaField form={form} />}
      </Harness>,
    );

    expect(queryByText("Schema")).not.toBeNull();

    const form = captured.current;
    if (!form) throw new Error("form not captured");
    act(() => form.setValue("dbType", "mysql"));

    await waitFor(() => {
      expect(queryByText("Schema")).toBeNull();
    });
  });
});
