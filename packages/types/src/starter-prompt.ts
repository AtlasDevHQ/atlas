/**
 * Adaptive starter prompt types (#1474, PRD #1473).
 *
 * Wire format for `GET /api/v1/starter-prompts` and its SDK / widget / notebook
 * consumers. Lives in `@useatlas/types` so the SDK (`@useatlas/sdk`), React
 * embeddable (`@useatlas/react`), and web frontend can all import the same
 * shape without redeclaring.
 */

/** Source of a starter prompt. Used for UI badging and telemetry. */
export type StarterPromptProvenance =
  | "favorite"
  | "popular"
  | "library"
  | "cold-start";

/**
 * A single starter prompt as returned to the client.
 *
 * `id` is namespaced by tier (e.g. `library:<uuid>`, `favorite:<pinId>`) so
 * two tiers returning rows with the same raw id never collide on React keys.
 */
export interface StarterPrompt {
  readonly id: string;
  readonly text: string;
  readonly provenance: StarterPromptProvenance;
}

/** Response envelope for `GET /api/v1/starter-prompts`. */
export interface StarterPromptsResponse {
  readonly prompts: ReadonlyArray<StarterPrompt>;
  readonly total: number;
}
