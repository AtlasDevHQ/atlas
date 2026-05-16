import { describe, expect, test, mock, beforeEach } from "bun:test";
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
  return {
    DropdownMenu: div,
    DropdownMenuPortal: div,
    DropdownMenuTrigger: div,
    DropdownMenuContent: div,
    DropdownMenuGroup: div,
    DropdownMenuItem: div,
    DropdownMenuCheckboxItem: div,
    DropdownMenuRadioGroup: div,
    DropdownMenuRadioItem: div,
    DropdownMenuLabel: div,
    DropdownMenuSeparator: hr,
    DropdownMenuShortcut: passthrough("span"),
    DropdownMenuSub: div,
    DropdownMenuSubTrigger: div,
    DropdownMenuSubContent: div,
  };
});

import { render, cleanup } from "@testing-library/react";
import { ChatEnvPicker, type ChatEnvGroup } from "../components/chat/env-picker";

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
