/**
 * Regression: the pending-changes pill hides at zero drafts, but it must not
 * take an OPEN publish modal down with it.
 *
 * `PendingChangesPill` renders `<PublishModal>` from inside its own subtree and
 * early-returns `null` once `totalDrafts === 0`. Publishing is precisely what
 * drives that count to zero — so once publish began invalidating the count (so
 * the pill stops reading a stale "N pending"), a clean publish carrying an
 * incomplete-layer warning (#3682) unmounted the modal at the instant the
 * warning became true. The admin got a toast and nothing to read.
 *
 * The refused-drafts path never showed this, because refused drafts stay drafts
 * and the count stays non-zero. Only the layers-warning path both reaches zero
 * AND needs the modal to survive.
 *
 * Caught by review, not by use.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";

void mock.module("sonner", () => ({
  toast: Object.assign(() => {}, {
    success: () => {},
    warning: () => {},
    error: () => {},
    info: () => {},
    message: () => {},
    loading: () => {},
    custom: () => {},
    dismiss: () => {},
    promise: () => {},
  }),
  Toaster: () => null,
}));

// The pill is admin-gated; the role hook is the only thing between the
// component and a null render, so pin it rather than build a session.
void mock.module("@/ui/hooks/use-platform-admin-guard", () => ({
  useUserRole: () => "owner",
}));

// Drive the draft count directly — this test is about what the pill does as
// the count crosses to zero, not about how the count is fetched. Read through
// a getter so a mid-test change is visible to the next render without the
// module factory identity changing (an unstable factory hangs the runner).
let draftCounts: Record<string, number> = { prompts: 1 };
void mock.module("@/ui/hooks/use-mode-status", () => ({
  useModeStatus: () => ({ data: { draftCounts }, loading: false }),
}));

// Stand in for the real modal: the claim under test is that the pill keeps it
// MOUNTED, which is a statement about the pill's tree, not the modal's content.
void mock.module("@/ui/components/admin/publish-modal", () => ({
  PublishModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="publish-modal">modal</div> : null,
}));

import { PendingChangesPill } from "../pending-changes-pill";

const testConfig = {
  apiUrl: "http://localhost:3001",
  isCrossOrigin: false,
  authClient: {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: async () => {},
    useSession: () => ({ data: null, isPending: false }),
  },
};

function pillTree(): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>
        <PendingChangesPill />
      </AtlasProvider>
    </QueryClientProvider>
  );
}

/** Open the popover, then the modal, the way an admin does. */
function openModal(): void {
  fireEvent.click(screen.getByRole("button", { name: /pending/i }));
  fireEvent.click(screen.getByRole("button", { name: /review & publish/i }));
}

afterEach(() => {
  cleanup();
  draftCounts = { prompts: 1 };
});

describe("PendingChangesPill as the draft count reaches zero", () => {
  test("an OPEN publish modal survives the count dropping to zero", () => {
    const { rerender } = rtlRender(pillTree());
    openModal();
    expect(screen.getByTestId("publish-modal")).toBeDefined();

    // What a successful publish does: the count the pill reads goes to zero.
    draftCounts = {};
    rerender(pillTree());

    // The pill itself is gone — that part of the zero behaviour is intended.
    expect(screen.queryByRole("button", { name: /pending/i })).toBeNull();
    // The modal is NOT. This is the assertion the fix owes: deleting the
    // zero-case modal render turns this red while every other test stays green.
    expect(screen.getByTestId("publish-modal")).toBeDefined();
  });

  test("with the modal CLOSED, zero drafts still renders no pill", () => {
    // The counterpart: keeping the modal mounted must not resurrect the pill,
    // or "hidden at zero" would have quietly become "always shown".
    draftCounts = {};
    rtlRender(pillTree());

    expect(screen.queryByRole("button", { name: /pending/i })).toBeNull();
    expect(screen.queryByTestId("publish-modal")).toBeNull();
  });
});
