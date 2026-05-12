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
import { useEffect, useState } from "react";

interface MockUser {
  email: string;
  name?: string;
}

let currentUser: MockUser | null = null;
let refetchCalls = 0;

// External-store simulation. Better Auth's real `useSession` subscribes
// through `useSyncExternalStore`; we approximate just enough of that here.
// Mutating `currentUser` alone isn't enough — React won't re-render unless
// something tells it to. `notify()` fans out to every mounted `Harness`
// instance, which holds a tiny `useState` counter so calling its listener
// schedules a render. The component then re-runs the mocked `useSession`
// and picks up the new `currentUser`.
const subscribers = new Set<() => void>();
function notify() {
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
    useSession: () => ({
      data: currentUser ? { user: currentUser } : null,
      isPending: false,
      refetch: () => {
        refetchCalls++;
        // Default behaviour: refetch returns the same data. Tests that
        // simulate a server update mutate `currentUser` *before* calling
        // refetch (or inside the `updateUser` mock, before resolving) so
        // that the subsequent `notify()` re-render reads the new shape.
        notify();
      },
    }),
  },
}));

import { IdentitySection } from "@/ui/components/settings/identity-section";

/**
 * The harness mounts `<IdentitySection>` once and exposes a single React
 * state-driven re-render handle to the module-level `notify()`. We can't
 * just call RTL's `rerender(<IdentitySection />)` from a test because that
 * would remount the component, and a fresh mount re-seeds `name` from the
 * new session data — masking the very dirty-flag bug we're trying to pin.
 * Keeping the *same* component instance and feeding it new `useSession()`
 * return values is what reproduces the post-save flush in production.
 */
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

function getForm(): HTMLFormElement {
  const el = document.querySelector<HTMLFormElement>("form");
  if (!el) throw new Error("identity form not rendered");
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
      fireEvent.submit(getForm());
    });

    // 3. Refetch was called exactly once.
    await waitFor(() => {
      expect(refetchCalls).toBe(1);
    });

    // 4. The mocked `updateUser` actually ran with the typed name — pin
    //    this so a future refactor that bypasses `authClient.updateUser`
    //    (e.g. swapping it for a fetch call) fails loudly instead of
    //    passing under a stale assertion.
    expect(updateUserMock.mock.calls.length).toBe(1);
    expect(updateUserMock.mock.calls[0]?.[0]).toEqual({ name: "Alice Updated" });

    // 5. The saved confirmation shows up — sanity check that the success
    //    path ran end to end.
    expect(document.body.textContent).toContain("Saved.");

    // 6. Critical assertion: after the refetch flushed `user.name = "Alice
    //    Updated"`, the trimmed-name comparison resolves dirty=false and
    //    the save button re-disables. This is the exact regression from
    //    PR #2256 — losing it means a saved form stays "dirty" forever.
    await waitFor(() => {
      expect(getSaveButton().disabled).toBe(true);
    });
    expect(getNameInput().value).toBe("Alice Updated");
  });

  test("API error: refetch is NOT called and dirty state is preserved", async () => {
    // Use `expect.assertions` to guarantee the rejection path actually
    // ran. Without it, a refactor that made the banner render via a
    // local-validation branch (no API call) could leave `refetchCalls`
    // at 0 and the dirty-state preservation assertions still pass — a
    // silent skip of the very branch this test is pinning.
    expect.assertions(5);

    updateUserMock.mockImplementation(async () => ({
      error: { message: "Name too long" },
    }));

    render(<Harness />);

    fireEvent.change(getNameInput(), { target: { value: "Alice Updated" } });
    await act(async () => {
      fireEvent.submit(getForm());
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Name too long");
    });

    // The mock was actually invoked — i.e. the API rejection path ran
    // rather than a local validation branch short-circuiting.
    expect(updateUserMock.mock.calls.length).toBe(1);
    // No refetch — the server rejected the update.
    expect(refetchCalls).toBe(0);
    // Dirty preserved — the user's draft hasn't been clobbered.
    expect(getNameInput().value).toBe("Alice Updated");
    expect(getSaveButton().disabled).toBe(false);
  });

  test("a session refetch that drifts the user's name does NOT clobber an active edit", () => {
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

  test("typing after a successful save dismisses the 'Saved.' banner", async () => {
    // Pins the savedAt-clears-on-edit branch in handleNameChange — without
    // it, the banner sticks around stale while the user types a new draft,
    // misrepresenting the form's state.
    updateUserMock.mockImplementation(async (opts) => {
      currentUser = { email: "user@example.com", name: opts.name };
      return { error: null };
    });

    render(<Harness />);

    fireEvent.change(getNameInput(), { target: { value: "Alice Updated" } });
    await act(async () => {
      fireEvent.submit(getForm());
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Saved.");
    });

    // A second edit starts — the success banner must go away.
    fireEvent.change(getNameInput(), { target: { value: "Alice Updated 2" } });
    expect(document.body.textContent).not.toContain("Saved.");
    expect(getSaveButton().disabled).toBe(false);
  });
});
