/**
 * Capture the NAME behind each claim's actor handle (#5440, ADR-0036 §T5
 * `Amendment (2026-08-25, #5440)`).
 *
 * Runs as a step of the audience sync cycle, and that placement is the point:
 * the cycle already reads `users.list` once per workspace per cycle for the
 * membership join, so naming the authors costs one more query against
 * `brain_episodes` and no additional vendor traffic.
 *
 * ## ⚠️ The bound is AUTHORSHIP, and it is the whole of the reversal
 *
 * The directory this module is handed contains the WHOLE workspace. What it
 * persists is the intersection with
 * {@link AUTHORING_PRINCIPALS_SQL} — the principals whose episodes Atlas has
 * actually ingested. Persisting the directory itself would be a copy of the
 * customer's roster, which ADR-0036 refuses BY NAME, and the intersection is
 * what keeps the resolver's old sentence substantially true: what is stored
 * beyond *"which of my existing users are in which channel"* is the name of
 * someone whose WORDS ARE ALREADY IN THE RECORD.
 *
 * If you are about to widen this to `directory.values()`, stop and read the
 * amendment. That is the one change this file exists to make hard.
 *
 * ## Two populations this includes that the MEMBERSHIP half excludes
 *
 * `sync.ts` filters the directory to `liveHumans` — not deleted, not a bot —
 * before resolving audience membership, because a deactivated Slack user is
 * someone the workspace already revoked at the source and a bot has no account
 * to grant to. Naming inverts BOTH of those, deliberately:
 *
 *   - A **deactivated** user is exactly the case the `directory` state exists
 *     for. Their claims are still in the record; the vendor will stop answering
 *     for them; a name captured now is the only one there will ever be. Skipping
 *     them would make the record permanently unable to name the people it is
 *     most likely to be asked about.
 *   - A **bot** that authored an episode has a name that is not personal data at
 *     all, and rendering `slack:B01ABCDEF` when the answer is "Zapier" fails
 *     condition 2 for no privacy gain.
 *
 * Naming confers nothing — no membership, no grant, no entitlement — so the
 * revocation argument that governs the membership half does not reach here.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { SlackDirectoryUser } from "@atlas/api/lib/slack/api";
import {
  AUTHORING_PRINCIPALS_SQL,
  captureActorIdentities,
  type ActorIdentityCapture,
  type ActorIdentityReader,
} from "@atlas/api/lib/brain/actor-identity";

const log = createLogger("brain.audience.identity-capture");

/**
 * `internalQuery` in the `{ rows }` shape the identity module's SQL helpers
 * take.
 *
 * One adapter, here rather than in `actor-identity.ts`, so that module stays
 * free of a database handle and the two READ surfaces keep passing their own
 * already-open reader.
 */
export const internalIdentityReader: ActorIdentityReader = {
  query: async (sql, params) => ({ rows: await internalQuery(sql, params) }),
};

/** Per-cycle counters. Every arm is counted; nothing is a silent skip. */
export interface IdentityCaptureOutcome {
  /** Authors seen in `brain_episodes` for this workspace and source. */
  readonly authors: number;
  /** Resolved to an Atlas account — the name comes from a live join. */
  readonly atlas: number;
  /** Named by the vendor directory, no Atlas account — a dated snapshot. */
  readonly directory: number;
  /** The directory could not name them, so the record says so. */
  readonly opaque: number;
  /**
   * Writes the upsert's `WHERE` refused — an operator's erasure standing, or a
   * `directory → opaque` downgrade declined because a vendor going quiet about
   * someone is not evidence Atlas should forget them.
   *
   * NOT a failure, and counted rather than logged per row: both arms are
   * normal, and on a workspace with many departed guests the second would be a
   * log line per cycle per person forever.
   */
  readonly refused: number;
}

const ZERO: IdentityCaptureOutcome = {
  authors: 0,
  atlas: 0,
  directory: 0,
  opaque: 0,
  refused: 0,
};

interface AuthorRow {
  readonly actor: string | null;
  readonly source: string | null;
  readonly vendor_user_id: string | null;
}

/**
 * Decide one author's state from the two inputs the cycle already holds.
 *
 * Pure, and separated from the write so the three-state decision is testable
 * without a database — it is the part of this module a reviewer has to check.
 *
 * ⚠️ ORDER MATTERS. `atlas` wins over `directory` whenever both are available,
 * because a live join is strictly better than a snapshot: it stays current with
 * no re-derivation path needed. The reverse precedence would freeze a colleague's
 * name at the moment they happened to be ingested.
 */
export function decideIdentity(
  actor: string,
  source: string,
  vendorUserId: string,
  atlasUserId: string | undefined,
  entry: SlackDirectoryUser | undefined,
): ActorIdentityCapture {
  if (atlasUserId !== undefined && atlasUserId !== "") {
    return { actor, source, vendorUserId, state: "atlas", userId: atlasUserId };
  }
  const displayName = entry?.displayName ?? null;
  const realName = entry?.realName ?? null;
  const email = entry?.email ?? null;
  if (displayName !== null || realName !== null || email !== null) {
    return {
      actor,
      source,
      vendorUserId,
      state: "directory",
      displayName,
      realName,
      email,
    };
  }
  // The directory has no entry, or the entry names nobody — a Slack Connect
  // guest from another workspace, or a token without `users:read.email` against
  // a profile with no display or real name. `opaque` is a POSITIVE record of
  // that, not an absence: the surface must say "cannot name this person"
  // rather than render a blank or fall back to the handle.
  return { actor, source, vendorUserId, state: "opaque" };
}

export interface CaptureIdentitiesOptions {
  readonly workspaceId: string;
  /** The episode source these authors are keyed under — `slack`. */
  readonly source: string;
  /** The vendor directory, keyed by vendor user id. Read, never persisted whole. */
  readonly directory: ReadonlyMap<string, SlackDirectoryUser>;
  /** vendor user id → Atlas user id, from `resolvePrincipals`. */
  readonly resolved: ReadonlyMap<string, string>;
  readonly db?: ActorIdentityReader;
}

/**
 * Capture identities for every principal who authored an ingested episode.
 *
 * Never throws: an unwritable batch must not abort a cycle that also keeps
 * audience membership fresh, and the failure is recoverable on the next pass.
 * It is logged, not swallowed.
 */
export async function captureAuthoringIdentities(
  options: CaptureIdentitiesOptions,
): Promise<IdentityCaptureOutcome> {
  const { workspaceId, source, directory, resolved } = options;
  const db = options.db ?? internalIdentityReader;

  const result = await db.query(AUTHORING_PRINCIPALS_SQL, [workspaceId, source]);
  const rows = result.rows as readonly AuthorRow[];
  if (rows.length === 0) return ZERO;

  const captures: ActorIdentityCapture[] = [];
  for (const row of rows) {
    const actor = row.actor;
    const rowSource = row.source;
    const vendorUserId = row.vendor_user_id;
    if (
      typeof actor !== "string" ||
      actor === "" ||
      typeof rowSource !== "string" ||
      rowSource === "" ||
      typeof vendorUserId !== "string" ||
      vendorUserId === ""
    ) {
      // The SQL's own predicate makes this unreachable from the database, so it
      // is query drift. Never silent: a dropped author is a claim that stays
      // unnamed, which is the condition this whole slice exists to close.
      log.warn(
        { workspaceId, source },
        "brain actor identity: an authoring-principal row came back without a usable handle — the query shape changed; that author's claims stay opaque",
      );
      continue;
    }
    captures.push(
      decideIdentity(
        actor,
        rowSource,
        vendorUserId,
        resolved.get(vendorUserId),
        directory.get(vendorUserId),
      ),
    );
  }

  let written: ReadonlySet<string>;
  try {
    written = await captureActorIdentities(db, workspaceId, captures);
  } catch (err) {
    // ⚠️ A batch failure loses the WHOLE pass, where the per-row loop this
    // replaced lost one author. That is the accepted cost of not issuing one
    // round trip per author forever, and it is affordable because the pass is
    // idempotent and re-runs every cycle: the outcome is "these names arrive 30
    // minutes later", not "these names are lost".
    log.warn(
      {
        workspaceId,
        source,
        authors: captures.length,
        error: err instanceof Error ? err.message : String(err),
      },
      "brain actor identity: the capture write failed — every author's claims stay as they were; the next cycle retries",
    );
    return { ...ZERO, authors: rows.length };
  }

  let out = { ...ZERO, authors: rows.length };
  for (const capture of captures) {
    if (!written.has(capture.actor)) {
      out = { ...out, refused: out.refused + 1 };
      continue;
    }
    out =
      capture.state === "atlas"
        ? { ...out, atlas: out.atlas + 1 }
        : capture.state === "directory"
          ? { ...out, directory: out.directory + 1 }
          : { ...out, opaque: out.opaque + 1 };
  }

  log.info(
    { workspaceId, source, ...out },
    "brain actor identity: capture pass complete",
  );
  return out;
}
