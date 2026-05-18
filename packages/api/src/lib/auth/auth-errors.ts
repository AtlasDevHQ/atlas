/**
 * Auth subsystem errors — promoted to core in #2570 so the three
 * Tags introduced in this slice (`IpAllowlistPolicy`, `SSOPolicy`,
 * `SCIMProvenance`) can type their failure channels without core
 * importing from `@atlas/ee`.
 *
 * EE's `ee/src/auth/{ip-allowlist,sso,scim}.ts` re-export each class
 * for back-compat. The structural identity (`_tag` + payload shape)
 * means existing `instanceof` checks and `domainError(...)` mappings
 * work unchanged whether the class is loaded from core or via the EE
 * re-export.
 */

import { Data } from "effect";

export type IPAllowlistErrorCode = "validation" | "conflict" | "not_found";

export class IPAllowlistError extends Data.TaggedError("IPAllowlistError")<{
  message: string;
  code: IPAllowlistErrorCode;
}> {}

export type SSOErrorCode = "not_found" | "conflict" | "validation";

export class SSOError extends Data.TaggedError("SSOError")<{
  message: string;
  code: SSOErrorCode;
}> {}

export type SSOEnforcementErrorCode = "no_provider" | "not_enterprise";

export class SSOEnforcementError extends Data.TaggedError("SSOEnforcementError")<{
  message: string;
  code: SSOEnforcementErrorCode;
}> {}

export type SCIMErrorCode = "not_found" | "conflict" | "validation";

export class SCIMError extends Data.TaggedError("SCIMError")<{
  message: string;
  code: SCIMErrorCode;
}> {}
