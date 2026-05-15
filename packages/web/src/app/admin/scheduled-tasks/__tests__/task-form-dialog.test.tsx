/**
 * Component tests for the scheduled-task create/edit dialog (#2418).
 *
 * Locks the zero-environment guard so a regression can't re-introduce
 * the footgun where Save remains active with `connectionGroupId: null`,
 * letting a first-time admin create a dangling task that fires forever
 * against the default connection with no signal.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";

// Dialog primitives portal their content. The test runs against the
// rendered tree, so we stub them to passthrough divs — the same pattern
// env-picker.test.tsx uses for dropdown-menu. CLAUDE.md "Mock all exports"
// applies: stub every named export so a sibling test importing a
// different symbol doesn't trip a SyntaxError under the isolated runner.
mock.module("@/components/ui/dialog", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, open: _open, onOpenChange: _onOpenChange, ...rest }: {
      children?: ReactNode;
      asChild?: boolean;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  return {
    Dialog: div,
    DialogTrigger: div,
    DialogPortal: div,
    DialogOverlay: div,
    DialogContent: div,
    DialogHeader: div,
    DialogFooter: div,
    DialogTitle: passthrough("h2"),
    DialogDescription: passthrough("p"),
    DialogClose: div,
  };
});

mock.module("@/components/ui/select", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, value: _value, onValueChange: _onValueChange, ...rest }: {
      children?: ReactNode;
      asChild?: boolean;
      value?: string;
      onValueChange?: (v: string) => void;
    } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  return {
    Select: div,
    SelectGroup: div,
    SelectValue: passthrough("span"),
    SelectTrigger: div,
    SelectContent: div,
    SelectLabel: div,
    SelectItem: div,
    SelectSeparator: passthrough("hr"),
    SelectScrollUpButton: div,
    SelectScrollDownButton: div,
  };
});

mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({
    apiUrl: "http://localhost",
    isCrossOrigin: false,
  }),
}));

const mutateMock = mock(async () => undefined);
mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: mutateMock,
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

mock.module("@/ui/components/admin/mutation-error-surface", () => ({
  MutationErrorSurface: () => null,
}));

import { render, cleanup, waitFor } from "@testing-library/react";

// Imported after mocks register.
const { TaskFormDialog } = await import("../task-form-dialog");

interface FetchMock {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  mockClear?: () => void;
}

function installFetchMock(groups: unknown[]): FetchMock {
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ groups }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as FetchMock;
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  // The footer's primary button is the only one not labelled Cancel.
  const buttons = Array.from(container.querySelectorAll("button"));
  const save = buttons.find(
    (b) => /^(Create|Save)$/.test(b.textContent?.trim() ?? ""),
  );
  if (!save) throw new Error("Save/Create button not found in rendered tree");
  return save as HTMLButtonElement;
}

beforeEach(() => {
  mutateMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("TaskFormDialog — zero-environment guard (#2418)", () => {
  test("disables Save when there are no environments configured", async () => {
    // Pre-fix this test fails: the dialog disables only the environment
    // select, leaving Save active. The user can submit a body carrying
    // `connectionGroupId: null` and the task fires forever against the
    // default connection with no signal. Post-fix the guard moves to
    // Save itself, so the only path forward is to create an environment
    // first.
    installFetchMock([]);

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    // Wait for the in-flight `fetchGroups()` useEffect to land and
    // commit `groups = []` to state. Without this the test reads the
    // pre-fetch render where `groups` is still the initial empty array
    // and the guard hasn't been evaluated yet.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(true);
    });
  });

  test("surfaces an empty-state banner pointing to /admin/connections when no environments exist", async () => {
    // The disabled button alone is a dead end — surfacing *why* it's
    // disabled and *where* to go closes the loop for a first-time admin.
    // Copy bound here so a future banner-redesign that drops the link
    // can't pass silently.
    installFetchMock([]);

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("Create an environment first");
    });
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="/admin/connections"]',
    );
    expect(link).not.toBeNull();
  });

  test("Save is enabled (subject to the rest of validation) when at least one environment exists", async () => {
    // Regression guard for the inverse: a non-empty groups list must not
    // accidentally disable Save. The button is only blocked by the
    // groups-empty predicate, not by the mutation's `saving` state in
    // the steady-state render.
    installFetchMock([
      {
        id: "g_prod",
        name: "Production",
        memberCount: 1,
        resolvedConnectionId: "conn-1",
      },
    ]);

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(getSaveButton(container).disabled).toBe(false);
    });
  });

  test("strips the `__global__:` prefix at render — the user-facing artifact of #2417", async () => {
    // Migration 0070 leaves rows alone when the rename would collide
    // with an existing tenant group name. The display-layer strip is
    // the only thing preventing those rows from rendering as
    // `__global__:cg_xyz` in the dropdown — drop it and the original
    // #2417 leak is back. The trailing `(<memberCount>)` is the
    // marker we use to confirm we matched the rendered SelectItem.
    installFetchMock([
      {
        id: "g_leak",
        name: "__global__:g_leak",
        memberCount: 2,
        resolvedConnectionId: "conn-leak",
      },
    ]);

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("g_leak (2)");
    });
    expect(container.textContent).not.toContain("__global__:");
  });

  test("strips the `g_` prefix at render — mirrors env-picker/columns parity", async () => {
    // 0062 backfills group_id as `g_<connId>` and name as `<connId>`.
    // Admin renames to a `g_`-prefixed label are the only path that
    // produces a `g_` in the name column; the strip survives that
    // case across env-picker.tsx, connections/columns.tsx, and here.
    // A regression that drops the `g_` arm here would silently leak
    // it back into this one surface and the parity comment would lie.
    installFetchMock([
      {
        id: "g_staging",
        name: "g_staging",
        memberCount: 1,
        resolvedConnectionId: "conn-staging",
      },
    ]);

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("staging (1)");
    });
    // Sanity: the unstripped label would have ended `g_staging (1)`.
    expect(container.textContent).not.toContain("g_staging (1)");
  });

  test("clears cached groups on refetch so a stale array can't keep Save enabled", async () => {
    // Codex P2 regression: a first successful fetch populates `groups`
    // with one environment. A subsequent fetch that returns `[]` (or
    // fails) must reset the state so the disabled-Save predicate kicks
    // back in. Without the `setGroups([])` clear, the previous group
    // would survive in state and Save would stay enabled with a
    // dangling `connectionGroupId` — exactly the footgun this PR is
    // trying to remove.
    //
    // Simulates the reopen path by toggling `open` false→true with a
    // different fetch response on the second pass. Two rerenders, one
    // remount of the effect's dep set via `open`.
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount += 1;
      const groups = callCount === 1
        ? [{ id: "g_p", name: "Production", memberCount: 1, resolvedConnectionId: "c1" }]
        : [];
      return new Response(JSON.stringify({ groups }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container, rerender } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );
    await waitFor(() => expect(getSaveButton(container).disabled).toBe(false));

    rerender(
      <TaskFormDialog
        open={false}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );
    rerender(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => expect(callCount).toBe(2));
    await waitFor(() => expect(getSaveButton(container).disabled).toBe(true));
  });

  test("surfaces a destructive alert with a Retry control when the fetch fails", async () => {
    // The Save button is disabled while groups is []; without an
    // actionable failure surface the admin would see a greyed-out
    // dialog and a muted error and have no path forward except
    // closing and reopening. The destructive variant + Retry button
    // close that gap (silent-failure-hunter MEDIUM-1).
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      <TaskFormDialog
        open={true}
        onOpenChange={() => {}}
        task={null}
        onSuccess={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("Could not load environments");
    });
    expect(container.textContent).toContain("(HTTP 500)");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retry).not.toBeUndefined();
    expect(getSaveButton(container).disabled).toBe(true);
  });
});
