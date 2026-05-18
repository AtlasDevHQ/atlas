/**
 * Symlink-stub surface for `@atlas/ee/governance/approval`. Mirrors the
 * single export the rest of the workspace dynamic-imports from this
 * path — `packages/mcp/src/actor.ts:114` calls
 * `anyApprovalRuleEnabled()` before short-circuiting writes that
 * would trigger an approval gate. With no EE installed there are no
 * approval rules, so the no-op yields `false` and writes proceed
 * unguarded (correct semantics for self-hosted, where the approval
 * subsystem is enterprise-gated).
 *
 * Not used at runtime — the symlink-stub CI job is the only consumer.
 * Keep this file's exported names in lockstep with whatever
 * `ee/src/governance/approval.ts` actually exports that other workspace
 * packages (mcp, sandbox-sidecar, etc.) dynamically import.
 */
import { Effect } from "effect";

export const anyApprovalRuleEnabled = (): Effect.Effect<boolean, never> => Effect.succeed(false);
