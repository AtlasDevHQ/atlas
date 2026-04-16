/**
 * Shared action shape for developer-mode empty states and their
 * published-context wrapper. Tagged with `kind` so structural narrowing is
 * exhaustive and object literals typed at a call site can't silently ship
 * with both `href` and `onClick` fields.
 */
export type EmptyStateAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "button"; label: string; onClick: () => void };

/**
 * Singular/plural pair for a resource label. Passed as a pair rather than
 * letting the callee suffix "s", so irregular plurals ("entity" → "entities")
 * render correctly in aria-labels and user-facing copy.
 */
export interface ResourceLabel {
  readonly singular: string;
  readonly plural: string;
}
