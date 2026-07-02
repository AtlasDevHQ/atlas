/**
 * Shared internal-DB transaction helper — the one home for the
 * BEGIN/COMMIT/ROLLBACK + `release(err)` discipline that was previously
 * copy-pasted into `admin-knowledge.ts`, `knowledge/sync.ts`, and
 * `admin-publish.ts` (one of which carried a "local copy because lib/ must not
 * import from api/routes/" comment — the seam belongs in `lib/db`, importable
 * from both sides).
 *
 * A failed ROLLBACK destroys the client (`release(err)`) so a dirty connection
 * can never poison the next borrower.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, type InternalPoolClient } from "@atlas/api/lib/db/internal";

const log = createLogger("internal-tx");

/**
 * Run `fn` inside a transaction on a dedicated internal-DB client. `label` is
 * a short caller identifier for the rollback-failure log line.
 */
export async function withInternalTransaction<T>(
  label: string,
  fn: (client: InternalPoolClient) => Promise<T>,
): Promise<T> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { label, err: rollbackErr.message },
        "ROLLBACK failed after transaction error — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}
