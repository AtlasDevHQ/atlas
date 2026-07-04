/**
 * Draft status banner — discard confirm behaviour (#4323).
 *
 * The discard confirm must stay open until its async request resolves (Radix
 * otherwise auto-dismisses an AlertDialogAction on click, before the mutation
 * settles) and surface a failure IN PLACE rather than letting the dialog vanish
 * with the error appearing in a banner the user is no longer looking at.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DraftStatusBanner } from "../draft-status-banner";
import type { FetchError } from "@/ui/lib/fetch-error";

const noop = () => {};

const baseProps = {
  hasDraft: true,
  staleBaseline: false,
  editing: false,
  discardOpen: false,
  onDiscardOpenChange: noop,
  onPublish: noop,
  onDiscardConfirm: noop,
  onRebase: noop,
  publishing: false,
  discarding: false,
  rebasing: false,
  error: null as FetchError | null,
} as const;

describe("DraftStatusBanner — discard confirm (#4323)", () => {
  afterEach(cleanup);

  test("confirming discard fires onDiscardConfirm but does NOT auto-dismiss the dialog", () => {
    const onDiscardConfirm = mock(() => {});
    const onDiscardOpenChange = mock((_open: boolean) => {});
    render(
      <DraftStatusBanner
        {...baseProps}
        discardOpen
        onDiscardConfirm={onDiscardConfirm}
        onDiscardOpenChange={onDiscardOpenChange}
      />,
    );

    fireEvent.click(screen.getByTestId("draft-discard-confirm"));

    expect(onDiscardConfirm).toHaveBeenCalledTimes(1);
    // The dialog stays open — the parent closes it explicitly on success, not
    // Radix's default click-to-close.
    expect(onDiscardOpenChange).not.toHaveBeenCalled();
  });

  test("a discard failure surfaces inside the open dialog, not in the outer banner", () => {
    const error: FetchError = { message: "Draft is locked by another editor." };
    render(<DraftStatusBanner {...baseProps} discardOpen error={error} />);

    expect(screen.getByTestId("draft-discard-error").textContent).toContain(
      "Draft is locked by another editor.",
    );
    // While the dialog owns the failure surface, the banner-level error is
    // suppressed so the message isn't shown twice.
    expect(screen.queryByTestId("draft-error-banner")).toBeNull();
  });

  test("with the dialog closed, an error still renders in the banner", () => {
    const error: FetchError = { message: "Publish failed." };
    render(<DraftStatusBanner {...baseProps} discardOpen={false} error={error} />);
    expect(screen.getByTestId("draft-error-banner").textContent).toContain("Publish failed.");
  });
});
