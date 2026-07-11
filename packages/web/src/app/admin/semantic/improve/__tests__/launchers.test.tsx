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

// Capture the transport config so a test can assert the endpoint URL and drive
// the real `prepareSendMessagesRequest` body builder (useChat is mocked, so the
// transport is otherwise never exercised).
type CapturedTransport = {
  api?: string;
  credentials?: string;
  prepareSendMessagesRequest?: (opts: { messages: unknown }) => { body: Record<string, unknown> };
};
let capturedTransport: CapturedTransport | null = null;

void mock.module("ai", () => ({
  DefaultChatTransport: class {
    constructor(config: CapturedTransport) {
      capturedTransport = config;
    }
  },
  isToolUIPart: () => false,
  getToolName: () => "tool",
}));

void mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({ apiUrl: "http://localhost", isCrossOrigin: false }),
}));

// Mock the DropdownMenu primitives as plain divs (items clickable via onSelect),
// the established house pattern (answer-style-picker.test.tsx) — Radix's portal +
// pointer-capture don't drive reliably under happy-dom. The conditional render in
// AnchorLaunchers (`groups.length > 0 && …`) is unaffected, so the hidden-when-empty
// assertions still hold; items are simply always in the DOM so a click reaches
// onSelect.
void mock.module("@/components/ui/dropdown-menu", () => {
  const div = ({ children, asChild: _a, ...rest }: { children?: ReactNode; asChild?: boolean } & Record<string, unknown>) =>
    createElement("div", rest, children as ReactNode);
  const item = ({ children, onSelect, asChild: _a, ...rest }: { children?: ReactNode; asChild?: boolean; onSelect?: () => void } & Record<string, unknown>) =>
    createElement("div", { ...rest, onClick: () => onSelect?.() }, children as ReactNode);
  return {
    DropdownMenu: div,
    DropdownMenuTrigger: div,
    DropdownMenuContent: div,
    DropdownMenuItem: item,
    DropdownMenuLabel: div,
  };
});

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

// Mutable per-test fixtures so a test can feed a drifted response shape.
let mockGroupsResponse: unknown = { groups: [{ id: "g1", name: "US Production" }] };
let mockEntitiesResponse: unknown = { entities: [{ name: "orders", connectionId: "g1" }] };

// Route the fetch by path and apply the REAL transform so the launcher projection
// (groups → {id,name}, entities → {name,label,group}) is exercised too.
void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string, opts?: { transform?: (json: unknown) => unknown }) => {
    let raw: unknown = null;
    if (path.includes("/semantic-improve/pending")) raw = { amendments: [] };
    else if (path.includes("/semantic-improve/rejected")) raw = { amendments: [] };
    else if (path.includes("/me/connection-groups")) raw = mockGroupsResponse;
    else if (path.includes("/admin/semantic/entities")) raw = mockEntitiesResponse;
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
    capturedTransport = null;
    mockGroupsResponse = { groups: [{ id: "g1", name: "US Production" }] };
    mockEntitiesResponse = { entities: [{ name: "orders", connectionId: "g1" }] };
  });

  test("wires the transport to the improve endpoint and builds the anchorless body (#4519)", async () => {
    await act(async () => {
      render(createElement(SemanticImprovePage), { wrapper });
    });
    await waitFor(() => {
      if (!capturedTransport) throw new Error("transport not constructed");
    });
    // The transport targets the semantic-improve chat endpoint.
    expect(capturedTransport?.api).toBe("http://localhost/api/v1/admin/semantic-improve/chat");
    // No launcher clicked ⇒ anchorRef null ⇒ the built body carries messages and
    // NO anchor key (a re-added anchor on an anchorless turn would fail this).
    const built = capturedTransport?.prepareSendMessagesRequest?.({
      messages: [{ id: "m", role: "user", parts: [] }],
    });
    expect(built?.body.messages).toBeDefined();
    expect(built ? "anchor" in built.body : true).toBe(false);
  });

  test("clicking a group launcher shows the chip and rides the anchor on the wire (#4519 AC3 + transport)", async () => {
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(createElement(SemanticImprovePage), { wrapper });
    });
    // The group item is in the DOM (dropdown mocked open). Click it.
    const item = await waitFor(() => {
      const el = utils.queryByText("US Production");
      if (!el) throw new Error("group item not rendered");
      return el;
    });
    await act(async () => {
      fireEvent.click(item);
    });

    // AC3: the active-anchor chip becomes visible.
    await waitFor(() => {
      if (!utils.queryByText("Group: US Production")) throw new Error("anchor chip not shown");
    });
    // The launcher kicked off the conversation.
    expect(sendMessageSpy).toHaveBeenCalled();
    // Ref-write + spread: the transport now builds a body carrying the group
    // anchor (drop the synchronous ref write in applyAnchor and this sends null).
    const built = capturedTransport?.prepareSendMessagesRequest?.({
      messages: [{ id: "m", role: "user", parts: [] }],
    });
    expect(built?.body.anchor).toEqual({ kind: "group", group: "g1" });

    // Clearing the anchor drops the chip and the wire scope.
    await act(async () => {
      fireEvent.click(utils.getByText("Clear"));
    });
    await waitFor(() => {
      if (utils.queryByText("Group: US Production")) throw new Error("chip not cleared");
    });
    const afterClear = capturedTransport?.prepareSendMessagesRequest?.({
      messages: [{ id: "m", role: "user", parts: [] }],
    });
    expect(afterClear ? "anchor" in afterClear.body : true).toBe(false);
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

  test("a field-drifted groups response hides the Group launcher and leaves a breadcrumb", async () => {
    // `id` renamed → every row projects away → launcher vanishes. That must not
    // be silent (per-row field-drift observability).
    mockGroupsResponse = { groups: [{ groupId: "g1", name: "US Production" }] };
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      let utils!: ReturnType<typeof render>;
      await act(async () => {
        utils = render(createElement(SemanticImprovePage), { wrapper });
      });
      await waitFor(() => {
        if (!utils.queryByText("Sweep")) throw new Error("page not rendered");
      });
      // Group launcher hidden; Sweep + Entity unaffected.
      expect(utils.queryByText("Group")).toBeNull();
      expect(utils.getByText("Sweep")).toBeDefined();
      expect(utils.getByText("Entity")).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
