/**
 * Which first-party client a `/api/v1/chat` turn came from (#5496).
 *
 * `POST /api/v1/chat` serves two first-party clients over one URL — the
 * workspace web app (`packages/web`) and the embeddable widget
 * (`@useatlas/react`) — with the same auth modes, the same request shape and the
 * same `dashboardUrlResolver`. Nothing distinguished them server-side, which was
 * fine until a tool's availability came to depend on what the client can
 * RENDER: `correct_fact` stages a correction onto a confirm card, and only the
 * web app has one.
 *
 * ## Why this is not in `@useatlas/types`
 *
 * That is where it belongs on the merits — both ends must spell it identically
 * and neither package may import the other, which is exactly why `ATLAS_MODES`
 * lives there. But `@useatlas/types` is PUBLISHED, and the scaffold smoke test
 * builds the template against the version on npm: a new VALUE export does not
 * exist there until a release is cut, so it fails Scaffold CI at build time with
 * "Export ATLAS_SURFACE_HEADER doesn't exist in target module" — before the
 * publish-then-bump dance can catch up.
 *
 * `packages/web/src/ui/lib/rest-operation-types.ts` records the same constraint
 * and takes the same way out: a deliberate local mirror on each side, promoted
 * to `@useatlas/types` when a types release is cut for another reason. The web
 * half of this pair is `packages/web/src/ui/lib/correct-fact-types.ts`; the two
 * literals must stay identical, and the header on each says so.
 *
 * ⚠️ **A UX capability hint, never an authorization input.** Forging the header
 * can only get a correction STAGED. Every correction is still gated server-side
 * at `POST /api/v1/brain-corrections/confirm` — authority, ACL visibility, the
 * tier-1 refusal, vocabulary closure, and a single-use workspace-bound token.
 * Do not grow a permission check that reads it.
 */

/** The request header a chat client sends to identify itself. */
export const ATLAS_SURFACE_HEADER = "x-atlas-surface";

/** The workspace web app (`packages/web`) — the surface that renders confirm cards. */
export const ATLAS_WORKSPACE_SURFACE = "workspace";

/**
 * Whether this turn came from a surface that can render a confirm-before-write
 * card.
 *
 * Absence, and any unrecognized value, is `false` — the fail-closed direction,
 * so adding a client never silently grants it a capability it cannot complete.
 */
export function rendersConfirmations(headerValue: string | null | undefined): boolean {
  return headerValue === ATLAS_WORKSPACE_SURFACE;
}
