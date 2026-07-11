/**
 * Improve-conversation anchors (#4519, PRD #4502; CONTEXT.md § Semantic
 * improvement → "Anchor") — the web side.
 *
 * An anchor is what a conversation launched from: a connection group ("improve
 * this database's layer") or a single entity. It is a **launcher, never a cage** —
 * it scopes the turn-one Briefing and rides every turn (so the briefing stays
 * scoped), while free-form typing keeps working anchored or not. A **sweep** is
 * simply the anchorless start.
 *
 * This module is the PURE, unit-testable core: the wire shape, the launcher
 * kick-off copy, the chip label, and the request-field rule (omit-when-null so an
 * anchorless request is byte-identical to the pre-anchor one). The page owns the
 * launcher UI + transport wiring; these functions carry the behavior worth
 * pinning. `ImproveAnchor` mirrors the server's local wire type
 * (`packages/api/src/lib/semantic/expert/anchor.ts`) — the improve surface keeps
 * its request/response types local rather than in `@useatlas/*`.
 */

/** The anchor an improve conversation carries. Absent ⇒ an anchorless sweep. */
export type ImproveAnchor =
  | { kind: "group"; group: string }
  | { kind: "entity"; entity: string; group?: string };

/**
 * The canned sweep kick-off ("find improvements") — the anchorless start. Kept
 * as the one source of the sweep copy so the header button and the empty-state
 * hint can't drift.
 */
export const SWEEP_KICKOFF_MESSAGE =
  "Analyze my semantic layer and identify the highest-impact improvements. Start with the most-queried tables and check for missing measures, stale descriptions, and undocumented joins.";

/**
 * The kick-off message a group launcher sends. `label` is the group's friendly
 * name (distinct from the group id the wire anchor carries).
 */
export function groupKickoffMessage(label: string): string {
  return `Let's improve the semantic layer for the "${label}" connection group. Start from its entities and the briefing, then propose the highest-impact amendments.`;
}

/** The kick-off message an entity launcher sends. `label` is the entity's name. */
export function entityKickoffMessage(label: string): string {
  return `Let's work on the "${label}" entity. Review its current YAML and profile from the briefing, then propose the highest-impact improvements.`;
}

/** The chip label for the active anchor shown in the conversation UI. */
export function describeAnchor(anchor: ImproveAnchor, label: string): string {
  return anchor.kind === "group" ? `Group: ${label}` : `Entity: ${label}`;
}

/**
 * The `/chat` request field for the active anchor. Omitted entirely when there is
 * no anchor, so an anchorless sweep (or plain free typing) sends exactly the body
 * it did before anchors existed (#4519 AC4).
 */
export function anchorRequestField(anchor: ImproveAnchor | null): { anchor?: ImproveAnchor } {
  return anchor ? { anchor } : {};
}
