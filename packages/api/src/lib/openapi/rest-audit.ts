/**
 * REST datasource → query-audit-log mapping.
 *
 * `executeSQL` records every execution to the query audit log via
 * {@link logQueryAudit}; the REST datasource path historically recorded only
 * `log.info` breadcrumbs, so a reviewer auditing "what did the agent do against
 * customer datasources" saw SQL but was blind to REST reads + confirmed writes.
 * This maps a DISPATCHED REST operation into the existing SQL-shaped
 * {@link AuditEntry} — NO schema change:
 *   - `sql`   — a clear NON-SQL descriptor (`${method} ${operationId}`, e.g.
 *               "GET listPeople"): greppable, obviously not SQL, and paired with
 *               `sourceId` which names the datasource.
 *   - `sourceId` — the REST datasource id.
 *   - `sourceType` — OMITTED. It is a SQL `DBType` and a REST datasource is not
 *               one; a null `sourceType` is already precedented (SOQL / custom
 *               validator entries).
 *   - `targetHost` — the upstream host, when the base URL parses.
 *   - `tablesAccessed` / `columnsAccessed` — left undefined (no SQL tables).
 *
 * Only TERMINAL, DISPATCHED outcomes are audited (the op actually reached the
 * upstream). Pre-dispatch rejections (no datasource, writes-disabled, invalid
 * params, rate-limited, unknown op, needs-confirmation) never touched the
 * datasource and stay as their existing `log.info` breadcrumbs.
 */
import { logQueryAudit } from "@atlas/api/lib/auth/audit";

/**
 * Trivially derive an item count from a REST response body: a TOP-LEVEL array's
 * length, else `null` (unknown — deliberately not conflated with a real zero for
 * failures). Kept intentionally shallow so it can't misreport a nested shape.
 */
export function deriveRestRowCount(body: unknown): number | null {
  return Array.isArray(body) ? body.length : null;
}

/** The upstream host for the audit row's `targetHost`, or undefined if the base URL can't be parsed. */
function restTargetHost(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).host;
    return host.length > 0 ? host : undefined;
  } catch {
    // intentionally ignored: a malformed baseUrl just omits targetHost from the row.
    return undefined;
  }
}

/** The dispatched outcome. Success carries a best-effort row count; failure carries the error message. */
export type RestAuditOutcome =
  | { readonly success: true; readonly rowCount: number | null }
  | { readonly success: false; readonly error: string };

export interface RestAuditInput {
  readonly method: string;
  readonly operationId: string;
  readonly datasourceId: string;
  readonly baseUrl: string;
  /** Wall-clock ms around the actual upstream dispatch. */
  readonly durationMs: number;
  readonly outcome: RestAuditOutcome;
}

/**
 * Record a DISPATCHED REST datasource operation to the query audit log. Mirrors
 * the `executeSQL` audit call so REST reads + confirmed writes are as visible to
 * a reviewer as SQL. Fire-and-forget (`logQueryAudit` guards its own DB write) —
 * call it only after the response data is determined.
 */
export function auditRestOperation(input: RestAuditInput): void {
  const targetHost = restTargetHost(input.baseUrl);
  const common = {
    sql: `${input.method} ${input.operationId}`,
    durationMs: input.durationMs,
    sourceId: input.datasourceId,
    ...(targetHost ? { targetHost } : {}),
  };
  if (input.outcome.success) {
    // AuditEntry's success variant requires a NUMERIC rowCount; an un-countable
    // success (the body isn't a top-level array) records 0 rather than failing
    // the type — the load-bearing audit signal is that the operation RAN.
    logQueryAudit({ ...common, success: true, rowCount: input.outcome.rowCount ?? 0 });
  } else {
    logQueryAudit({ ...common, success: false, rowCount: null, error: input.outcome.error });
  }
}
