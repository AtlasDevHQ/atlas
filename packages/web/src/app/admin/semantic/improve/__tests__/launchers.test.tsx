/**
 * Render coverage for the anchor entry launchers + active-anchor chip (#4519
 * AC2/AC3). The pure copy/request-field rules live in `anchor.test.ts`; this
 * file pins the UI behaviors that only a render can catch:
 *
 *   - AC2: the launchers do NOT vanish once messages exist (the exact "vanishing
 *     single button" regression this slice removes), and the Sweep remains even
 *     when the group/entity lists are empty.
 *   - AC3: the active anchor is visible in the conversation UI, with a Clear.
 *
 * The two presentational pieces are tested directly (robust — no Radix portal
 * interaction); the page-level test proves the page renders the launchers
 * unconditionally (a re-introduced `messages.length === 0 &&` guard would fail
 * it).
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AnchorLaunchers, ActiveAnchorChip } from "../page";

// ---------------------------------------------------------------------------
// Component tests — presentational, no page mocks needed.
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe("AnchorLaunchers (#4519 AC2)", () => {
  const noop = () => {};

  test("the Sweep launcher is always present — even with empty group/entity lists", () => {
    const { getByText, queryByText } = render(
      createElement(AnchorLaunchers, {
        groups: [],
        entities: [],
        onGroup: noop,
        onEntity: noop,
        onSweep: noop,
        disabled: false,
      }),
    );
    // Sweep (the anchorless start) never depends on a loaded list.
    expect(getByText("Sweep")).toBeDefined();
    // Group/Entity menus only appear once their lists load.
    expect(queryByText("Group")).toBeNull();
    expect(queryByText("Entity")).toBeNull();
  });

  test("Group and Entity launchers appear once their lists load", () => {
    const { getByText } = render(
      createElement(AnchorLaunchers, {
        groups: [{ id: "g1", name: "US Production" }],
        entities: [{ name: "orders", label: "orders", group: "g1" }],
        onGroup: noop,
        onEntity: noop,
        onSweep: noop,
        disabled: false,
      }),
    );
    expect(getByText("Group")).toBeDefined();
    expect(getByText("Entity")).toBeDefined();
    expect(getByText("Sweep")).toBeDefined();
  });

  test("clicking Sweep fires onSweep (the anchorless start)", () => {
    const onSweep = mock(noop);
    const { getByText } = render(
      createElement(AnchorLaunchers, {
        groups: [],
        entities: [],
        onGroup: noop,
        onEntity: noop,
        onSweep,
        disabled: false,
      }),
    );
    fireEvent.click(getByText("Sweep"));
    expect(onSweep).toHaveBeenCalledTimes(1);
  });
});

describe("ActiveAnchorChip (#4519 AC3)", () => {
  test("shows the active group anchor and a Clear affordance", () => {
    const onClear = mock(() => {});
    const { getByText } = render(
      createElement(ActiveAnchorChip, {
        anchor: { value: { kind: "group", group: "g1" }, label: "US Production" },
        onClear,
      }),
    );
    expect(getByText("Group: US Production")).toBeDefined();
    fireEvent.click(getByText("Clear"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test("shows the active entity anchor", () => {
    const { getByText } = render(
      createElement(ActiveAnchorChip, {
        anchor: { value: { kind: "entity", entity: "orders" }, label: "orders" },
        onClear: () => {},
      }),
    );
    expect(getByText("Entity: orders")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Page-level test — the launchers survive a non-empty conversation (AC2).
// ---------------------------------------------------------------------------

let mockMessages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }> = [];
const sendMessageSpy = mock(async () => {});

void mock.module("@ai-sdk/react", () => ({
  useChat: () => ({ messages: mockMessages, sendMessage: sendMessageSpy, status: "ready", error: null }),
}));

void mock.module("ai", () => ({
  DefaultChatTransport: class {
    constructor() {
      // no-op — useChat is mocked, so the transport is never exercised here.
    }
  },
  isToolUIPart: () => false,
  getToolName: () => "tool",
}));

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "http://localhost", isCrossOrigin: false }),
}));

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/semantic/improve",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: mock(async () => ({ ok: true as const, data: null })),
    isMutating: () => false,
    error: null,
  }),
}));

// Route the fetch by path and apply the REAL transform so the launcher projection
// (groups → {id,name}, entities → {name,label,group}) is exercised too.
void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string, opts?: { transform?: (json: unknown) => unknown }) => {
    let raw: unknown = null;
    if (path.includes("/semantic-improve/pending")) raw = { amendments: [] };
    else if (path.includes("/semantic-improve/rejected")) raw = { amendments: [] };
    else if (path.includes("/me/connection-groups")) raw = { groups: [{ id: "g1", name: "US Production" }] };
    else if (path.includes("/admin/semantic/entities")) raw = { entities: [{ name: "orders", connectionId: "g1" }] };
    const data = opts?.transform ? opts.transform(raw) : raw;
    return { data, loading: false, error: null, refetch: () => {} };
  },
}));

const SemanticImprovePage = (await import("../page")).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(NuqsAdapter, null, createElement(QueryClientProvider, { client }, children));
}

describe("SemanticImprovePage — launchers survive a conversation (#4519 AC2)", () => {
  afterEach(() => {
    cleanup();
    mockMessages = [];
  });

  test("launchers + sweep stay rendered after messages exist (no vanishing button)", async () => {
    // A conversation is already underway — the old single 'Run Analysis' button
    // would be gone here; the launchers must NOT be.
    mockMessages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];

    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(createElement(SemanticImprovePage), { wrapper });
    });

    await waitFor(() => {
      if (!utils.queryByText("Sweep")) throw new Error("Sweep launcher not rendered");
    });
    // All three launchers present despite messages.length > 0.
    expect(utils.getByText("Sweep")).toBeDefined();
    expect(utils.getByText("Group")).toBeDefined();
    expect(utils.getByText("Entity")).toBeDefined();
    // No anchor set yet ⇒ no chip (AC3 negative / AC4 anchorless).
    expect(utils.queryByText(/Scoping this conversation/)).toBeNull();
    // The retired button copy is gone.
    expect(utils.queryByText("Run Analysis")).toBeNull();
  });
});
