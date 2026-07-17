/**
 * Canvas draft-view decision (#4556). Pins the pinned Canvas contract: the canvas
 * renders the caller's draft whenever they HAVE one, the published state
 * otherwise — driven off the caller's actual draft status, not just an open
 * editor/drawer. The regression this locks: arriving at a never-published,
 * agent-built board via bookmark/switcher (View mode, no editor) used to fetch
 * the empty published copy while the banner announced a draft — the two
 * contradicting each other on one screen.
 */
import { describe, expect, test } from "bun:test";
import { resolveShowDraftView } from "../draft-view";

describe("resolveShowDraftView (#4556)", () => {
  test("bookmark arrival at a board with a draft renders the draft (View mode, no editor)", () => {
    // The core case: the returning viewer has a draft but nothing is open. The
    // canvas must show the draft's cards, matching the "Draft" banner.
    expect(
      resolveShowDraftView({ editing: false, chatOpen: false, hasDraft: true }),
    ).toBe(true);
  });

  test("a caller with no draft sees published, unchanged", () => {
    expect(
      resolveShowDraftView({ editing: false, chatOpen: false, hasDraft: false }),
    ).toBe(false);
  });

  test("draft status still in flight shows published (no draft yet) until it resolves", () => {
    // First paint before the async status fetch lands: treat undefined as "no
    // draft yet" so we don't flash a draft view for a caller who has none.
    expect(
      resolveShowDraftView({ editing: false, chatOpen: false, hasDraft: undefined }),
    ).toBe(false);
  });

  test("editing shows the draft even before the status fetch lands", () => {
    // The inline editor edits the draft; it must show it immediately, without
    // waiting on the status round-trip.
    expect(
      resolveShowDraftView({ editing: true, chatOpen: false, hasDraft: undefined }),
    ).toBe(true);
  });

  test("open chat drawer shows the draft even before the status fetch lands", () => {
    // A fresh createDashboard handoff: cards were just staged into the draft
    // while the published view is still empty, so the drawer must show the draft.
    expect(
      resolveShowDraftView({ editing: false, chatOpen: true, hasDraft: undefined }),
    ).toBe(true);
  });

  test("the banner and the canvas can never disagree: both read the same hasDraft", () => {
    // The banner shows "Draft" iff hasDraft; the canvas shows the draft iff this
    // returns true. For a passive viewer (no editor/drawer) the two are exactly
    // the same boolean, so they cannot contradict each other.
    for (const hasDraft of [true, false]) {
      const bannerSaysDraft = hasDraft;
      const canvasShowsDraft = resolveShowDraftView({
        editing: false,
        chatOpen: false,
        hasDraft,
      });
      expect(canvasShowsDraft).toBe(bannerSaysDraft);
    }
  });
});
