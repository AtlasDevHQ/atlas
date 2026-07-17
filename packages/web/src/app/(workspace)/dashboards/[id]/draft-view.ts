/**
 * Canvas draft-view decision (#4556, ADR-0034 / CONTEXT.md § Dashboard editing).
 *
 * The pinned Canvas contract: the canvas renders the caller's DRAFT whenever they
 * have one, the published state otherwise. This is the single, pure statement of
 * that rule — the page keys its dashboard fetch (`?view=draft` vs. published) off
 * it, and the draft-status banner reads the SAME `hasDraft`, so the two can never
 * disagree (the bug this fixed: a returning viewer of a never-published,
 * agent-built board saw an empty published copy underneath a "Draft — unpublished
 * changes" banner — two elements contradicting each other on one screen).
 *
 * `editing` and `chatOpen` remain in the OR because both edit the draft and must
 * show it even in the brief window before the async draft-status fetch lands —
 * e.g. a fresh `createDashboard` handoff whose cards were just staged into the
 * draft while the published view is still empty.
 */
export interface DraftViewInputs {
  /** The board is open in the inline editor. */
  readonly editing: boolean;
  /** The bound chat drawer is open (every edit lands in the draft). */
  readonly chatOpen: boolean;
  /**
   * The caller has a draft for this board. Undefined while the lightweight
   * `GET /:id/draft/status` presence check is still in flight — treated as "no
   * draft yet" so first paint shows published, then flips to draft the moment
   * the status resolves (the URL is the fetch cache key, so the view re-fetches).
   */
  readonly hasDraft: boolean | undefined;
}

/**
 * Whether the canvas should render the caller's draft view rather than the
 * published view. Drives both the dashboard fetch's `view=draft` cache key and
 * (via the same `hasDraft`) the draft-status banner, so they stay in lockstep.
 */
export function resolveShowDraftView({ editing, chatOpen, hasDraft }: DraftViewInputs): boolean {
  return editing || chatOpen || hasDraft === true;
}
