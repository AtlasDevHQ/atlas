import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import CustomDomainPage from "../page";

/**
 * Regression guard for the structured plan-gate on `/admin/custom-domain`.
 *
 * `isPlanGated` branches on `addError.code === "plan_required" |
 * "enterprise_required"` — not on substring-matching the human message.
 * A future edit that reverts to `.message.includes(...)`, drops `.code`
 * extraction in `extractFetchError`, or renames the server enum would
 * silently un-gate the page (the add form would render and POSTs would 403).
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
      },
      children,
    ),
  );
}

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockDomainApi(postError: { status: number; body: Record<string, unknown> }) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Promise.resolve(jsonResponse({ domain: null }));
    if (method === "POST")
      return Promise.resolve(jsonResponse(postError.body, postError.status));
    // Throw instead of returning a fallthrough 2xx — if the page starts issuing
    // an unexpected request (e.g. auto-verify on save), the test surfaces it
    // loudly instead of silently passing.
    throw new Error(`unexpected ${method} ${String(input)}`);
  }) as unknown as typeof fetch;
}

async function submitAddDomain() {
  const addTrigger = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("+ Add domain"),
  );
  expect(addTrigger).toBeDefined();
  await act(async () => {
    fireEvent.click(addTrigger!);
  });

  const input = document.querySelector<HTMLInputElement>("input#domain");
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input!, { target: { value: "data.acme.com" } });
  });

  const submit = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Add domain",
  );
  expect(submit).toBeDefined();
  await act(async () => {
    fireEvent.click(submit!);
  });
}

describe("/admin/custom-domain plan-gate (structured code, not message)", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("403 + plan_required → gated landing renders, add form is gone", async () => {
    mockDomainApi({
      status: 403,
      body: { error: "plan_required", message: "Upgrade required" },
    });

    const { container } = render(<CustomDomainPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add domain"),
        ),
      ).toBe(true);
    });

    await submitAddDomain();

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Custom domains are an Enterprise feature",
      );
    });
    // Gated landing replaces the editor — the domain input must NOT remain
    // mounted, otherwise a gated admin could still fill in and re-submit.
    expect(document.querySelector("input#domain")).toBeNull();
    // Gated landing renders no banner — the upsell surface IS the message.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  test("402 + plan_required → same gated landing (status-agnostic, code-driven)", async () => {
    // Plan-gating canonically maps to HTTP 402. `friendlyError` doesn't rewrite
    // 402, so this is a distinct branch from the 403 case — if the server
    // migrates `plan_required` from 403 to 402, the gate must still trigger.
    mockDomainApi({
      status: 402,
      body: { error: "plan_required", message: "Payment required" },
    });

    const { container } = render(<CustomDomainPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add domain"),
        ),
      ).toBe(true);
    });

    await submitAddDomain();

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Custom domains are an Enterprise feature",
      );
    });
    expect(document.querySelector("input#domain")).toBeNull();
  });

  test("403 + enterprise_required → same gated landing", async () => {
    mockDomainApi({
      status: 403,
      body: { error: "enterprise_required", message: "Enterprise required" },
    });

    const { container } = render(<CustomDomainPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add domain"),
        ),
      ).toBe(true);
    });

    await submitAddDomain();

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Custom domains are an Enterprise feature",
      );
    });
    expect(document.querySelector("input#domain")).toBeNull();
  });

  test("422 + unrelated code → add form stays open, gated landing does NOT render", async () => {
    // Negative case — the gate must key on the enum, not on any particular
    // error status. A 422 is used on purpose: `friendlyError` rewrites
    // 401/403/404/503 to canned copy, so a 403 "something_else" would render
    // as "Access denied" and indistinguishably match the admin-role path.
    // 422 lets the raw body message reach the DOM so we can positively assert
    // the inline banner — not the gated landing — rendered.
    mockDomainApi({
      status: 422,
      body: { error: "something_else", message: "Validation failed" },
    });

    const { container } = render(<CustomDomainPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add domain"),
        ),
      ).toBe(true);
    });

    await submitAddDomain();

    // Scope to `[role="alert"]` — asserting on `container.textContent` would
    // pass if the message leaked into a tooltip, title, or SR-only element.
    const banner = await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      if (!el) throw new Error("alert not found");
      return el;
    });
    expect(banner.textContent).toContain("Validation failed");
    expect(container.textContent).not.toContain(
      "Custom domains are an Enterprise feature",
    );
    expect(document.querySelector("input#domain")).not.toBeNull();
    // Exactly one banner — a regression that double-rendered `addError` at
    // both the top-level `mutationError` slot and the inline Shell slot would
    // otherwise slip through the first-match `querySelector` above.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});
