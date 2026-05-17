import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";

// Mock the dropdown-menu primitives so portal'd content renders inline.
// We're testing predicate + label logic, not Radix's open/close machinery.
// CLAUDE.md "Mock all exports" — stub every named export of the module
// so an unrelated sibling test importing a different symbol doesn't
// trip a SyntaxError under the isolated test runner.
mock.module("@/components/ui/dropdown-menu", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, ...rest }: { children?: ReactNode; asChild?: boolean } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  const hr = () => React.createElement("hr");
  // Items wire Radix's `onSelect` to a regular `onClick` so the
  // testing-library `fireEvent.click` path triggers the same callback
  // path the real Radix Item exposes. Without this bridge the
  // mock-divs swallow `onSelect` and #2518's selection-flow tests
  // can't observe the parent's `onSelect` reaction.
  const itemWithSelect = ({
    children,
    onSelect,
    asChild: _asChild,
    ...rest
  }: {
    children?: ReactNode;
    asChild?: boolean;
    onSelect?: (e: unknown) => void;
  } & Record<string, unknown>) =>
    React.createElement(
      "div",
      {
        ...rest,
        onClick: () => {
          if (typeof onSelect === "function") onSelect({});
        },
      },
      children as React.ReactNode,
    );
  return {
    DropdownMenu: div,
    DropdownMenuPortal: div,
    DropdownMenuTrigger: div,
    DropdownMenuContent: div,
    DropdownMenuGroup: div,
    DropdownMenuItem: itemWithSelect,
    DropdownMenuCheckboxItem: itemWithSelect,
    DropdownMenuRadioGroup: div,
    DropdownMenuRadioItem: itemWithSelect,
    DropdownMenuLabel: div,
    DropdownMenuSeparator: hr,
    DropdownMenuShortcut: passthrough("span"),
    DropdownMenuSub: div,
    DropdownMenuSubTrigger: div,
    DropdownMenuSubContent: div,
  };
});

import { render, renderHook, waitFor, cleanup } from "@testing-library/react";
import {
  ChatEnvPicker,
  shouldRenderEnvPicker,
  useChatEnvGroups,
  type ChatEnvGroup,
} from "../components/chat/env-picker";

beforeEach(() => {
  cleanup();
});

const noop = () => {};

describe("ChatEnvPicker visibility predicate (#2408)", () => {
  test("renders nothing for the trivial 1×1 case (one group, one member)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_a",
        name: "g_a",
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("still hides 1×1 when an activeGroupId is present — predicate is shape-only", () => {
    // Locks the predicate to groups/members shape so a future refactor
    // can't accidentally re-couple visibility to active-id resolution.
    const groups: ChatEnvGroup[] = [
      {
        id: "g_a",
        name: "g_a",
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_a"
        activeConnectionId="a"
        onSelect={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when there are no groups at all", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders the picker when there are 2+ singleton groups (0062 1:1 backfill shape)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_a",
        name: "g_a",
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
      {
        id: "g_b",
        name: "g_b",
        members: [{ connectionId: "b", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_a"
        activeConnectionId="a"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).not.toBeNull();
  });

  test("renders the picker when one group has two members (the legitimate multi-member case)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_prod"
        activeConnectionId="us-int"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).not.toBeNull();
  });
});

describe("ChatEnvPicker singleton-only footer hint (#2408)", () => {
  test("shows the /admin/connections hint when every group is a singleton", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_a",
        name: "g_a",
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
      {
        id: "g_b",
        name: "g_b",
        members: [{ connectionId: "b", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_a"
        activeConnectionId="a"
        onSelect={noop}
      />,
    );
    const hint = container.querySelector(
      '[data-testid="chat-env-picker-singleton-hint"]',
    );
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("No multi-member environments configured");
    expect(hint?.textContent).toContain("/admin/connections");
  });

  test("hides the hint when at least one group has multiple members", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_dev",
        name: "dev",
        members: [{ connectionId: "dev-1", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_prod"
        activeConnectionId="us-int"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-singleton-hint"]'),
    ).toBeNull();
  });
});

describe("ChatEnvPicker emptyReason (#2422)", () => {
  test("renders an inline 'no active workspace' chip when groups is empty and emptyReason is 'no_active_org'", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        emptyReason="no_active_org"
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    const chip = container.querySelector(
      '[data-testid="chat-env-picker-empty-reason"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-reason")).toBe("no_active_org");
    expect(chip?.textContent).toContain("No active workspace");
    // The chip must not be hidden — it replaces the silent-fallback
    // behavior that motivated #2422.
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).toBeNull();
  });

  test("renders an inline 'set DATABASE_URL' chip when groups is empty and emptyReason is 'no_internal_db'", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        emptyReason="no_internal_db"
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    const chip = container.querySelector(
      '[data-testid="chat-env-picker-empty-reason"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-reason")).toBe("no_internal_db");
    expect(chip?.textContent).toContain("internal database");
    expect(chip?.textContent).toContain("DATABASE_URL");
  });

  test("stays hidden when groups is empty and emptyReason is null (workspace with no groups configured)", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        emptyReason={null}
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("stays hidden when groups is empty and emptyReason is omitted (defaults to null)", () => {
    // Locks the default-prop contract — callers that haven't been
    // updated to thread `emptyReason` should keep the original silent
    // behavior.
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("ignores emptyReason when groups is non-empty (server saw groups; chip would be a lie)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        // A server bug or future state could theoretically send both —
        // the picker takes the groups as ground truth and ignores the
        // reason. Locks the precedence so the chip can never overlay a
        // populated picker.
        emptyReason="no_internal_db"
        activeGroupId="g_prod"
        activeConnectionId="us-int"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-empty-reason"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).not.toBeNull();
  });
});

describe("ChatEnvPicker chip label collapse (#2408)", () => {
  test("renders just the member id when stripped group name equals member id", () => {
    // Common 0062 backfill shape: group `g_warehouse` with one member
    // `warehouse` strips to `warehouse / warehouse` — collapse to
    // `warehouse`.
    const groups: ChatEnvGroup[] = [
      {
        id: "g_warehouse",
        name: "g_warehouse",
        members: [
          { connectionId: "warehouse", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_other",
        name: "g_other",
        members: [
          { connectionId: "other", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_warehouse"
        activeConnectionId="warehouse"
        onSelect={noop}
      />,
    );
    const label = container.querySelector(
      '[data-testid="chat-env-picker-label"]',
    );
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe("warehouse");
  });

  test("collapses with a custom (non-g_-prefixed) group name equal to the member id", () => {
    // Admin-renamed group with no `g_` prefix — stripGroupPrefix is a
    // no-op, and the collapse must still kick in to avoid
    // "warehouse / warehouse".
    const groups: ChatEnvGroup[] = [
      {
        id: "g_warehouse",
        name: "warehouse",
        members: [
          { connectionId: "warehouse", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_other",
        name: "other",
        members: [
          { connectionId: "other", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_warehouse"
        activeConnectionId="warehouse"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent,
    ).toBe("warehouse");
  });

  test("renders 'group / member' when the stripped group name differs from the member id", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_prod"
        activeConnectionId="us-int"
        onSelect={noop}
      />,
    );
    const label = container.querySelector(
      '[data-testid="chat-env-picker-label"]',
    );
    expect(label?.textContent).toBe("prod / us-int");
  });
});

describe("ChatEnvPicker default-member resolution honours group primary", () => {
  // Pre-fix, `activeMember` fell back to `members[0]` (alphabetical) when
  // no `activeConnectionId` was set, so a group like
  // `{apac-prod, eu-prod, us-prod}` with primary `us-prod` would chip
  // `apac-prod` and route there on the first turn. The fix prefers the
  // group's `primaryConnectionId` when no explicit selection exists.

  test("chip resolves to the group primary, not members[0], when no active connection is set", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        primaryConnectionId: "us-prod",
        members: [
          { connectionId: "apac-prod", dbType: "postgres", description: null },
          { connectionId: "eu-prod", dbType: "postgres", description: null },
          { connectionId: "us-prod", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId={null}
        activeConnectionId={null}
        activeRoutingMode="pin"
        onSelect={noop}
      />,
    );
    const label = container.querySelector('[data-testid="chat-env-picker-label"]');
    expect(label?.textContent).toBe("prod / us-prod");
  });

  test("falls back to members[0] when no primary is configured", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        primaryConnectionId: null,
        members: [
          { connectionId: "apac-prod", dbType: "postgres", description: null },
          { connectionId: "us-prod", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId={null}
        activeConnectionId={null}
        activeRoutingMode="pin"
        onSelect={noop}
      />,
    );
    const label = container.querySelector('[data-testid="chat-env-picker-label"]');
    expect(label?.textContent).toBe("prod / apac-prod");
  });

  test("falls back to members[0] when the named primary isn't in the member list", () => {
    // The API's dangling-primary guard usually nulls these out, but the
    // picker should still degrade gracefully if a stale primary survives
    // (e.g. an SDK consumer that synthesises ChatEnvGroup objects).
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        primaryConnectionId: "us-prod-archived",
        members: [
          { connectionId: "apac-prod", dbType: "postgres", description: null },
          { connectionId: "eu-prod", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId={null}
        activeConnectionId={null}
        activeRoutingMode="pin"
        onSelect={noop}
      />,
    );
    const label = container.querySelector('[data-testid="chat-env-picker-label"]');
    expect(label?.textContent).toBe("prod / apac-prod");
  });

  test("explicit activeConnectionId still wins over the group primary", () => {
    // The primary is only a *default*; once the user has picked a member
    // (or the conversation row carries one), that selection overrides.
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        primaryConnectionId: "us-prod",
        members: [
          { connectionId: "apac-prod", dbType: "postgres", description: null },
          { connectionId: "eu-prod", dbType: "postgres", description: null },
          { connectionId: "us-prod", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_prod"
        activeConnectionId="eu-prod"
        activeRoutingMode="pin"
        onSelect={noop}
      />,
    );
    const label = container.querySelector('[data-testid="chat-env-picker-label"]');
    expect(label?.textContent).toBe("prod / eu-prod");
  });
});

// ── useChatEnvGroups hook ────────────────────────────────────────────
//
// `useChatEnvGroups` is the only place the wire `reason` actually
// enters the web app. The component-layer tests above lock the render
// branches, but the hook itself has three behaviors a regression could
// quietly break: echoing a known reason through to state, falling back
// to null when the server omits the field (forward-compat with older
// API), and resetting reason to null on transport failure so a flaky
// network can't pin a stale chip on screen. See #2422.

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: () => Response | Promise<Response>,
): () => number {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    return await handler();
  }) as unknown as typeof fetch;
  return () => calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useChatEnvGroups (#2422)", () => {
  const opts = {
    apiUrl: "http://atlas.test",
    enabled: true,
    getHeaders: () => ({}),
    getCredentials: () => "same-origin" as RequestCredentials,
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("echoes a known reason through to state on a successful empty response", async () => {
    mockFetch(() => jsonResponse({ groups: [], reason: "no_internal_db" }));
    const { result } = renderHook(() => useChatEnvGroups(opts));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.groups).toEqual([]);
    expect(result.current.reason).toBe("no_internal_db");
    expect(result.current.error).toBeNull();
  });

  test("falls back to reason: null when the server omits the field (forward-compat with older API)", async () => {
    mockFetch(() => jsonResponse({ groups: [] }));
    const { result } = renderHook(() => useChatEnvGroups(opts));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.reason).toBeNull();
  });

  test("narrows an unrecognized reason to null instead of leaking it to the chip", async () => {
    // A server bug or a forward-version drift could emit a reason the
    // frontend hasn't been built to render. Indexing into the copy
    // table with that value would render `undefined` as visible text.
    // The hook must narrow before passing it on.
    mockFetch(() =>
      jsonResponse({ groups: [], reason: "no_active_token" /* not in union */ }),
    );
    const { result } = renderHook(() => useChatEnvGroups(opts));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.reason).toBeNull();
  });

  test("resets reason to null on transport failure so a flaky network can't pin a stale chip", async () => {
    // Silence the console.warn we now emit on transport failure; the
    // test is asserting state shape, not log output, and an
    // unexpected warn would flag a CLAUDE.md "no silent swallows"
    // regression elsewhere.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      mockFetch(() => {
        throw new Error("network down");
      });
      const { result } = renderHook(() => useChatEnvGroups(opts));
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.groups).toEqual([]);
      expect(result.current.reason).toBeNull();
      expect(result.current.error).toContain("network down");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("does not fetch when enabled is false (signed-out / auth not resolved)", async () => {
    const callCount = mockFetch(() => jsonResponse({ groups: [], reason: null }));
    renderHook(() => useChatEnvGroups({ ...opts, enabled: false }));
    // Microtask flush — give the effect a chance to fire if it were
    // going to.
    await new Promise((r) => setTimeout(r, 0));
    expect(callCount()).toBe(0);
  });
});

const oneMember = [{ connectionId: "a", dbType: "postgres", description: null }] as const;
const twoMembers = [
  { connectionId: "a", dbType: "postgres", description: null },
  { connectionId: "b", dbType: "postgres", description: null },
] as const;

describe("shouldRenderEnvPicker truth table (#2504)", () => {
  test("hides on empty groups with no reason and no error (legacy single-connection workspace)", () => {
    expect(shouldRenderEnvPicker({ groups: [], reason: null })).toBe(false);
    expect(shouldRenderEnvPicker({ groups: [], reason: null, error: null })).toBe(false);
  });

  test("renders on empty groups when a reason is set (#2422 diagnostic chip path)", () => {
    expect(shouldRenderEnvPicker({ groups: [], reason: "no_internal_db" })).toBe(true);
    expect(shouldRenderEnvPicker({ groups: [], reason: "no_active_org" })).toBe(true);
  });

  test("renders on empty groups when a transport error is set (#2504 connection-failure chip)", () => {
    expect(shouldRenderEnvPicker({ groups: [], reason: null, error: "HTTP 500" })).toBe(true);
  });

  test("hides the trivial 1×1 case (one group, one member)", () => {
    expect(
      shouldRenderEnvPicker({ groups: [{ members: oneMember }], reason: null }),
    ).toBe(false);
  });

  test("renders when one group has 2+ members (the legitimate multi-env case)", () => {
    expect(
      shouldRenderEnvPicker({ groups: [{ members: twoMembers }], reason: null }),
    ).toBe(true);
  });

  test("renders on 2+ groups even when every group is a singleton (0062 1:1 backfill)", () => {
    expect(
      shouldRenderEnvPicker({
        groups: [{ members: oneMember }, { members: oneMember }],
        reason: null,
      }),
    ).toBe(true);
  });
});

describe("ChatEnvPicker transportError (#2504)", () => {
  test("renders an inline 'connection error' chip when groups is empty and transportError is set", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        transportError="HTTP 500"
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    const chip = container.querySelector(
      '[data-testid="chat-env-picker-transport-error"]',
    );
    expect(chip).not.toBeNull();
    // The raw error string must not leak into user-visible copy — only
    // the degraded-state signal.
    expect(chip?.textContent).not.toContain("HTTP 500");
    expect(chip?.textContent).toContain("unavailable");
  });

  test("emptyReason takes precedence over transportError when both are set", () => {
    // The reason path is the server's authoritative diagnostic
    // (#2422). The transport-error chip is the fallback when the
    // server couldn't reach a usable response shape at all, so a
    // populated `emptyReason` strictly wins.
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        emptyReason="no_internal_db"
        transportError="HTTP 500"
        activeGroupId={null}
        activeConnectionId={null}
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-empty-reason"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-env-picker-transport-error"]'),
    ).toBeNull();
  });

  test("ignores transportError when groups is non-empty (the fetch eventually succeeded)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_prod",
        name: "prod",
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        transportError="HTTP 500"
        activeGroupId="g_prod"
        activeConnectionId="us-int"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-transport-error"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).not.toBeNull();
  });
});

// ── #2518 — three-state Auto/Pin/All picker ──────────────────────────

describe("ChatEnvPicker three-state routing mode (#2518)", () => {
  const multiMemberGroup: ChatEnvGroup[] = [
    {
      id: "g_prod",
      name: "prod",
      members: [
        { connectionId: "us-int", dbType: "postgres", description: null },
        { connectionId: "eu", dbType: "postgres", description: null },
        { connectionId: "apac", dbType: "postgres", description: null },
      ],
    },
  ];

  test("trigger reflects 'Pin' as the default when activeRoutingMode is null (back-compat)", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode={null}
        onSelect={noop}
      />,
    );
    const trigger = container.querySelector('[data-testid="chat-env-picker-trigger"]');
    expect(trigger?.getAttribute("data-mode")).toBe("pin");
    expect(
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent,
    ).toBe("prod / eu");
  });

  test("trigger reflects 'Auto' when activeRoutingMode='auto'", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="auto"
        onSelect={noop}
      />,
    );
    const trigger = container.querySelector('[data-testid="chat-env-picker-trigger"]');
    expect(trigger?.getAttribute("data-mode")).toBe("auto");
    expect(
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent,
    ).toContain("Auto");
  });

  test("trigger reflects 'All' when activeRoutingMode='all'", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="all"
        onSelect={noop}
      />,
    );
    const trigger = container.querySelector('[data-testid="chat-env-picker-trigger"]');
    expect(trigger?.getAttribute("data-mode")).toBe("all");
    expect(
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent,
    ).toContain("All");
  });

  test("dropdown renders all three modes with the current mode marked active", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="auto"
        onSelect={noop}
      />,
    );
    const auto = container.querySelector('[data-testid="chat-env-picker-mode-auto"]');
    const pin = container.querySelector('[data-testid="chat-env-picker-mode-pin"]');
    const all = container.querySelector('[data-testid="chat-env-picker-mode-all"]');
    expect(auto).not.toBeNull();
    expect(pin).not.toBeNull();
    expect(all).not.toBeNull();
    expect(auto?.getAttribute("data-active")).toBe("true");
    expect(pin?.getAttribute("data-active")).toBe("false");
    expect(all?.getAttribute("data-active")).toBe("false");
  });

  test("selecting Auto produces a triple with routingMode='auto' keeping the current member", () => {
    let captured: { groupId: string; connectionId: string; routingMode: string } | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="pin"
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    const auto = container.querySelector<HTMLElement>(
      '[data-testid="chat-env-picker-mode-auto"]',
    );
    auto?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(captured).not.toBeNull();
    expect(captured!.routingMode).toBe("auto");
    expect(captured!.groupId).toBe("g_prod");
    expect(captured!.connectionId).toBe("eu");
  });

  test("selecting All produces a triple with routingMode='all' keeping the current member", () => {
    let captured: { groupId: string; connectionId: string; routingMode: string } | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="pin"
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    const all = container.querySelector<HTMLElement>(
      '[data-testid="chat-env-picker-mode-all"]',
    );
    all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(captured).not.toBeNull();
    expect(captured!.routingMode).toBe("all");
  });

  test("member-list selection forces routingMode='pin' implicitly", () => {
    // The user picks a member from the per-group section while in Auto.
    // The natural interpretation is "pin to that member" — you can't
    // 'select a member' in fanout.
    let captured: { groupId: string; connectionId: string; routingMode: string } | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="auto"
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    const apac = container.querySelector<HTMLElement>(
      '[data-testid="chat-env-picker-member-apac"]',
    );
    apac?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(captured).not.toBeNull();
    expect(captured!.routingMode).toBe("pin");
    expect(captured!.connectionId).toBe("apac");
    expect(captured!.groupId).toBe("g_prod");
  });

  test("1×1 group keeps the picker hidden even with activeRoutingMode set (acceptance criterion)", () => {
    const groups: ChatEnvGroup[] = [
      {
        id: "g_only",
        name: "only",
        members: [{ connectionId: "only", dbType: "postgres", description: null }],
      },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={groups}
        activeGroupId="g_only"
        activeConnectionId="only"
        activeRoutingMode="auto"
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test("member highlight uses Pin mode only (Auto/All members don't show as the 'active target')", () => {
    const { container: autoContainer } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="auto"
        onSelect={noop}
      />,
    );
    const euInAuto = autoContainer.querySelector(
      '[data-testid="chat-env-picker-member-eu"]',
    );
    expect(euInAuto?.getAttribute("data-active")).toBe("false");

    cleanup();

    const { container: pinContainer } = render(
      <ChatEnvPicker
        groups={multiMemberGroup}
        activeGroupId="g_prod"
        activeConnectionId="eu"
        activeRoutingMode="pin"
        onSelect={noop}
      />,
    );
    const euInPin = pinContainer.querySelector(
      '[data-testid="chat-env-picker-member-eu"]',
    );
    expect(euInPin?.getAttribute("data-active")).toBe("true");
  });
});

