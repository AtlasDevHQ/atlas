import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";
import { RetentionPanel } from "../retention-panel";
import { AdminActionRetentionPanel } from "../admin-action-retention-panel";

/* ------------------------------------------------------------------ */
/*  Setup (mirrors use-config-form.test.ts)                             */
/* ------------------------------------------------------------------ */

const stubAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
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

/**
 * GETs serve a policy whose retentionDays maps to the "custom" preset in
 * BOTH panels (45 is not a preset in either), so the custom-days input
 * renders. Writes are recorded and answered 200.
 */
let recordedWrites: { url: string; method: string; body: unknown }[];

function installRouteMock() {
  recordedWrites = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          policy: {
            orgId: "org-1",
            retentionDays: 45,
            hardDeleteDelayDays: 30,
            updatedAt: "2026-06-01T00:00:00Z",
            updatedBy: null,
            lastPurgeAt: null,
            lastPurgeCount: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    recordedWrites.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/* ------------------------------------------------------------------ */
/*  Both panels must behave identically (issue #3361 AC 4)              */
/* ------------------------------------------------------------------ */

interface PanelCase {
  name: string;
  Component: ComponentType;
  customDaysLabel: string;
  delayLabel: string;
}

const panels: PanelCase[] = [
  {
    name: "RetentionPanel",
    Component: RetentionPanel,
    customDaysLabel: "Custom days (min 7)",
    delayLabel: "Hard delete delay (days)",
  },
  {
    name: "AdminActionRetentionPanel",
    Component: AdminActionRetentionPanel,
    customDaysLabel: "Custom days (min 7)",
    delayLabel: "Hard delete delay (days)",
  },
];

describe.each(panels)("$name numeric clamp", ({ Component, customDaysLabel, delayLabel }) => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    installRouteMock();
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  async function renderPanel() {
    render(createElement(Component), { wrapper });
    const customDays = (await screen.findByLabelText(customDaysLabel)) as HTMLInputElement;
    const delay = screen.getByLabelText(delayLabel) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save Policy" }) as HTMLButtonElement;
    return { customDays, delay, save };
  }

  test("intermediate out-of-range typing is not blocked", async () => {
    const { customDays } = await renderPanel();

    // "3" en route to "30" — must land in the input, not be swallowed.
    fireEvent.change(customDays, { target: { value: "3" } });
    expect(customDays.value).toBe("3");

    fireEvent.change(customDays, { target: { value: "30" } });
    expect(customDays.value).toBe("30");
  });

  test("save is disabled while customDays is below the minimum, re-enabled when valid", async () => {
    const { customDays, save } = await renderPanel();
    expect(save.disabled).toBe(false);

    fireEvent.change(customDays, { target: { value: "3" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(customDays, { target: { value: "30" } });
    expect(save.disabled).toBe(false);
  });

  test("blur clamps customDays up to the documented minimum of 7", async () => {
    const { customDays, save } = await renderPanel();

    fireEvent.change(customDays, { target: { value: "3" } });
    fireEvent.blur(customDays);

    expect(customDays.value).toBe("7");
    expect(save.disabled).toBe(false);
  });

  test("blur clamps an emptied customDays field back to the minimum", async () => {
    const { customDays } = await renderPanel();

    fireEvent.change(customDays, { target: { value: "" } });
    expect(customDays.value).toBe(""); // clearing is allowed while focused
    fireEvent.blur(customDays);

    expect(customDays.value).toBe("7");
  });

  test("blur clamps hardDeleteDelay up to its minimum of 0", async () => {
    const { delay, save } = await renderPanel();

    fireEvent.change(delay, { target: { value: "-5" } });
    expect(save.disabled).toBe(true);
    fireEvent.blur(delay);

    expect(delay.value).toBe("0");
    expect(save.disabled).toBe(false);
  });

  test("in-range values survive blur unchanged and save sends numbers", async () => {
    const { customDays, save } = await renderPanel();

    fireEvent.change(customDays, { target: { value: "60" } });
    fireEvent.blur(customDays);
    expect(customDays.value).toBe("60");

    fireEvent.click(save);
    await waitFor(() => expect(recordedWrites).toHaveLength(1));
    expect(recordedWrites[0]!.body).toEqual({
      retentionDays: 60,
      hardDeleteDelayDays: 30,
    });
  });
});
