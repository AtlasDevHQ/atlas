/**
 * The audience RE-VERIFIER seam (#4965) — how a source that is not Slack keeps
 * its audiences inside `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`.
 *
 * ## Why a seam rather than a second branch in `sync.ts`
 *
 * `runAudienceSyncCycle` is built around ONE source's shape: it scans
 * `slack-history` installs, reads a Slack directory, walks channel rosters, and
 * reconciles. Every step is Slack-specific, and the install scan is literally
 * parameterised by `SLACK_HISTORY_CATALOG_ID`. Adding a second `if` for Zoom
 * there would have doubled a 1,000-line function and made the third source
 * (Meet, Fireflies, email) a third branch.
 *
 * This is the same argument #4963 made for the CONNECTOR registry, applied to
 * the membership half: the cycle keeps the ONE thing every source shares — a
 * clock, isolation, and a place to report — and each source brings its own
 * re-verification. `sync.ts`'s edit is a registry drain, not a vendor branch.
 *
 * ## What a re-verifier is FOR, which is not what it sounds like
 *
 * "Re-verify" reads as "check whether the roster changed", and for a chat
 * channel that is exactly right. For a MEETING it is not: the participant list
 * is frozen the moment the meeting ends, and nobody joins a past meeting.
 *
 * The thing that changes is the RESOLUTION — which of those humans is an Atlas
 * user in this workspace right now. Someone leaves the org and must stop seeing
 * the meeting's facts; someone joins and should start. Both are membership
 * changes over an unchanged roster, and both are invisible unless something
 * re-runs the resolution.
 *
 * On top of that, `acl.ts` (#4808) suppresses any audience whose `synced_at` is
 * older than the staleness bound — default 168 hours. A meeting audience
 * written once at ingest and never touched again would therefore stop granting
 * a week later, silently, with the facts still stored and the sync still green.
 * That is the failure this seam exists to prevent, and it is the reason a
 * re-verifier is NOT optional for a source that mints `audience:` grants.
 *
 * ## The contract
 *
 * A re-verifier must be COMPLETE-OR-ABORT per audience, exactly as `sync.ts`
 * is: `reconcileAudienceMembership` deletes everyone outside the roster it is
 * handed, so a partial read revokes what it failed to fetch. Aborting touches
 * nothing and the previous membership stands. It must never throw — the cycle
 * isolates and counts, and a throw would cost the other sources their pass.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("brain.audience.reverify");

/** What one re-verification pass accomplished. Summed into the cycle's report. */
export interface AudienceReverifyResult {
  /** Audiences whose membership was re-reconciled (including no-op re-stamps). */
  readonly reconciled: number;
  /** Audiences that aborted — a fault, an incomplete read; membership unchanged. */
  readonly failed: number;
  readonly membersAdded: number;
  readonly membersRevoked: number;
  /** Source principals that matched no Atlas user. Counted, never guessed. */
  readonly principalsUnresolved: number;
}

export const ZERO_REVERIFY: AudienceReverifyResult = Object.freeze({
  reconciled: 0,
  failed: 0,
  membersAdded: 0,
  membersRevoked: 0,
  principalsUnresolved: 0,
});

/**
 * One source's re-verification pass.
 *
 * Takes no arguments: a re-verifier owns its own scan, because "which audiences
 * are mine and which are stalest" is precisely the source-specific knowledge
 * this seam exists to keep out of the cycle. It must not throw — the drain
 * catches anyway, but a re-verifier that relies on that is one whose per-audience
 * isolation is missing.
 */
export type AudienceReverifier = () => Promise<AudienceReverifyResult>;

/** `source` (the stored `brain_episodes.source` kind) → its re-verifier. */
const registry = new Map<string, AudienceReverifier>();

/**
 * Register a source's audience re-verifier. Called once per source at wiring
 * time, keyed by the stored source kind so a duplicate registration is a loud
 * error rather than a silent overwrite — two re-verifiers for one source would
 * each reconcile against their own roster, and the loser's members would be
 * revoked on every cycle.
 */
export function registerAudienceReverifier(source: string, reverifier: AudienceReverifier): void {
  if (registry.has(source)) {
    throw new Error(`Audience re-verifier for source "${source}" is already registered`);
  }
  registry.set(source, reverifier);
}

export function listAudienceReverifierSources(): string[] {
  return [...registry.keys()];
}

/**
 * Run every registered re-verifier and sum the results.
 *
 * Each is isolated: one source's failure costs it its own pass and nothing
 * else. A throw is counted as a single failed audience rather than swallowed,
 * because `failed > 0` is what makes the cycle report `degraded` — a
 * re-verifier that died must not leave the cycle looking clean.
 */
export async function runRegisteredAudienceReverifiers(): Promise<AudienceReverifyResult> {
  let total = ZERO_REVERIFY;
  for (const [source, reverifier] of registry) {
    try {
      const out = await reverifier();
      total = {
        reconciled: total.reconciled + out.reconciled,
        failed: total.failed + out.failed,
        membersAdded: total.membersAdded + out.membersAdded,
        membersRevoked: total.membersRevoked + out.membersRevoked,
        principalsUnresolved: total.principalsUnresolved + out.principalsUnresolved,
      };
    } catch (err) {
      log.error(
        { source, err: err instanceof Error ? err.message : String(err) },
        "brain audience: a re-verifier threw past its own isolation — that source's audiences were not re-verified this cycle and will age toward the staleness bound",
      );
      total = { ...total, failed: total.failed + 1 };
    }
  }
  return total;
}

/** Test-only: clear the registry (tests register fixtures per-suite). */
export function _resetAudienceReverifiers(): void {
  registry.clear();
}
