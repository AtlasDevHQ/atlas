/**
 * One-shot cleanup — deletes `workspace_action_credentials` rows that are
 * PARTIAL: rows whose decrypted bundle does not satisfy every `required: true`
 * field of the target's spec as it stands today (#5564).
 *
 * ── Why a script and not SQL ──────────────────────────────────────────────
 *
 * The bundle is one AES-256-GCM ciphertext column (`credentials_encrypted`),
 * so Postgres cannot see the fields inside it. No `DO $$` block, no CHECK
 * constraint, and no numbered migration can decide which rows are partial —
 * the decision needs the encryption key and the target registry, which is to
 * say it needs application code. That is a consequence of encryption at rest,
 * not an oversight, and it is the same reason the completeness invariant lives
 * in the admin route rather than in the schema. This file is therefore a
 * companion helper with no numbered migration to accompany, like
 * `slack_installations_to_chat_cache.ts` and `backfill-crm-leads.ts`; the
 * cleanup it performs has no DDL half.
 *
 * ── ⚠️ THIS MUST NEVER BECOME A RECURRING SWEEP ───────────────────────────
 *
 * It is correct exactly once, against the field specs as they exist at the
 * moment it runs. `ACTION_TARGETS` is live code: the day a target's spec gains
 * a `required: true` field, EVERY stored row for that target becomes partial
 * at once, by definition and through no fault of the workspaces that own them.
 * A scheduled or startup sweep would at that moment silently delete every
 * customer's credentials for that target — their Jira API token, their GitHub
 * App private key — none of which they can read back and re-enter from Atlas.
 *
 * So: no scheduler registration, no `registerPeriodicFiber`, no call from
 * `migrate.ts`, and no promotion to an `atlas-operator` subcommand that could
 * be wired into a cron. The right response to a spec that grew a required
 * field is the status API reporting `partial-row` and an admin completing the
 * entry — which is precisely why the partial states still exist in the response
 * even though the write path can no longer create one. The hazard is about
 * future customers, so it holds even though there are none today.
 *
 * ── What it does NOT delete ───────────────────────────────────────────────
 *
 *   - Rows for a target with no registered spec. "Unmanaged" means the
 *     registry cannot say what complete looks like, not that the row is junk —
 *     a target can be temporarily out of the registry across a revert.
 *   - Rows that fail to decrypt or fail the string→string shape check. That is
 *     corruption, and whether corruption is repaired or discarded is a
 *     different decision from this one. Both are reported, never removed.
 *
 * Invocation (DRY RUN unless `--confirm`):
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/purge_partial_action_credentials.ts
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/purge_partial_action_credentials.ts --confirm
 *
 * Prod run date: NOT YET RUN.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see packages/api/src/lib/tools/actions/credentials/resolver.ts — `missingRequiredFor`
 */

import { Client } from "pg";
import { z } from "zod";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { getActionTarget } from "@atlas/api/lib/tools/actions/credentials/targets";
import { missingRequiredFor } from "@atlas/api/lib/tools/actions/credentials/resolver";

/**
 * The one code path this script touches, so its unit tests are decoupled from
 * `pg.Client`. Mirrors the driver's `{ rows }` shape.
 */
export interface PurgeDB {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Same shape check the store applies on every read — see `store.ts`. */
const BundleSchema: z.ZodType<Record<string, string>> = z.record(z.string(), z.string());

export interface StoredCredentialRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  target: string;
  credentials_encrypted: string;
}

export type RowVerdict =
  /** A managed target, decrypts cleanly, and misses at least one required field. */
  | { kind: "partial"; missing: string[] }
  /** A managed target satisfied in full. */
  | { kind: "complete" }
  /** No spec claims this target — the registry cannot say what complete means. */
  | { kind: "unmanaged" }
  /** Decrypt or shape validation failed. Corruption, not incompleteness. */
  | { kind: "unreadable"; reason: string };

/**
 * Decide one row's fate, using the SAME predicate the resolver and the admin
 * write path use. Sharing it is the point: a script with its own notion of
 * "partial" could delete a row the runtime considers fine.
 *
 * Pure over its inputs (the decrypt is the only side-effect-free dependency it
 * carries), so the classification is testable without a database.
 */
export function classifyRow(row: StoredCredentialRow): RowVerdict {
  const spec = getActionTarget(row.target);
  if (!spec) return { kind: "unmanaged" };

  let bundle: Record<string, string>;
  try {
    bundle = BundleSchema.parse(JSON.parse(decryptSecret(row.credentials_encrypted)));
  } catch (err) {
    // The message is deliberately NOT carried through: `JSON.parse` embeds its
    // input in the error, and the input here is a decrypted tenant bundle
    // (#4984). The kind and the row identity are the whole diagnostic.
    return {
      kind: "unreadable",
      reason: err instanceof z.ZodError ? "not a string→string map" : "decrypt or JSON parse failed",
    };
  }

  const missing = missingRequiredFor(spec, (key) => bundle[key]);
  return missing.length === 0 ? { kind: "complete" } : { kind: "partial", missing };
}

export interface PurgeSummary {
  scanned: number;
  partial: number;
  complete: number;
  unmanaged: number;
  unreadable: number;
  deleted: number;
}

/**
 * Scan every stored row and delete the partial ones.
 *
 * `confirm: false` (the default at the CLI) classifies and reports without
 * writing, because the alternative is a script whose first run is also its
 * only chance to be wrong.
 */
export async function purgePartialRows(
  db: PurgeDB,
  opts: { confirm: boolean; log?: (line: string) => void } = { confirm: false },
): Promise<PurgeSummary> {
  const emit = opts.log ?? ((line: string) => console.log(line));
  const { rows } = await db.query<StoredCredentialRow>(
    `SELECT id, workspace_id, target, credentials_encrypted
       FROM workspace_action_credentials
      ORDER BY workspace_id, target`,
  );

  const summary: PurgeSummary = {
    scanned: rows.length,
    partial: 0,
    complete: 0,
    unmanaged: 0,
    unreadable: 0,
    deleted: 0,
  };
  const doomed: string[] = [];

  for (const row of rows) {
    const verdict = classifyRow(row);
    switch (verdict.kind) {
      case "complete":
        summary.complete += 1;
        break;
      case "unmanaged":
        summary.unmanaged += 1;
        emit(`  SKIP  ${row.workspace_id}/${row.target} — no registered spec, leaving it alone`);
        break;
      case "unreadable":
        summary.unreadable += 1;
        emit(
          `  SKIP  ${row.workspace_id}/${row.target} — ${verdict.reason}; corruption is a separate decision, leaving it alone`,
        );
        break;
      case "partial":
        summary.partial += 1;
        doomed.push(row.id);
        // Env-var NAMES only, the same convention the audit rows follow.
        emit(`  PARTIAL ${row.workspace_id}/${row.target} — missing ${verdict.missing.join(", ")}`);
        break;
    }
  }

  if (doomed.length > 0 && opts.confirm) {
    const { rows: removed } = await db.query<{ id: string }>(
      `DELETE FROM workspace_action_credentials WHERE id = ANY($1::uuid[]) RETURNING id`,
      [doomed],
    );
    summary.deleted = removed.length;
  }

  emit(
    `scanned=${summary.scanned} partial=${summary.partial} complete=${summary.complete} ` +
      `unmanaged=${summary.unmanaged} unreadable=${summary.unreadable} deleted=${summary.deleted}`,
  );
  if (doomed.length > 0 && !opts.confirm) {
    emit("DRY RUN — re-run with --confirm to delete the rows listed above.");
  }
  return summary;
}

// `import.meta.main` so importing this module from a test does not open a
// database connection.
if (import.meta.main) {
  const confirm = process.argv.includes("--confirm");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Missing required env var: DATABASE_URL");
    process.exit(2);
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await purgePartialRows(client, { confirm });
  } finally {
    await client.end();
  }
}
