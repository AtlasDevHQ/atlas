/**
 * Regression guard for `<IdentitySection>` (#2261).
 *
 * PR #2256 fixed a subtle bug where the dirty flag stayed set after a
 * successful save + `session.refetch()`. The cause: the `useEffect` that
 * resyncs `name` from session data only fires when `!dirty && !saving`, so
 * the flush has to land in the *post-saving* render — not while `saving` is
 * still true. A naive resync that ran in every render would clobber the
 * user's draft mid-edit; the fix has to keep both invariants:
 *
 *   - typing changes name → dirty=true
 *   - save → API succeeds → refetch flushes session.data.user.name → dirty=false
 *
 * This file pins both. The session mock is mutable so the test can simulate
 * Better Auth resolving the refetched user shape between renders.
 *
 * `mock.module(...)` covers every named export of `@/lib/auth/client` so a
 * sibling test importing a different export doesn't trip a partial-mock
 * SyntaxError.
 */

import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

interface MockUser {
  email: string;
  name?: string;
}

let currentUser: MockUser | null = null;
let refetchCalls = 0;

// Re-render mechanism — Better Auth's real `useSession` subscribes to a
// store; we approximate that with a forceUpdate counter that consumers can
// nudge. `session.refetch()` bumps the counter so the component re-reads
// `currentUser` via the new render.
let forceUpdateTick = 0;
const subscribers = new Set<() => void>();
function notify() {
  forceUpdateTick++;
  for (const fn of subscribers) fn();
}

const updateUserMock = mock(
  async (_opts: { name: string }): Promise<{ error?: { message?: string } | null }> => ({
    error: null,
  }),
);

mock.module("@/lib/auth/client", () => ({
  authClient: {
    updateUser: (opts: { name: string }) => updateUserMock(opts),
    useSession: () => {
      // The component reads `session.data?.user` and `session.refetch`; the
      // tick is in the hook body so React captures a stable reference per
      // render but re-runs the hook on each `notify()`.
      void forceUpdateTick;
      // Subscribe each render so notify() can trigger a forceUpdate in the
      // consumer via the use-sync-external-store-like trick below.
      return {
        data: currentUser ? { user: currentUser } : null,
        isPending: false,
        refetch: () => {
          refetchCalls++;
          // The default behaviour is "refetch returns the same data" — tests
          // that want to simulate a server update mutate `currentUser` first
          // and then trigger the rerender via `notify()`.
          notify();
        },
      };
    },
  },
}));

import { IdentitySection } from "@/ui/components/settings/identity-section";

// A wrapper that subscribes to `notify()` so the component re-renders when
// the mocked session changes — without this, our mutable `currentUser`
// updates wouldn't reach React's reconciliation.
import { useEffect, useState } from "react";
function Harness() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return <IdentitySection />;
}

beforeEach(() => {
  currentUser = { email: "user@example.com", name: "Alice" };
  refetchCalls = 0;
  forceUpdateTick = 0;
  updateUserMock.mockReset();
  updateUserMock.mockImplementation(async () => ({ error: null }));
});

afterEach(() => {
  cleanup();
  subscribers.clear();
});

function getNameInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>("#profile-name");
  if (!el) throw new Error("display-name input not rendered");
  return el;
}

function getSaveButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!el) throw new Error("save button not rendered");
  return el;
}

describe("IdentitySection — dirty-state derivation", () => {
  test("returns null when no session user is loaded", () => {
    currentUser = null;
    const { container } = render(<Harness />);
    expect(container.textContent).toBe("");
  });

  test("initial render: name input is seeded from session, save is disabled", () => {
    render(<Harness />);
    expect(getNameInput().value).toBe("Alice");
    expect(getSaveButton().disabled).toBe(true);
  });

  test("typing changes name → dirty=true → save enables", () => {
    render(<Harness />);

    fireEvent.change(getNameInput(), { target: { value: "Alice Updated" } });

    expect(getNameInput().value).toBe("Alice Updated");
    expect(getSaveButton().disabled).toBe(false);
  });

  test("blank-only edits don't flip dirty (whitespace trims to the same value)", () => {
    render(<Harness />);
    // "Alice " trimmed equals "Alice" — not dirty.
    fireEvent.change(getNameInput(), { target: { value: "Alice " } });
    expect(getSaveButton().disabled).toBe(true);
  });
});

describe("IdentitySection — save + refetch flushes dirty back to false (#2256 regression)", () => {
  test("save → API succeeds → refetched session.data.user.name flushes → dirty resets", async () => {
    render(<Harness />);

    // 1. User types a new name — dirty=true.
    fireEvent.change(getNameInput(), { target: { value: "Alice Updated" } });
    expect(getSaveButton().disabled).toBe(false);

    // 2. Submit. Drive the API mock so that *during the refetch*, the
    //    mutable session user reflects the new name — that's the server
    //    "saw the update" half of the flow.
    updateUserMock.mockImplementation(async (opts) => {
      currentUser = { email: "user@example.com", name: opts.name };
      return { error: null };
    });

    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });

    // 3. Refetch was called exactly once.
    await waitFor(() => {
      expect(refetchCalls).toBe(1);
    });

    // 4. The saved confirmation shows up — sanity check that the success
    //    path ran end to end.
    expect(document.body.textContent).toContain("Saved.");

    // 5. Critical assertion: after the refetch flushed `user.name = "Alice
    //    Updated"`, the trimmed-name comparison resolves dirty=false and
    //    the save button re-disables. This is the exact regression from
    //    PR #2256 — losing it means a saved form stays "dirty" forever.
    await waitFor(() => {
      expect(getSaveButton().disabled).toBe(true);
    });
    expect(getNameInput().value).toBe("Alice Updated");
  });

  test("API error: refetch is NOT called and dirty state is preserved", async () => {
    updateUserMock.mockImplementation(async () => ({
      error: { message: "Name too long" },
    }));

    render(<Harness />);

    fireEvent.change(getNameInput(), { target: { value: "Alice Updated" } });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name too long");
    });

    // No refetch — the server rejected the update.
    expect(refetchCalls).toBe(0);
    // Dirty preserved — the user's draft hasn't been clobbered.
    expect(getNameInput().value).toBe("Alice Updated");
    expect(getSaveButton().disabled).toBe(false);
  });

  test("a session refetch that drifts the user's name does NOT clobber an active edit", async () => {
    render(<Harness />);

    // User starts editing — dirty=true.
    fireEvent.change(getNameInput(), { target: { value: "Mid-edit" } });
    expect(getSaveButton().disabled).toBe(false);

    // An unrelated refetch lands (e.g. another tab updated the org). The
    // session resync guard (`!dirty && !saving`) must hold — the active
    // edit stays put.
    act(() => {
      currentUser = { email: "user@example.com", name: "Server Drift" };
      notify();
    });

    expect(getNameInput().value).toBe("Mid-edit");
    expect(getSaveButton().disabled).toBe(false);
  });
});
