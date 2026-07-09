import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";

// Mock the dropdown-menu primitives so portal'd content renders inline.
// We're testing predicate + label logic, not Radix's open/close machinery.
// CLAUDE.md "Mock all exports" — stub every named export of the module
// so an unrelated sibling test importing a different symbol doesn't
// trip a SyntaxError under the isolated test runner.
void mock.module("@/components/ui/dropdown-menu", () => {
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
  // #3066 — checkbox items wire BOTH `onSelect` (with a preventDefault-able
  // event, since the component calls `e.preventDefault()` to keep the menu
  // open) and `onCheckedChange` (toggled value), mirroring Radix's
  // CheckboxItem. `checked` is consumed (not spread onto the div) so it
  // doesn't leak as a DOM attribute.
  const checkboxItem = ({
    children,
    checked,
    onSelect,
    onCheckedChange,
    asChild: _asChild,
    ...rest
  }: {
    children?: ReactNode;
    asChild?: boolean;
    checked?: boolean;
    onSelect?: (e: { preventDefault: () => void }) => void;
    onCheckedChange?: (checked: boolean) => void;
  } & Record<string, unknown>) =>
    React.createElement(
      "div",
      {
        ...rest,
        onClick: () => {
          if (typeof onSelect === "function") onSelect({ preventDefault: () => {} });
          if (typeof onCheckedChange === "function") onCheckedChange(checked !== true);
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
    DropdownMenuCheckboxItem: checkboxItem,
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

import { render, renderHook, waitFor, cleanup, fireEvent } from "@testing-library/react";
import {
  ChatEnvPicker,
  pickDefaultEnvSeed,
  resolveConversationScope,
  resolveEnvSelection,
  shouldRenderEnvPicker,
  useChatEnvGroups,
  type ChatEnvGroup,
  type ChatEnvSelection,
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
        // #3895 — the Pin chip collapse applies to a focused group (or a
        // single-group workspace); under multi-group All sources the chip reads
        // "All sources". Focus → g_warehouse exercises the collapse here.
        activeGroupReach="g_warehouse"
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
        activeGroupReach="g_warehouse"
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

  test("surfaces workspace-global REST datasources as an in-scope checkbox", () => {
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
    // #3066 — the datasource renders as a checkbox, in scope (not excluded) by default.
    const toggle = container.querySelector('[data-testid="chat-env-picker-rest-toggle-stripe"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("data-in-scope")).toBe("true");
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

describe("ChatEnvPicker — REST datasource exclude-set (#3066)", () => {
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
  const datasources = [
    { id: "stripe", displayName: "Stripe", groupId: null },
    { id: "prod-api", displayName: "Prod API", groupId: "prod" },
  ];

  test("the chip reflects the in-scope REST count (e.g. 2/2, then 1/2 when one is excluded)", () => {
    const { container, rerender } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={[]}
        onSelect={noop}
      />,
    );
    const label = () =>
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label()).toContain("2/2 REST");

    rerender(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={["stripe"]}
        onSelect={noop}
      />,
    );
    expect(label()).toContain("1/2 REST");
  });

  test("an excluded datasource renders unchecked (data-in-scope=false)", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={["stripe"]}
        onSelect={noop}
      />,
    );
    expect(
      container
        .querySelector('[data-testid="chat-env-picker-rest-toggle-stripe"]')
        ?.getAttribute("data-in-scope"),
    ).toBe("false");
    expect(
      container
        .querySelector('[data-testid="chat-env-picker-rest-toggle-prod-api"]')
        ?.getAttribute("data-in-scope"),
    ).toBe("true");
  });

  test("unchecking an in-scope datasource adds it to the exclude-set (full next set)", () => {
    const onRestExcludedChange = mock((_next: string[]) => {});
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={onRestExcludedChange}
        onSelect={noop}
      />,
    );
    const toggle = container.querySelector(
      '[data-testid="chat-env-picker-rest-toggle-stripe"]',
    ) as HTMLElement;
    fireEvent.click(toggle);
    expect(onRestExcludedChange).toHaveBeenCalledTimes(1);
    expect(onRestExcludedChange.mock.calls[0]![0]).toEqual(["stripe"]);
  });

  test("re-checking an excluded datasource clears it from the set (sends the remaining set)", () => {
    const onRestExcludedChange = mock((_next: string[]) => {});
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={["stripe", "prod-api"]}
        onRestExcludedChange={onRestExcludedChange}
        onSelect={noop}
      />,
    );
    const toggle = container.querySelector(
      '[data-testid="chat-env-picker-rest-toggle-stripe"]',
    ) as HTMLElement;
    // It's currently excluded (unchecked); clicking re-includes it.
    fireEvent.click(toggle);
    expect(onRestExcludedChange).toHaveBeenCalledTimes(1);
    expect(onRestExcludedChange.mock.calls[0]![0]).toEqual(["prod-api"]);
  });
});

describe("ChatEnvPicker — REST-only focus (#3067)", () => {
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
  const datasources = [
    { id: "stripe", displayName: "Stripe", groupId: null },
    { id: "prod-api", displayName: "Prod API", groupId: "prod" },
  ];

  test("the chip reads '<name> only' and marks data-focused when a datasource is focused", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restFocusDatasourceId="stripe"
        onRestFocusChange={noop}
        onSelect={noop}
      />,
    );
    const label =
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label).toContain("Stripe only");
    // The mode/env summary is replaced — SQL routing is suspended.
    expect(label).not.toContain("REST");
    expect(
      container
        .querySelector('[data-testid="chat-env-picker-trigger"]')
        ?.getAttribute("data-focused"),
    ).toBe("true");
  });

  test("falls back to 'REST only' when the focused id isn't in the datasource list", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restFocusDatasourceId="gone-ds"
        onRestFocusChange={noop}
        onSelect={noop}
      />,
    );
    const label =
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label).toContain("REST only");
  });

  test("offers a 'Focus … only' option per reachable datasource; clicking focuses it", () => {
    const onRestFocusChange = mock((_next: string | null) => {});
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restFocusDatasourceId={null}
        onRestFocusChange={onRestFocusChange}
        onSelect={noop}
      />,
    );
    const focusItem = container.querySelector(
      '[data-testid="chat-env-picker-rest-focus-stripe"]',
    ) as HTMLElement;
    expect(focusItem).not.toBeNull();
    fireEvent.click(focusItem);
    expect(onRestFocusChange).toHaveBeenCalledTimes(1);
    expect(onRestFocusChange.mock.calls[0]![0]).toBe("stripe");
  });

  test("while focused, hides the exclude checkboxes and clears via onRestFocusChange(null)", () => {
    const onRestFocusChange = mock((_next: string | null) => {});
    const { container } = render(
      <ChatEnvPicker
        groups={multiGroup}
        activeGroupId="prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        restDatasources={datasources}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={noop}
        restFocusDatasourceId="stripe"
        onRestFocusChange={onRestFocusChange}
        onSelect={noop}
      />,
    );
    // The exclude-set is inert while focused → its checkboxes are not rendered.
    expect(
      container.querySelector('[data-testid="chat-env-picker-rest-toggle-stripe"]'),
    ).toBeNull();
    // The focused summary carries the focused id…
    expect(
      container
        .querySelector('[data-testid="chat-env-picker-rest-focused"]')
        ?.getAttribute("data-focus-id"),
    ).toBe("stripe");
    // …and the clear action nulls the focus.
    const clear = container.querySelector(
      '[data-testid="chat-env-picker-rest-focus-clear"]',
    ) as HTMLElement;
    fireEvent.click(clear);
    expect(onRestFocusChange).toHaveBeenCalledTimes(1);
    expect(onRestFocusChange.mock.calls[0]![0]).toBeNull();
  });
});

// ── #3078 — zero-group (REST-only) workspace render path ──────────────
//
// A workspace with REST datasources but NO SQL connection groups must still
// surface the picker so its REST scope (exclude / focus) is reachable. The
// SQL-less render path drops the routing modes / member list / singleton hint
// (all SQL affordances) and shows only the REST scope section; the chip reads
// the REST count with no SQL group/member prefix.

describe("ChatEnvPicker — zero-group REST-only workspace (#3078)", () => {
  const restOnly = [
    { id: "stripe", displayName: "Stripe", groupId: null },
    { id: "github", displayName: "GitHub", groupId: null },
  ];

  test("renders the picker for a zero-group workspace that has REST datasources", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        restDatasources={restOnly}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={noop}
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]'),
    ).not.toBeNull();
  });

  test("the chip shows the REST count with no SQL routing / member prefix", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        restDatasources={restOnly}
        restExcludedDatasourceIds={["stripe"]}
        onRestExcludedChange={noop}
        onSelect={noop}
      />,
    );
    const label =
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label).toContain("1/2 REST");
    // No SQL group/member chip → no placeholder dashes or pin label leak.
    expect(label).not.toContain("—");
  });

  test("the REST datasources are excludable; no SQL routing section is rendered", () => {
    const onRestExcludedChange = mock((_next: string[]) => {});
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        restDatasources={restOnly}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={onRestExcludedChange}
        onSelect={noop}
      />,
    );
    const toggle = container.querySelector(
      '[data-testid="chat-env-picker-rest-toggle-stripe"]',
    ) as HTMLElement;
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle);
    expect(onRestExcludedChange).toHaveBeenCalledTimes(1);
    expect(onRestExcludedChange.mock.calls[0]![0]).toEqual(["stripe"]);
    // SQL affordances are absent — there are no groups to route over.
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-env-picker-mode-pin"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-env-picker-mode-all"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-env-picker-singleton-hint"]'),
    ).toBeNull();
  });

  test("makes a group-scoped REST datasource reachable too when there's no SQL env (#3078 Codex)", () => {
    // A REST datasource with a non-null groupId in a zero-group workspace has no
    // SQL env to scope against, so it must still be toggleable — not classified
    // as "scoped to another environment" / counted as 0/0.
    const onRestExcludedChange = mock((_next: string[]) => {});
    const mixed = [
      { id: "stripe", displayName: "Stripe", groupId: null },
      { id: "scoped-api", displayName: "Scoped API", groupId: "g_gone" },
    ];
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        restDatasources={mixed}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={onRestExcludedChange}
        onSelect={noop}
      />,
    );
    // Both datasources counted as reachable on the chip.
    const label =
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label).toContain("2/2 REST");
    // The group-scoped one is toggleable, NOT shoved into "other environments".
    const scopedToggle = container.querySelector(
      '[data-testid="chat-env-picker-rest-toggle-scoped-api"]',
    ) as HTMLElement;
    expect(scopedToggle).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-env-picker-rest-out-of-scope"]'),
    ).toBeNull();
    fireEvent.click(scopedToggle);
    expect(onRestExcludedChange.mock.calls[0]![0]).toEqual(["scoped-api"]);
  });

  test("supports REST-only focus on a zero-group workspace (pairs with #3067)", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={[]}
        activeGroupId={null}
        activeConnectionId={null}
        restDatasources={restOnly}
        restExcludedDatasourceIds={[]}
        onRestExcludedChange={noop}
        restFocusDatasourceId="stripe"
        onRestFocusChange={noop}
        onSelect={noop}
      />,
    );
    const label =
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent ?? "";
    expect(label).toContain("Stripe only");
    expect(
      container
        .querySelector('[data-testid="chat-env-picker-trigger"]')
        ?.getAttribute("data-focused"),
    ).toBe("true");
    // No SQL routing section while focused on a zero-group workspace.
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).toBeNull();
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

  // #3066 — the exclude-set must be reachable on the common one-Postgres +
  // one-REST workspace, where SQL routing alone is trivial (1 group / 1 member).
  test("renders the trivial 1×1 case when there are REST datasources to exclude (#3066)", () => {
    expect(
      shouldRenderEnvPicker({
        groups: [{ members: oneMember }],
        reason: null,
        restDatasources: [{ id: "stripe" }],
      }),
    ).toBe(true);
  });

  test("still hides 1×1 when there are no REST datasources (#3066)", () => {
    expect(
      shouldRenderEnvPicker({
        groups: [{ members: oneMember }],
        reason: null,
        restDatasources: [],
      }),
    ).toBe(false);
  });

  // #3078 — a zero-group (REST-only) workspace now renders the picker so its
  // REST datasources are reachable (exclude / focus) via the SQL-less render
  // path. Supersedes the prior "#3066 deferred" hide.
  test("renders a zero-group workspace when there are REST datasources (#3078)", () => {
    expect(
      shouldRenderEnvPicker({
        groups: [],
        reason: null,
        restDatasources: [{ id: "stripe" }],
      }),
    ).toBe(true);
  });

  test("still hides a zero-group workspace with no REST datasources, reason, or error (#3078)", () => {
    expect(
      shouldRenderEnvPicker({ groups: [], reason: null, restDatasources: [] }),
    ).toBe(false);
    // The reason / error chip paths are unaffected by the REST-only render path.
    expect(
      shouldRenderEnvPicker({ groups: [], reason: "no_internal_db", restDatasources: [] }),
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
    let captured: ChatEnvSelection | null = null;
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
    let captured: ChatEnvSelection | null = null;
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
    let captured: ChatEnvSelection | null = null;
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
      current: {
        groupId: null,
        connectionId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
      },
      provenance: "unset",
      // #3078 — REST scope provenance defaults to "unset" (follows the SQL
      // seed/restore). Tests that exercise the decoupled lifecycle override it.
      restProvenance: "unset",
      // #3895 — Group reach provenance, same default (follows the seed/restore).
      groupReachProvenance: "unset",
      preference: {
        workspaceId: null,
        groupId: null,
        connectionId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
      },
      activeWorkspaceId: null,
      preferenceHydrated: true,
      sessionResolved: true,
      // #3078 — default to "groups fetch settled" so the with-groups tests run
      // the normal path; the zero-group tests override groups + this flag.
      groupsLoaded: true,
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision.kind).toBe("wait");
  });

  test("waits until connection groups have loaded (groups empty AND fetch not settled)", () => {
    // #3078 — emptiness alone is no longer "wait": a *loaded-empty* group list is
    // a real zero-group workspace (REST-only path). It only waits while the
    // fetch hasn't settled yet.
    expect(
      resolveEnvSelection(input({ groups: [], groupsLoaded: false })).kind,
    ).toBe("wait");
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("restores over a default-seeded selection when a matching preference arrives", () => {
    // Belt-and-suspenders: even if a default slipped in before the preference
    // rehydrated, the preference step runs before the seed step on every
    // invocation, so a workspace-matching preference still wins — the old
    // `selectedConnectionId !== null` guard no longer locks the default in.
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("restores when group + connection match but the routing mode differs", () => {
    // A default seed lands on the preferred member (no mode), but the stored
    // preference asked for "auto" — the mode-only difference must still
    // restore rather than no-op (routingMode is part of the selection).
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "eu-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "auto",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "auto",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("does not re-seed a default-seeded selection when there is no matching preference", () => {
    // The load-bearing role of the `default` provenance: once a default has
    // been seeded and no preference matches, leave it — don't seed again.
    const decision = resolveEnvSelection(
      input({
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null },
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
        current: { groupId: "g_prod", connectionId: "us-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null },
        provenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
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
        current: { groupId: "g_prod", connectionId: "eu-prod", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
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
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-A",
      }),
    );
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
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
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: null,
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "auto",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
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
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  // #3067 — REST-only focus is part of the sticky preference, so a fresh chat
  // seeds the preference's focus alongside its group/member.
  test("restores the preference's REST-only focus onto a fresh chat", () => {
    const decision = resolveEnvSelection(
      input({
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  // #3067 — a focus-only difference (group/member/mode/exclude all match, only
  // focus differs) must still restore rather than no-op.
  test("restores when only the REST-only focus differs", () => {
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        provenance: "default",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  // ── #3078 — REST scope has its OWN provenance, decoupled from SQL ──────
  //
  // Opening an all-null-SQL conversation that carried a non-empty exclude-set
  // restores the exclude-set (marked `restProvenance: "explicit"`) but defers
  // the SQL scope to a seed. The seed/restore effect re-runs with SQL
  // provenance "unset" — and MUST NOT clobber the explicit REST scope with the
  // default-seed empty set (the data-loss bug) nor with the sticky preference.

  test("preserves the current exclude-set on a SQL seed when restProvenance is explicit (#3078)", () => {
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: ["stripe"],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        provenance: "unset",
        restProvenance: "explicit",
      }),
    );
    // SQL seeds the group primary; the explicit REST scope is preserved, NOT
    // reset to [] — this is the #3078 data-loss fix.
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
      restExcludedDatasourceIds: ["stripe"],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("preserves the current REST-only focus on a SQL seed when restProvenance is explicit (#3078)", () => {
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        provenance: "unset",
        restProvenance: "explicit",
      }),
    );
    expect(decision).toEqual({
      kind: "seed",
      groupId: "g_prod",
      connectionId: "us-prod",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  test("an explicit REST scope wins over the sticky preference's REST on a SQL restore (#3078)", () => {
    // SQL restores from the workspace-matching preference, but the explicit REST
    // scope (e.g. just restored from the opened conversation) is authoritative —
    // the preference's REST must NOT overwrite it.
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: ["stripe"],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        provenance: "unset",
        restProvenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: ["stripe"],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("no-ops (no churn) when SQL already matches and the explicit REST scope is unchanged (#3078)", () => {
    // After the seed/restore effect has applied the SQL scope, a re-run with the
    // same explicit REST scope must settle to noop rather than loop forever
    // (the passthrough must agree with the no-churn guard).
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: ["stripe"],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        provenance: "explicit",
        restProvenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  test("no-ops on the RESTORE branch when SQL already matches and explicit REST is unchanged (#3078 loop guard)", () => {
    // Distinct from the test above, which short-circuits at the
    // `provenance === "explicit"` early-return. Here `provenance` is "default"
    // (NOT "explicit"), so the resolver actually REACHES the restore-branch
    // no-churn guard — the one most prone to a loop, because `restExplicit`
    // derives `nextRestExcluded` from `current` and compares it back against
    // `current`. If that derivation ever diverged from the returned decision's
    // REST fields, the effect would re-write state every run and churn forever.
    // The exclude-set differs from the preference's, so the passthrough is what
    // makes the guard agree → noop.
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: ["stripe"],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        provenance: "default",
        restProvenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({ kind: "noop" });
  });

  test("an explicit REST-only focus wins over the preference's focus on a SQL restore (#3078)", () => {
    // Symmetric to the exclude-set passthrough on restore: the explicit focus
    // (e.g. restored from the opened conversation) survives the SQL restore-from-
    // preference rather than being overwritten by the preference's focus.
    const decision = resolveEnvSelection(
      input({
        current: {
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        provenance: "unset",
        restProvenance: "explicit",
        preference: {
          workspaceId: "org-1",
          groupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "github",
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  // ── #3078 — zero-group (REST-only) workspace: REST-only seed/restore ───
  //
  // With no SQL groups there's nothing to seed for SQL, but the sticky REST
  // preference must still seed a fresh chat (ADR-0011). Codex flagged that the
  // old `groups.length === 0 → wait` gate blocked this, so a zero-group user's
  // exclusions never carried to a new chat.

  test("waits on an empty group list until the fetch has settled (no premature REST seed)", () => {
    expect(
      resolveEnvSelection(
        input({
          groups: [],
          groupsLoaded: false,
          preference: {
            workspaceId: null,
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["stripe"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
        }),
      ).kind,
    ).toBe("wait");
  });

  test("restores the sticky REST preference on a fresh chat in a zero-group workspace (#3078)", () => {
    const decision = resolveEnvSelection(
      input({
        groups: [],
        groupsLoaded: true,
        preference: {
          workspaceId: "org-1",
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: ["stripe"],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    // SQL stays null (no groups); the REST exclude-set is seeded from the pref.
    expect(decision).toEqual({
      kind: "restore",
      groupId: null,
      connectionId: null,
      routingMode: null,
      restExcludedDatasourceIds: ["stripe"],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("restores the sticky REST-only focus on a fresh chat in a zero-group workspace (#3078)", () => {
    const decision = resolveEnvSelection(
      input({
        groups: [],
        groupsLoaded: true,
        preference: {
          workspaceId: "org-1",
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        activeWorkspaceId: "org-1",
      }),
    );
    expect(decision).toEqual({
      kind: "restore",
      groupId: null,
      connectionId: null,
      routingMode: null,
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  test("ignores a different workspace's REST preference in a zero-group workspace (#3078)", () => {
    expect(
      resolveEnvSelection(
        input({
          groups: [],
          groupsLoaded: true,
          preference: {
            workspaceId: "org-B",
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["stripe"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
          activeWorkspaceId: "org-A",
        }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("no-ops a zero-group workspace when the current REST scope already matches the preference (#3078)", () => {
    expect(
      resolveEnvSelection(
        input({
          groups: [],
          groupsLoaded: true,
          current: {
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["stripe"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
          preference: {
            workspaceId: "org-1",
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["stripe"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
          activeWorkspaceId: "org-1",
        }),
      ),
    ).toEqual({ kind: "noop" });
  });

  test("does not clobber an explicit REST scope in a zero-group workspace (#3078)", () => {
    // A conversation-open restore / user toggle marked REST explicit; the
    // sticky preference must not overwrite it even on a zero-group workspace.
    expect(
      resolveEnvSelection(
        input({
          groups: [],
          groupsLoaded: true,
          current: {
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["github"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
          restProvenance: "explicit",
          preference: {
            workspaceId: "org-1",
            groupId: null,
            connectionId: null,
            routingMode: null,
            restExcludedDatasourceIds: ["stripe"],
            restFocusDatasourceId: null,
            groupReach: null,
          },
          activeWorkspaceId: "org-1",
        }),
      ),
    ).toEqual({ kind: "noop" });
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
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("preserves an 'auto' routing mode (mode is a first-class scope dimension)", () => {
    // routingMode is a first-class scope dimension — assert it explicitly so a
    // restore can never silently lose the mode (a prior slice regressed this).
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "us-prod", routingMode: "auto" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "auto", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("preserves an 'all' routing mode", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "us-prod", routingMode: "all" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "all", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
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
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("legacy conversation with an omitted routing mode defaults to null", () => {
    // routingMode is optional on the wire type — an older SDK/peer may omit
    // it entirely. Coalesce the missing field to null rather than undefined.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: null, restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("seeds (defers) for a fully-null row — never makes nulls authoritative", () => {
    // Codex finding 1: an all-null legacy/API-created row marked `explicit`
    // would show a fallback chip while the transport sent nulls. Defer instead.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: null, routingMode: null },
        groups,
      ),
    ).toEqual({ kind: "seed", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("seeds when the row's group has been archived / is no longer visible", () => {
    // Codex finding 2: a since-removed group restored verbatim would be sent to
    // the chat route and rejected (invalid_connection_group). Defer to seeding.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_archived", connectionId: "old-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "seed", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("repairs an archived member to the group primary when the group still resolves", () => {
    // The group is still valid but the pinned member is gone — keep the group,
    // repair the execution target to the primary rather than sending a stale id.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "ap-prod-archived", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("repairs a group-only row (null member, e.g. Auto) to the group primary", () => {
    // An Auto/All conversation may carry a group but no pinned member. Restore
    // the group + its primary as the displayed target, preserving the mode.
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: null, routingMode: "auto" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "us-prod", routingMode: "auto", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("falls back to members[0] when repairing under a group with no primary", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_staging", connectionId: "gone", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_staging", connectionId: "us-staging", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
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
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: "all", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("still seeds a fully-null row even when groups have not loaded", () => {
    // Emptiness is decided before the groups-loaded gate — an all-null row is
    // never authoritative regardless of load state.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: null, routingMode: null },
        [],
      ),
    ).toEqual({ kind: "seed", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("restores a legacy group-less row by locating the group that owns its connection", () => {
    // Reachable production state (migration 0067 only backfilled the group for
    // rows whose connection still joined): connectionId set, connectionGroupId
    // null. The PIN must be preserved — locate the owning group rather than
    // seeding, which would let the effect send a different member and silently
    // switch environments (Codex #3074). NON-primary `eu-prod` so a regression
    // to the default can't be masked by the primary.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: "eu-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "restore", groupId: "g_prod", connectionId: "eu-prod", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("seeds a legacy group-less row only when its connection no longer exists in any group", () => {
    // The connection was genuinely removed — nothing to pin, so defer to seed.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: "deleted-conn", routingMode: "pin" },
        groups,
      ),
    ).toEqual({ kind: "seed", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  test("optimistically restores a legacy group-less row (null group) on cold-start", () => {
    // Same row before groups load: can't locate the owner yet, so trust it
    // verbatim — the null group is carried through, and the transport sends the
    // real connectionId so the route still pins correctly. Locks that the
    // emptiness short-circuit requires BOTH ids null, not either.
    expect(
      resolveConversationScope(
        { connectionGroupId: null, connectionId: "eu-prod", routingMode: "pin" },
        [],
      ),
    ).toEqual({ kind: "restore", groupId: null, connectionId: "eu-prod", routingMode: "pin", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
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
    ).toEqual({ kind: "seed", restExcludedDatasourceIds: [], restFocusDatasourceId: null, groupReach: null });
  });

  // #3067 — the row's REST-only focus is restored alongside the SQL scope, the
  // same way as the exclude-set (carried on every `restore` decision).
  test("restores the row's REST-only focus alongside the SQL scope", () => {
    expect(
      resolveConversationScope(
        {
          connectionGroupId: "g_prod",
          connectionId: "eu-prod",
          routingMode: "pin",
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        groups,
      ),
    ).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  // #3067 — an absent focus column coalesces to null (not focused).
  test("coalesces an absent REST-only focus column to null", () => {
    expect(
      resolveConversationScope(
        { connectionGroupId: "g_prod", connectionId: "eu-prod", routingMode: "pin" },
        groups,
      ),
    ).toEqual({
      kind: "restore",
      groupId: "g_prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  // ── #3078 — REST scope survives an all-null SQL seed (data-loss fix) ───
  //
  // The REST scope is independent of SQL routing, so it must be carried on the
  // `seed` decision too — not just `restore`. Before #3078, a `seed` dropped the
  // exclude-set, and `handleSelectConversation` then cleared it; because the
  // transport always sends the array, the next turn sent `[]` and wiped the
  // persisted exclusions. The row's REST scope must come back regardless of the
  // SQL-scope decision.

  test("carries a non-empty exclude-set on a seed when the SQL scope is all-null (#3078)", () => {
    expect(
      resolveConversationScope(
        {
          connectionGroupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: ["stripe"],
        },
        groups,
      ),
    ).toEqual({
      kind: "seed",
      restExcludedDatasourceIds: ["stripe"],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("carries REST-only focus on a seed when the SQL scope is all-null (#3078)", () => {
    expect(
      resolveConversationScope(
        {
          connectionGroupId: null,
          connectionId: null,
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        groups,
      ),
    ).toEqual({
      kind: "seed",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });

  test("carries the exclude-set on a seed when the row's group is archived (#3078)", () => {
    // The SQL group is gone (→ seed), but the REST exclude-set is still valid and
    // independent of the SQL group, so it must survive.
    expect(
      resolveConversationScope(
        {
          connectionGroupId: "g_archived",
          connectionId: "old-prod",
          routingMode: "pin",
          restExcludedDatasourceIds: ["stripe", "github"],
        },
        groups,
      ),
    ).toEqual({
      kind: "seed",
      restExcludedDatasourceIds: ["stripe", "github"],
      restFocusDatasourceId: null,
      groupReach: null,
    });
  });

  test("carries REST-only focus on a seed when the row's group is archived (#3078)", () => {
    // Symmetric to the exclude-set case — a regression that dropped focus
    // specifically on the archived-group seed path would otherwise slip through.
    expect(
      resolveConversationScope(
        {
          connectionGroupId: "g_archived",
          connectionId: "old-prod",
          routingMode: "pin",
          restFocusDatasourceId: "stripe",
          groupReach: null,
        },
        groups,
      ),
    ).toEqual({
      kind: "seed",
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: "stripe",
      groupReach: null,
    });
  });
});

// ---------------------------------------------------------------------------
// #3895 (ADR-0022 §5) — Group reach axis: All sources (default) | Focus → group,
// with member routing nested under a focused multi-member group.
// ---------------------------------------------------------------------------
describe("ChatEnvPicker — Group reach axis (#3895)", () => {
  afterEach(() => cleanup());

  const twoGroups: ChatEnvGroup[] = [
    {
      id: "g_prod",
      name: "prod",
      primaryConnectionId: "us-prod",
      members: [
        { connectionId: "eu-prod", dbType: "postgres", description: null },
        { connectionId: "us-prod", dbType: "postgres", description: null },
      ],
    },
    {
      id: "g_analytics",
      name: "analytics",
      primaryConnectionId: null,
      members: [{ connectionId: "warehouse", dbType: "clickhouse", description: null }],
    },
  ];

  test("multi-group default (no reach) shows the 'All sources' chip + reach chooser, no member routing", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId={null}
        activeConnectionId={null}
        activeGroupReach={null}
        onSelect={noop}
      />,
    );
    expect(
      container.querySelector('[data-testid="chat-env-picker-label"]')?.textContent,
    ).toBe("All sources");
    expect(
      container.querySelector('[data-testid="chat-env-picker-trigger"]')?.getAttribute("data-reach"),
    ).toBe("all");
    // The reach chooser is present and "All sources" is active.
    const all = container.querySelector('[data-testid="chat-env-picker-reach-all"]');
    expect(all?.getAttribute("data-active")).toBe("true");
    // Both groups are offered as Focus targets.
    expect(container.querySelector('[data-testid="chat-env-picker-reach-focus-g_prod"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-env-picker-reach-focus-g_analytics"]')).not.toBeNull();
    // Member routing is NOT shown under All sources (no single group).
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).toBeNull();
  });

  test("Focus on a multi-member group reveals nested member routing + marks the focus active", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId="g_prod"
        activeConnectionId="us-prod"
        activeRoutingMode="auto"
        activeGroupReach="g_prod"
        onSelect={noop}
      />,
    );
    // Reach focus marked active.
    expect(
      container.querySelector('[data-testid="chat-env-picker-reach-focus-g_prod"]')?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="chat-env-picker-reach-all"]')?.getAttribute("data-active"),
    ).toBe("false");
    // Member routing IS shown (focused group has >1 member).
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-env-picker-member-eu-prod"]')).not.toBeNull();
  });

  test("Focus on a single-member group hides member routing (nothing to route)", () => {
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId="g_analytics"
        activeConnectionId="warehouse"
        activeGroupReach="g_analytics"
        onSelect={noop}
      />,
    );
    expect(container.querySelector('[data-testid="chat-env-picker-reach-focus-g_analytics"]')?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).toBeNull();
  });

  test("selecting 'All sources' emits a cleared selection (reach + member binding both null)", () => {
    let captured: ChatEnvSelection | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId="g_prod"
        activeConnectionId="us-prod"
        activeGroupReach="g_prod"
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    container
      .querySelector<HTMLElement>('[data-testid="chat-env-picker-reach-all"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect<ChatEnvSelection | null>(captured).toEqual({
      groupReach: null,
      groupId: null,
      connectionId: null,
      routingMode: null,
    });
  });

  test("selecting 'Focus → group' emits a focus selection with the group's primary member + Auto", () => {
    let captured: ChatEnvSelection | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId={null}
        activeConnectionId={null}
        activeGroupReach={null}
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    container
      .querySelector<HTMLElement>('[data-testid="chat-env-picker-reach-focus-g_prod"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect<ChatEnvSelection | null>(captured).toEqual({
      groupReach: "g_prod",
      groupId: "g_prod",
      connectionId: "us-prod",
      routingMode: "auto",
    });
  });

  test("changing member routing under Focus preserves the reach (does not widen to All)", () => {
    let captured: ChatEnvSelection | null = null;
    const { container } = render(
      <ChatEnvPicker
        groups={twoGroups}
        activeGroupId="g_prod"
        activeConnectionId="us-prod"
        activeRoutingMode="auto"
        activeGroupReach="g_prod"
        onSelect={(next) => {
          captured = next;
        }}
      />,
    );
    container
      .querySelector<HTMLElement>('[data-testid="chat-env-picker-member-eu-prod"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(captured!.groupReach).toBe("g_prod");
    expect(captured!.connectionId).toBe("eu-prod");
    expect(captured!.routingMode).toBe("pin");
  });

  test("a single-group workspace shows no reach chooser (reach is trivial)", () => {
    const oneGroup: ChatEnvGroup[] = [twoGroups[0]];
    const { container } = render(
      <ChatEnvPicker
        groups={oneGroup}
        activeGroupId="g_prod"
        activeConnectionId="us-prod"
        activeRoutingMode="pin"
        activeGroupReach={null}
        onSelect={noop}
      />,
    );
    // No reach chooser for a single-group workspace…
    expect(container.querySelector('[data-testid="chat-env-picker-reach-all"]')).toBeNull();
    // …but member routing for the sole multi-member group is still available.
    expect(container.querySelector('[data-testid="chat-env-picker-mode-auto"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #3895 — reach threading through the pure seed/restore resolvers.
// ---------------------------------------------------------------------------
describe("resolveEnvSelection / resolveConversationScope — Group reach (#3895)", () => {
  const g = (id: string, members: string[]): ChatEnvGroup => ({
    id,
    name: id,
    primaryConnectionId: members[0] ?? null,
    members: members.map((c) => ({ connectionId: c, dbType: "postgres", description: null })),
  });
  const emptyPref = {
    workspaceId: null,
    groupId: null,
    connectionId: null,
    routingMode: null,
    restExcludedDatasourceIds: [],
    restFocusDatasourceId: null,
    groupReach: null,
  };
  const baseInput = (overrides: Partial<ResolveEnvSelectionInput>): ResolveEnvSelectionInput => ({
    groups: [g("g_a", ["a"]), g("g_b", ["b"])],
    current: {
      groupId: null,
      connectionId: null,
      routingMode: null,
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
    },
    provenance: "unset",
    restProvenance: "unset",
    groupReachProvenance: "unset",
    preference: emptyPref,
    activeWorkspaceId: null,
    preferenceHydrated: true,
    sessionResolved: true,
    groupsLoaded: true,
    ...overrides,
  });

  test("a MULTI-group fresh chat with no preference defaults to All sources — no group is bound", () => {
    // The ADR-0022 flip: a multi-group workspace no longer focus-seeds the first
    // group; it starts at All sources (the agent ranges every group).
    const decision = resolveEnvSelection(baseInput({}));
    // Either noop (already at the All-sources default) or a seed that binds no
    // group — never a focus-first-group seed.
    if (decision.kind === "seed") {
      expect(decision.groupId).toBeNull();
      expect(decision.groupReach).toBeNull();
    } else {
      expect(decision.kind).toBe("noop");
    }
  });

  test("seeds the Group reach from a workspace-matching sticky preference (Focus restored on a fresh chat)", () => {
    const decision = resolveEnvSelection(
      baseInput({
        activeWorkspaceId: "org-1",
        preference: {
          ...emptyPref,
          workspaceId: "org-1",
          groupId: "g_a",
          connectionId: "a",
          routingMode: "pin",
          groupReach: "g_a",
        },
      }),
    );
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.groupReach).toBe("g_a");
      expect(decision.groupId).toBe("g_a");
    }
  });

  test("a sticky preference's Focus on a NO-LONGER-VISIBLE group falls back to All sources (never lies)", () => {
    // The pref's member routing points at a VISIBLE group (g_a/a) so the restore
    // branch fires and actually computes nextGroupReach = prefReach — but the
    // pref's *reach* is g_archived, which is no longer in `groups`. Seeding Focus
    // on a gone group would lie, so prefReach coalesces to null = All sources.
    // (Member routing for g_a still restores — reach is the independent axis.)
    const decision = resolveEnvSelection(
      baseInput({
        activeWorkspaceId: "org-1",
        preference: {
          ...emptyPref,
          workspaceId: "org-1",
          groupId: "g_a",
          connectionId: "a",
          routingMode: "pin",
          groupReach: "g_archived", // gone → must fall back to All, not restore Focus
        },
      }),
    );
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.groupId).toBe("g_a");
      // The reach falls back to All sources rather than restoring a Focus on a
      // group the workspace can no longer see.
      expect(decision.groupReach).toBeNull();
    }
  });

  test("passes an explicit reach through a SQL seed instead of clobbering it (reach provenance decoupled)", () => {
    // A conversation-open restore set the reach authoritative ("explicit") while
    // the SQL member routing must still seed → the reach must survive.
    const decision = resolveEnvSelection(
      baseInput({
        current: {
          groupId: null,
          connectionId: null,
          routingMode: null,
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: "g_b",
        },
        groupReachProvenance: "explicit",
      }),
    );
    // Whatever the SQL decision, the explicit reach passes through unchanged.
    if (decision.kind === "restore" || decision.kind === "seed") {
      expect(decision.groupReach).toBe("g_b");
    }
  });

  test("resolveConversationScope restores the row's Group reach on a restore", () => {
    const decision = resolveConversationScope(
      {
        connectionGroupId: "g_a",
        connectionId: "a",
        routingMode: "pin",
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: "g_a",
      },
      [g("g_a", ["a"])],
    );
    expect(decision.kind).toBe("restore");
    expect(decision.groupReach).toBe("g_a");
  });

  test("resolveConversationScope carries the row's Group reach even when the SQL scope defers to seed", () => {
    // All-null SQL scope → SQL seed, but the row's reach (independent axis) is
    // still restored verbatim (like the REST scope, #3078).
    const decision = resolveConversationScope(
      {
        connectionGroupId: null,
        connectionId: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: "g_a",
      },
      [g("g_a", ["a"])],
    );
    expect(decision.kind).toBe("seed");
    expect(decision.groupReach).toBe("g_a");
  });
});

