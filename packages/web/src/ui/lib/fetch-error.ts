/**
 * Structured error from a failed fetch operation.
 * May represent an HTTP error response (with status and optional requestId)
 * or a network-level failure (status undefined).
 *
 * `code` captures the machine-readable `error` field from the API's JSON body
 * (e.g. `"enterprise_required"`). Prefer branching on this over string-matching
 * the human-facing `message`.
 *
 * `enrollmentUrl` is enrollment-specific — populated only when `code` is
 * `mfa_enrollment_required`. A future typed code that needs its own
 * redirect target (e.g. `payment_required` → upgrade URL) should add a
 * dedicated field rather than reuse this one. Reusing the field for a
 * non-enrollment redirect would mislead readers and shadow the existing
 * one when both codes coexist on the wire.
 */
export interface FetchError {
  message: string;
  status?: number;
  requestId?: string;
  code?: string;
  enrollmentUrl?: string;
  /**
   * Candidate groups returned with a 409 `entity_ambiguous` response
   * (#2412). The UI uses this to render a disambiguation picker
   * instead of a wall-of-text error. `null` entries represent legacy
   * unscoped rows (`__global__` / pre-backfill); keep them so the
   * picker can offer "legacy / global" as a distinct choice.
   */
  groups?: ReadonlyArray<string | null>;
  /**
   * Candidate workspaces returned with a 400 `workspace_ambiguous` response
   * (#3157) — a platform admin changing the role of a user who belongs to more
   * than one workspace. The `/platform/users` page renders a picker from these
   * and retries with an explicit `organizationId` instead of dead-ending on the
   * error.
   */
  workspaces?: ReadonlyArray<{ id: string; name: string | null }>;
  /**
   * The freshly-computed live diff + its baseline hash returned with a 409
   * `stale_baseline` response (#4511) — a semantic Amendment whose entity
   * changed since the admin rendered the diff. The improve panel swaps the
   * card's diff in place and offers a Confirm that re-approves with this
   * `baselineHash`, turning a mid-review change into one more human look
   * instead of an error dead-end.
   */
  stale?: { diff: string; baselineHash: string };
}

/**
 * Construct a {@link FetchError} with an empty-message invariant.
 *
 * `MutationErrorSurface` / `ErrorBanner` / `InlineError` render `error.message`
 * directly for non-gated statuses — an empty string produces alert chrome with
 * no copy, indistinguishable from a successful render. This helper is the
 * single point of enforcement: in development it throws so the regression
 * surfaces during review, and in production it substitutes a generic string so
 * the banner has something to render plus a `console.warn` for Sentry
 * breadcrumbs.
 *
 * System boundaries — `extractFetchError` HTTP path and `useAdminFetch`
 * network-error fallback — route through this helper so the invariant is
 * codified once.
 */
export function buildFetchError(input: {
  message?: string;
  status?: number;
  code?: string;
  requestId?: string;
  enrollmentUrl?: string;
  groups?: ReadonlyArray<string | null>;
  workspaces?: ReadonlyArray<{ id: string; name: string | null }>;
  stale?: { diff: string; baselineHash: string };
}): FetchError {
  const message = input.message?.trim();
  if (!message) {
    const fallback = `Request failed (${input.status ?? "unknown"})`;
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `[buildFetchError] refused to construct FetchError with empty message. ` +
          `status=${input.status} code=${input.code} requestId=${input.requestId}`,
      );
    }
    console.warn(
      `[buildFetchError] empty message, substituting generic. status=${input.status}`,
    );
    return {
      message: fallback,
      ...(input.status !== undefined && { status: input.status }),
      ...(input.code && { code: input.code }),
      ...(input.requestId && { requestId: input.requestId }),
      ...(input.enrollmentUrl && { enrollmentUrl: input.enrollmentUrl }),
      ...(input.groups && { groups: input.groups }),
      ...(input.workspaces && { workspaces: input.workspaces }),
      ...(input.stale && { stale: input.stale }),
    };
  }
  return {
    message,
    ...(input.status !== undefined && { status: input.status }),
    ...(input.code && { code: input.code }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.enrollmentUrl && { enrollmentUrl: input.enrollmentUrl }),
    ...(input.groups && { groups: input.groups }),
    ...(input.workspaces && { workspaces: input.workspaces }),
    ...(input.stale && { stale: input.stale }),
  };
}

/**
 * Extract a structured error from a failed fetch response.
 * Parses the JSON body for `message`, `error` (machine-readable code), and
 * `requestId` fields; falls back to a status-only message if the body isn't JSON.
 */
export async function extractFetchError(res: Response): Promise<FetchError> {
  let message: string | undefined;
  let requestId: string | undefined;
  let code: string | undefined;
  let enrollmentUrl: string | undefined;
  let groups: ReadonlyArray<string | null> | undefined;
  let workspaces: ReadonlyArray<{ id: string; name: string | null }> | undefined;
  let stale: { diff: string; baselineHash: string } | undefined;
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      // Require a non-empty message so a server returning `{ message: "" }`
      // (intentional, misconfigured, or truncated) doesn't clobber the
      // `HTTP ${status}` fallback — downstream helpers silently drop empty
      // messages (`combineMutationErrors` filters them, `friendlyError`
      // renders blank banners for non-gated status codes).
      if (typeof obj.message === "string" && obj.message.length > 0) {
        message = obj.message;
      }
      if (typeof obj.requestId === "string") requestId = obj.requestId;
      if (typeof obj.error === "string") code = obj.error;
      if (typeof obj.enrollmentUrl === "string" && obj.enrollmentUrl.length > 0) {
        enrollmentUrl = obj.enrollmentUrl;
      }
      // 409 `entity_ambiguous` payload (#2412). The picker UI keys on
      // `groups`; preserve null entries (legacy / `__global__`) so the
      // picker can offer them as a distinct choice.
      if (Array.isArray(obj.groups)) {
        groups = obj.groups.filter(
          (g): g is string | null => g === null || typeof g === "string",
        );
      }
      // 400 `workspace_ambiguous` payload (#3157). Each entry is the candidate
      // workspace `{ id, name }` for the platform-users role-change picker.
      if (Array.isArray(obj.workspaces)) {
        workspaces = obj.workspaces.filter(
          (w): w is { id: string; name: string | null } =>
            typeof w === "object" &&
            w !== null &&
            typeof (w as { id?: unknown }).id === "string" &&
            ((w as { name?: unknown }).name === null ||
              typeof (w as { name?: unknown }).name === "string"),
        );
      }
      // 409 `stale_baseline` payload (#4511). The fresh diff + baseline hash the
      // improve panel swaps in for inline update-and-confirm. Both fields must
      // be present strings — a partial payload is ignored so the card falls
      // back to the generic error surface rather than a broken confirm.
      if (
        obj.error === "stale_baseline" &&
        typeof obj.diff === "string" &&
        typeof obj.baselineHash === "string"
      ) {
        stale = { diff: obj.diff, baselineHash: obj.baselineHash };
      }
    }
  } catch (err) {
    // Non-JSON body is expected (SyntaxError, swallowed silently). Unexpected
    // cases — the motivating one is "body already consumed," i.e. a refactor
    // read the Response twice — need to reach Sentry/dev tools, so use
    // `console.warn` to match the treatment in `buildFetchError` and
    // `useAdminFetch`'s network catch. `console.debug` would get filtered
    // out by default log levels, hiding exactly the bugs this branch exists
    // to surface (#1715).
    if (!(err instanceof SyntaxError)) {
      console.warn("extractFetchError: unexpected error reading response body", err);
    }
  }
  // Route the status-only fallback through `buildFetchError` so the empty-
  // message invariant applies to hand-constructed paths too. The message is
  // always non-empty here (either the body field or the `HTTP ${status}`
  // fallback below), so the dev-throw branch never fires on happy paths.
  return buildFetchError({
    message: message ?? `HTTP ${res.status}`,
    status: res.status,
    code,
    requestId,
    enrollmentUrl,
    groups,
    workspaces,
    stale,
  });
}

/**
 * Nullable variant of {@link friendlyError} for call sites that thread a
 * `FetchError | null` through to a `string | null` prop (e.g.
 * `FormDialog.serverError`, `InlineError`). Collapses the
 * `err ? friendlyError(err) : null` ternary to a single call:
 *
 *   serverError={friendlyErrorOrNull(mutation.error)}
 *
 * Exists because `friendlyError` is strictly `FetchError → string` — widening
 * it to accept null would force ~30 non-null call sites to narrow a return
 * that's always a string today.
 */
export function friendlyErrorOrNull(err: FetchError | null | undefined): string | null {
  return err ? friendlyError(err) : null;
}

/**
 * Convert a FetchError into a user-friendly message.
 *
 * Precedence: a non-empty server-typed message wins over the canned
 * status copy. `extractFetchError` only populates `message` from a real
 * body field, so any string here is server-authored — render it verbatim.
 * The status-code branches are the empty-body fallback;
 * `extractFetchError` substitutes `HTTP {status}` there, which
 * `isHttpStatusFallback` round-trips back to the friendly text.
 */
export function friendlyError(err: FetchError): string {
  // Schema mismatch only wins for client-side parse failures (status undefined),
  // because the body parses as 200 OK but fails Zod — HTTP status alone can't
  // distinguish this case. Gating on `status === undefined` prevents an HTTP
  // error whose body happens to set `error: "schema_mismatch"` from masking
  // the friendly mappings — the typed mismatch copy is for the no-status path.
  if (err.code === "schema_mismatch" && err.status === undefined) {
    return appendRequestId(
      "The server returned data this version of the app can't read. This usually means the server and app are out of sync — contact your administrator or try again later.",
      err.requestId,
    );
  }

  // 409 `entity_ambiguous` (#2412). The server's message references the
  // API parameter name (`connectionGroupId`) which is jargon to end
  // users — translate to "environment" language and surface candidate
  // groups from the structured payload when available.
  if (err.code === "entity_ambiguous") {
    const labels = err.groups
      ? err.groups.map((g) => (g === null ? "legacy / global" : g.replace(/^g_/, "")))
      : [];
    const list = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    return appendRequestId(
      `This entity exists in multiple environments${list}. Pick the environment you want to act on.`,
      err.requestId,
    );
  }

  // Server-authored message wins on HTTP errors. `extractFetchError` only
  // populates `message` from a non-empty body field, so any string here is a
  // real server-typed message — render it. Canned text below covers the
  // empty-body path where the message was substituted to `HTTP {status}`.
  if (err.status !== undefined && !isHttpStatusFallback(err.message, err.status)) {
    return appendRequestId(err.message, err.requestId);
  }

  let msg: string;
  if (err.status === 401) msg = "Not authenticated. Please sign in.";
  else if (err.status === 403)
    msg = "Access denied. You may need additional permissions to view this page.";
  else if (err.status === 404)
    msg = "This feature is not enabled on this server.";
  else if (err.status === 503)
    msg = "A required service is unavailable. Check server configuration.";
  else msg = err.message;
  return appendRequestId(msg, err.requestId);
}

function isHttpStatusFallback(message: string, status: number): boolean {
  return message === `HTTP ${status}`;
}

function appendRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (Request ID: ${requestId})` : message;
}
