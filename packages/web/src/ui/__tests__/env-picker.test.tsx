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
  pickDefaultEnvSeed,
  resolveConversationScope,
  resolveEnvSelection,
  shouldRenderEnvPicker,
  useChatEnvGroups,
  type ChatEnvGroup,
  type ResolveEnvSelectionInput,
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
        primaryConnectionId: null,
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
        primaryConnectionId: null,
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
        primaryConnectionId: null,
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
      {
        id: "g_b",
        name: "g_b",
        primaryConnectionId: null,
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
        primaryConnectionId: null,
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
        primaryConnectionId: null,
        members: [{ connectionId: "a", dbType: "postgres", description: null }],
      },
      {
        id: "g_b",
        name: "g_b",
        primaryConnectionId: null,
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
        primaryConnectionId: null,
        members: [
          { connectionId: "us-int", dbType: "postgres", description: null },
          { connectionId: "eu-int", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_dev",
        name: "dev",
        primaryConnectionId: null,
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
        primaryConnectionId: null,
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
        primaryConnectionId: null,
        members: [
          { connectionId: "warehouse", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_other",
        name: "g_other",
        primaryConnectionId: null,
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
        primaryConnectionId: null,
        members: [
          { connectionId: "warehouse", dbType: "postgres", description: null },
        ],
      },
      {
        id: "g_other",
        name: "other",
        primaryConnectionId: null,
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
        primaryConnectionId: null,
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

describe("pickDefaultEnvSeed — atlas-chat first-load seeding", () => {
  // The picker chip rendering correctly is cosmetic until atlas-chat
  // actually flips `selectedConnectionId` from null to the primary.
  // Without this seeding, the transport sends `connectionId: null` on
  // the first turn and the backend's routing falls through to
  // alphabetical-first — the exact bug this PR is fixing. These tests
  // lock the rules behind the auto-seed so a future refactor can't
  // silently drop it.

  const multiMemberGroup: ChatEnvGroup = {
    id: "g_prod",
    name: "prod",
    primaryConnectionId: "us-prod",
    members: [
      { connectionId: "apac-prod", dbType: "postgres", description: null },
      { connectionId: "eu-prod", dbType: "postgres", description: null },
      { connectionId: "us-prod", dbType: "postgres", description: null },
    ],
  };

  test("seeds from group primary when no selection exists", () => {
    expect(pickDefaultEnvSeed([multiMemberGroup], null)).toEqual({
      groupId: "g_prod",
      connectionId: "us-prod",
    });
  });

  test("returns null when an explicit selection already exists", () => {
    // The guard that protects a user pick from being overwritten on
    // every refetch. Without it, every `useChatEnvGroups` poll would
    // stomp on the picker's manual selection.
    expect(pickDefaultEnvSeed([multiMemberGroup], "eu-prod")).toBeNull();
  });

  test("falls back to members[0] when primaryConnectionId is null", () => {
    const noPrimary: ChatEnvGroup = { ...multiMemberGroup, primaryConnectionId: null };
    expect(pickDefaultEnvSeed([noPrimary], null)).toEqual({
      groupId: "g_prod",
      connectionId: "apac-prod",
    });
  });

  test("falls back to members[0] when the primary isn't in the member list", () => {
    const danglingPrimary: ChatEnvGroup = {
      ...multiMemberGroup,
      primaryConnectionId: "us-prod-archived",
    };
    expect(pickDefaultEnvSeed([danglingPrimary], null)).toEqual({
      groupId: "g_prod",
      connectionId: "apac-prod",
    });
  });

  test("returns null for an empty groups array", () => {
    expect(pickDefaultEnvSeed([], null)).toBeNull();
  });

  test("returns null when the only group has no members (left-join shape with all archived)", () => {
    const emptyGroup: ChatEnvGroup = {
      id: "g_empty",
      name: "empty",
      primaryConnectionId: null,
      members: [],
    };
    expect(pickDefaultEnvSeed([emptyGroup], null)).toBeNull();
  });

  test("idempotent: passing the same selection again returns null even if groups is a fresh-reference array", () => {
    // The atlas-chat effect's dep array is `[groups, selectedConnectionId]`.
    // Each `useChatEnvGroups` refetch produces a NEW array reference
    // even when contents are identical, so the effect re-fires. The
    // `currentSelection !== null` short-circuit is the only thing
    // keeping an existing pick from being overwritten on every refetch.
    const firstResult = pickDefaultEnvSeed([multiMemberGroup], null);
    expect(firstResult).not.toBeNull();
    const newReferenceSameContents: ChatEnvGroup[] = [{ ...multiMemberGroup }];
    expect(
      pickDefaultEnvSeed(newReferenceSameContents, firstResult!.connectionId),
    ).toBeNull();
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

describe("ChatEnvPicker — REST datasource scope footer (#3044)", () => {
  const multiGroup: ChatEnvGroup[] = [
    {
      id: "prod",
      name: "prod",
      primaryConnectionId: null,
      members: [
        { connectionId: "us-prod", dbType: "postgres", description: null },
        { connectionId: "eu-prod", dbType: "postgres", description: null },
      ],
    },
  ];

  test("frames workspace-global REST datasources as not limited by the pin", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={[{ id: "stripe", displayName: "Stripe", groupId: null }]}
        onSelect={noop}
      />,
    );
    const global = container.querySelector('[data-testid="chat-env-picker-rest-global"]');
    expect(global).not.toBeNull();
    expect(global?.textContent).toContain("Stripe");
    expect(global?.textContent?.toLowerCase()).toContain("every environment");
    expect(global?.textContent?.toLowerCase()).toContain("not limited by");
  });

  test("separates in-scope (active group) from out-of-scope scoped datasources", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={[
          { id: "prod-api", displayName: "Prod API", groupId: "prod" },
          { id: "eu-api", displayName: "EU API", groupId: "eu" },
        ]}
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-rest-in-scope"]')?.textContent,
    ).toContain("Prod API");
    const outOfScope = container.querySelector(
      '[data-testid="chat-env-picker-rest-out-of-scope"]',
    );
    expect(outOfScope?.textContent).toContain("other environments");
    // The out-of-scope datasource's name is NOT leaked into the in-scope list.
    expect(
      container.querySelector('[data-testid="chat-env-picker-rest-in-scope"]')?.textContent,
    ).not.toContain("EU API");
  });

  test("renders no REST footer when the workspace has no REST datasources", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        restDatasources={[]}
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-rest-global"]'),
    ).toBeNull();
  });
});

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

  test("echoes restDatasources from the wire (#3044)", async () => {
    mockFetch(() =>
      jsonResponse({
        groups: [],
        restDatasources: [{ id: "stripe", displayName: "Stripe", groupId: null }],
        reason: null,
      }),
    );
    const { result } = renderHook(() => useChatEnvGroups(opts));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.restDatasources).toEqual([
      { id: "stripe", displayName: "Stripe", groupId: null },
    ]);
  });

  test("defaults restDatasources to [] when an older API omits the field (#3044)", async () => {
    mockFetch(() => jsonResponse({ groups: [] }));
    const { result } = renderHook(() => useChatEnvGroups(opts));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.restDatasources).toEqual([]);
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
        primaryConnectionId: null,
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
      primaryConnectionId: null,
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
        primaryConnectionId: null,
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

// ── #3064 — sticky-preference restore vs default seed ────────────────
//
// The atlas-chat seed/restore effect must restore the user's last sticky
// selection on a fresh chat instead of reverting to the group primary
// (the reset-on-reload bug). `resolveEnvSelection` is the pure decision
// the effect applies: it gates on the preference store having rehydrated
// and the active workspace id being resolved (so a default seed never
// pre-empts a restorable preference), honours `preference > default`
// precedence, ignores another workspace's preference, and tracks seed
// provenance so a default-seeded value yields to a later-arriving match.

describe("resolveEnvSelection — sticky-preference restore vs default seed (#3064)", () => {
  const prodGroup: ChatEnvGroup = {
    id: "g_prod",
    name: "prod",
    primaryConnectionId: "us-prod",
    members: [
      { connectionId: "us-prod", dbType: "postgres", description: null },
      { connectionId: "eu-prod", dbType: "postgres", description: null },
    ],
  };

  // Default input = fresh empty chat, hydrated + resolved, no stored
  // preference, self-hosted (null workspace). Each test overrides the
  // dimension it exercises.
  function input(
    overrides: Partial<ResolveEnvSelectionInput> = {},
  ): ResolveEnvSelectionInput {
    return {
      groups: [prodGroup],
      current: { groupId: null, connectionId: null, routingMode: null },
      provenance: "unset",
      preference: {
        workspaceId: null,
        groupId: null,
        connectionId: null,
        routingMode: null,
      },
      activeWorkspaceId: null,
      preferenceHydrated: true,
      sessionResolved: true,
      ...overrides,
    };
  }

  test("waits — never seeds a default before the preference has rehydrated (reset-on-reload guard)", () => {
    // The core repro: a matching preference exists but the persist store
    // hasn't rehydrated yet. The OLD effect committed the default seed in
    // this window and then locked it in; the resolver must hold off.
    const decision = resolveEnvSelection(
      input({
        preferenceHydrated: false,
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision.kind).toBe("wait");
  });

  test("waits until the session resolves so the active workspace id is final", () => {
    const decision = resolveEnvSelection(
      input({
        sessionResolved: false,
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision.kind).toBe("wait");
  });

  test("waits until connection groups have loaded", () => {
    expect(resolveEnvSelection(input({ groups: [] })).kind).toBe("wait");
  });

  test("restores the hydrated workspace preference instead of the default seed", () => {
    // Pin to the non-primary member, reload → the pin comes back.
    const decision = resolveEnvSelection(
      input({
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
    });
  });

  test("restores over a default-seeded selection when a matching preference arrives", () => {
    // Belt-and-suspenders: even if a default slipped in before the preference
    // rehydrated, the preference step runs before the seed step on every
    // invocation, so a workspace-matching preference still wins — the old
    // `selectedConnectionId !== null` guard no longer locks the default in.
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
    });
  });

  test("restores when group + connection match but the routing mode differs", () => {
    // A default seed lands on the preferred member (no mode), but the stored
    // preference asked for "auto" — the mode-only difference must still
    // restore rather than no-op (routingMode is part of the selection).
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "eu-prod", routingMode: null },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "auto",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "auto",
    });
  });

  test("does not re-seed a default-seeded selection when there is no matching preference", () => {
    // The load-bearing role of the `default` provenance: once a default has
    // been seeded and no preference matches, leave it — don't seed again.
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null },
        provenance: "default",
      }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  test("leaves an explicit user selection untouched even when a different preference exists", () => {
    // A pick made this session (or a conversation-restored value) is
    // authoritative — the resolver must never auto-replace it.
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null },
        provenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  test("no-ops when the current selection already equals the preference (no churn)", () => {
    const decision = resolveEnvSelection(
      input({
        // Full match including routing mode — nothing to restore.
        current: { groupId: "g_prod", connectionId: "eu-prod", routingMode: "pin" },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  test("seeds the group primary when there is no stored preference", () => {
    expect(resolveEnvSelection(input())).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
    });
  });

  test("seeds the default when the stored preference points at a removed member", () => {
    const decision = resolveEnvSelection(
      input({
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "gone-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
    });
  });

  test("ignores a preference stored under a different workspace id (#3044)", () => {
    const decision = resolveEnvSelection(
      input({
        preference: {
          workspaceId: "org-B",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
        },
        activeWorkspaceId: "org-A",
      }),
    );
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
    });
  });

  test("restores a preference saved with a null workspace id on self-hosted", () => {
    const decision = resolveEnvSelection(
      input({
        preference: {
          workspaceId: null,
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "auto",
        },
        activeWorkspaceId: null,
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "auto",
    });
  });

  test("still seeds the lone connection in a single-connection workspace (no regression to the hidden-picker path)", () => {
    const solo: ChatEnvGroup = {
      id: "g_only",
      name: "only",
      primaryConnectionId: null,
      members: [{ connectionId: "only", dbType: "postgres", description: null }],
    };
    expect(resolveEnvSelection(input({ groups: [solo] }))).toEqual({
      kind: "seed",
      groupId: "g_only",
      connectionId: "only",
    });
  });
});

// ── #3065 — restore a conversation's scope on open ───────────────────
//
// Opening a saved conversation must restore THAT conversation's persisted
// scope into the picker — precedence: conversation row > sticky preference >
// default seed. `resolveConversationScope` is the pure decision that
// atlas-chat's `handleSelectConversation` applies: `restore` (apply + mark
// provenance `explicit`, so the seed/restore effect's "explicit → noop" guard
// keeps it) or `seed` (defer to that effect — the row carried no usable scope).
//
// It validates the row against the loaded env groups so a stale/empty scope is
// NEVER made authoritative (the bug Codex flagged on the first cut): an all-null
// legacy row, or a row pointing at an archived/removed group, falls back to
// `seed` instead of forcing the transport to send nulls / a rejected group id.
// An archived *member* under a still-valid group is repaired to the group
// primary rather than discarding the whole (still-valid) group.

describe("resolveConversationScope — restore a conversation's scope on open (#3065)", () => {
  const prodGroup: ChatEnvGroup = {
    id: "g_prod",
    name: "prod",
    primaryConnectionId: "us-prod",
    members: [
      { connectionId: "us-prod", dbType: "postgres", description: null },
      { connectionId: "eu-prod", dbType: "postgres", description: null },
    ],
  };
  const stagingGroup: ChatEnvGroup = {
    id: "g_staging",
    name: "staging",
    primaryConnectionId: null,
    members: [{ connectionId: "us-staging", dbType: "postgres", description: null }],
  };
  const groups: ChatEnvGroup[] = [prodGroup, stagingGroup];

  test("restores a row that resolves to a visible group + member, verbatim", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: "pin" });
  });

  test("preserves an 'auto' routing mode (mode is a first-class scope dimension)", () => {
    // routingMode is a first-class scope dimension — assert it explicitly so a
    // restore can never silently lose the mode (a prior slice regressed this).
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "us-prod", routingMode: "auto" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "auto" });
  });

  test("preserves an 'all' routing mode", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "us-prod", routingMode: "all" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "all" });
  });

  test("two different conversations resolve to two different scopes (switching updates the picker each time)", () => {
    const a = resolveConversationScope(
      { connectionGroupId: "g_prod", connectionId: "eu-prod", routingMode: "pin" },
      groups,
    );
    const b = resolveConversationScope(
      { connectionGroupId: "g_staging", connectionId: "us-staging", routingMode: "auto" },
      groups,
    );
    expect(a).not.toEqual(b);
    expect(a).toMatchObject({ kind: "restore", connectionId: "eu-prod" });
    expect(b).toMatchObject({ kind: "restore", connectionId: "us-staging", routingMode: "auto" });
  });

  test("legacy conversation with a null routing mode preserves null (read as pin downstream)", () => {
    // Pre-#2518 rows carry a single connectionId and no mode. null is kept
    // faithfully — the picker and the agent runtime both read null as "pin",
    // so the conversation stays pinned to its connectionId.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod", routingMode: null },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: null });
  });

  test("legacy conversation with an omitted routing mode defaults to null", () => {
    // routingMode is optional on the wire type — an older SDK/peer may omit
    // it entirely. Coalesce the missing field to null rather than undefined.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: null });
  });

  test("seeds (defers) for a fully-null row — never makes nulls authoritative", () => {
    // Codex finding 1: an all-null legacy/API-created row marked `explicit`
    // would show a fallback chip while the transport sent nulls. Defer instead.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: null, routingMode: null },
        groups,
      ),
    ).toEqual({ kind: "seed" });
  });

  test("seeds when the row's group has been archived / is no longer visible", () => {
    // Codex finding 2: a since-removed group restored verbatim would be sent to
    // the chat route and rejected (invalid_connection_group). Defer to seeding.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_archived", connectionId: "old-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "seed" });
  });

  test("repairs an archived member to the group primary when the group still resolves", () => {
    // The group is still valid but the pinned member is gone — keep the group,
    // repair the execution target to the primary rather than sending a stale id.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "ap-prod-archived", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "pin" });
  });

  test("repairs a group-only row (null member, e.g. Auto) to the group primary", () => {
    // An Auto/All conversation may carry a group but no pinned member. Restore
    // the group + its primary as the displayed target, preserving the mode.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: null, routingMode: "auto" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "auto" });
  });

  test("falls back to members[0] when repairing under a group with no primary", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_staging", connectionId: "gone", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_staging", connectionId: "us-staging", routingMode: "pin" });
  });

  test("trusts the row optimistically when groups have not loaded yet (cold-start open)", () => {
    // We can't validate against an empty group list; losing the restore on a
    // cold-start open is a worse, more common regression than the rare
    // archived-env + cold-start intersection. Restore the row verbatim.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod", routingMode: "all" },
        [],
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: "all" });
  });

  test("still seeds a fully-null row even when groups have not loaded", () => {
    // Emptiness is decided before the groups-loaded gate — an all-null row is
    // never authoritative regardless of load state.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: null, routingMode: null },
        [],
      ),
    ).toEqual({ kind: "seed" });
  });

  test("seeds a legacy group-less row (connectionId but null group) once groups are loaded", () => {
    // Reachable production state (migration 0067 only backfilled the group for
    // rows whose connection still joined): connectionId set, connectionGroupId
    // null. With groups loaded there is no group to validate, so seed — the
    // chat route still pins execution by reading connection_id back off the row.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: "us-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "seed" });
  });

  test("optimistically restores a legacy group-less row (null group) on cold-start", () => {
    // Same row before groups load: can't validate, so trust it verbatim — the
    // null group is carried through (asymmetric with the groups-loaded seed
    // above; locks that the emptiness check requires BOTH ids null, not either).
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: "us-prod", routingMode: "pin" },
        [],
      ),
    ).toEqual({ kind: "restore", groupId: null, connectionId: "us-prod", routingMode: "pin" });
  });

  test("seeds when a resolved group has no live members (fully archived group)", () => {
    const emptyGroup: ChatEnvGroup = {
      id: "g_empty",
      name: "empty",
      primaryConnectionId: null,
      members: [],
    };
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_empty", connectionId: "anything", routingMode: "pin" },
        [emptyGroup],
      ),
    ).toEqual({ kind: "seed" });
  });
});

