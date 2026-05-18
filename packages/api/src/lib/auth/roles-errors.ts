/**
 * Custom-role error class — promoted to core in #2571 so the
 * `RolesPolicy` Tag in `lib/effect/services.ts` can type its failure
 * channel without core importing from `@atlas/ee`.
 *
 * EE's `ee/src/auth/roles.ts` re-exports for back-compat. The structural
 * identity (`_tag` + payload) means existing `instanceof` checks and
 * `domainError(...)` mappings work unchanged.
 */

import { Data } from "effect";

export type RoleErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "builtin_protected";

export class RoleError extends Data.TaggedError("RoleError")<{
  message: string;
  code: RoleErrorCode;
}> {}
