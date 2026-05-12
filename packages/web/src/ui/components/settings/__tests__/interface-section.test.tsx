import { describe, expect, test, mock, beforeEach } from "bun:test";
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { FetchError } from "@/ui/lib/fetch-error";

// ── Hook mocks ─────────────────────────────────────────────────────────────
//
// Two structural risks this test pins:
//   1. The PATCH from the form sends `defaultLanding` to `/api/v1/me/preferences` —
//      drift here silently breaks the save flow.
//   2. The 404 fallthrough hides the section entirely — the self-hosted-local
//      contract documented in `me-preferences.ts`. A regression that renders
//      the form anyway would 5xx the page (writes to a non-existent column).

interface FetchState {
  data: { defaultLanding: "chat" | "admin" } | undefined;
  loading: boolean;
  error: FetchError | null;
}

let fetchState: FetchState = { data: undefined, loading: false, error: null };
const refetch = mock(() => {});

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: fetchState.data,
    loading: fetchState.loading,
    error: fetchState.error,
    setError: () => {},
    refetch,
  }),
  friendlyError: (err: FetchError) => err.message,
}));

interface MutateCallArg {
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
}

interface MutationState {
  saving: boolean;
  error: FetchError | null;
  capturedHookOpts: MutateCallArg | null;
  capturedMutateCall: MutateCallArg | null;
  result: { ok: true; data: unknown } | { ok: false; error: FetchError };
}

const mutation: MutationState = {
  saving: false,
  error: null,
  capturedHookOpts: null,
  capturedMutateCall: null,
  result: { ok: true, data: { defaultLanding: "admin" } },
};

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: (opts: MutateCallArg) => {
    mutation.capturedHookOpts = opts;
    return {
      mutate: async (call: MutateCallArg) => {
        mutation.capturedMutateCall = call;
        return mutation.result;
      },
      saving: mutation.saving,
      error: mutation.error,
      errorFor: () => null,
      errorsByItemId: {},
      clearError: () => {},
      clearErrorFor: () => {},
      reset: () => {},
    };
  },
}));

import { InterfaceSection } from "../interface-section";

beforeEach(() => {
  cleanup();
  fetchState = { data: undefined, loading: false, error: null };
  mutation.saving = false;
  mutation.error = null;
  mutation.capturedHookOpts = null;
  mutation.capturedMutateCall = null;
  mutation.result = { ok: true, data: { defaultLanding: "admin" } };
});

describe("InterfaceSection", () => {
  test("renders both radios for an admin caller", () => {
    fetchState.data = { defaultLanding: "chat" };
    const { container } = render(<InterfaceSection isAdmin />);
    expect(container.querySelector('[id="default-landing-chat"]')).not.toBeNull();
    expect(container.querySelector('[id="default-landing-admin"]')).not.toBeNull();
  });

  test("hides the admin radio for a non-admin caller", () => {
    fetchState.data = { defaultLanding: "chat" };
    const { container } = render(<InterfaceSection isAdmin={false} />);
    expect(container.querySelector('[id="default-landing-chat"]')).not.toBeNull();
    expect(container.querySelector('[id="default-landing-admin"]')).toBeNull();
  });

  test("omits the entire section when the endpoint returns 404", () => {
    fetchState.error = { message: "Not available", status: 404 };
    const { container } = render(<InterfaceSection isAdmin />);
    // Whole section gates out — nothing renders, not just the form.
    expect(container.firstChild).toBeNull();
  });

  test("submits PATCH /api/v1/me/preferences with the selected value", async () => {
    fetchState.data = { defaultLanding: "chat" };
    const { container } = render(<InterfaceSection isAdmin />);

    // Click the admin radio, then submit.
    const adminRadio = container.querySelector('[id="default-landing-admin"]') as HTMLElement;
    expect(adminRadio).not.toBeNull();
    await act(async () => {
      fireEvent.click(adminRadio);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    expect(mutation.capturedHookOpts?.path).toBe("/api/v1/me/preferences");
    expect(mutation.capturedHookOpts?.method).toBe("PATCH");
    expect(mutation.capturedMutateCall?.body).toEqual({ defaultLanding: "admin" });
  });

  test("renders a loading placeholder before the preference resolves", () => {
    fetchState.loading = true;
    render(<InterfaceSection isAdmin />);
    expect(screen.getByText(/Loading preferences/i)).toBeDefined();
  });
});
