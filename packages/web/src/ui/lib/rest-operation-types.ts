/**
 * Web-local mirror of the `executeRestOperation` tool result shape (PRD #2868
 * slice 5, #2929) — only the fields the chat surface renders.
 *
 * This is a deliberate local mirror, not a `@useatlas/types` import: the wire
 * shape is produced by `packages/api/src/lib/tools/rest-operation.ts`
 * (`ExecuteRestOperationResult`), but pulling a new VALUE export through
 * `@useatlas/types` would require the publish-then-bump dance (and a new value
 * export trips Scaffold CI before it's published). The two shapes must stay in
 * sync; promote this to `@useatlas/types/rest-operation` when a types release is
 * cut for another reason — same trajectory the action-result types took.
 */

/** The replay payload the confirm-before-write banner POSTs to the confirm endpoint. */
export interface RestWriteConfirmRequest {
  datasourceId: string;
  operationId: string;
  pathParams?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  header?: Record<string, string | number | boolean>;
  body?: unknown;
  /**
   * Server-signed, single-use confirm token (#3007). Opaque to the banner — it
   * POSTs the whole `confirm` payload (including this token) verbatim; the confirm
   * endpoint verifies it matches the staged write, then burns it so a replay is
   * rejected. Always present on a `needs_confirmation` result from the API.
   */
  token: string;
}

/** The `needs_confirmation` arm — an allowlisted write staged for human confirmation. */
export interface RestWriteConfirmResult {
  status: "needs_confirmation";
  method: string;
  operationId: string;
  datasourceId: string;
  datasourceName: string;
  summary: string;
  confirm: RestWriteConfirmRequest;
}

/** Narrow an unknown tool result to the `needs_confirmation` arm. */
export function isRestWriteConfirmResult(result: unknown): result is RestWriteConfirmResult {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r.status === "needs_confirmation" &&
    typeof r.operationId === "string" &&
    typeof r.summary === "string" &&
    typeof r.confirm === "object" &&
    r.confirm !== null
  );
}

/** The confirm endpoint's success response (`POST /api/v1/rest-operations/confirm`). */
export interface RestWriteConfirmResponse {
  status: "executed" | "http_error";
  httpStatus: number;
  body: unknown;
  message?: string;
}

/** A compact view of any other `executeRestOperation` status, for the read/result line. */
export function getRestOperationStatus(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const status = (result as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

/** Best-effort human message off any error-shaped REST result arm. */
export function getRestOperationMessage(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const message = (result as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
