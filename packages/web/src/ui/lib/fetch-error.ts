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
/**
 * A same-origin path, or `null` if the input is anything else.
 *
 * ⚠️ **Parsed, not prefix-matched, and the difference is exploitable.** The
 * obvious `startsWith("/") && !startsWith("//")` check was measured wrong:
 * WHATWG URL parsing normalizes `\` to `/` for special schemes and strips
 * TAB/LF/CR *before* authority detection, so `/\evil.example.com`,
 * `/\/evil.com` and `/<TAB>/evil.com` all pass it and all navigate off-site.
 * Resolving against a known base and comparing origins has no such arms to
 * enumerate — it answers the question directly.
 */
export function sameOriginPath(raw: string | undefined): string | null {
  if (!raw) return null;
  const base = "https://atlas.invalid";
  try {
    const u = new URL(raw, base);
    return u.origin === base ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch (err) {
    // A URL the parser rejects outright is not a destination either.
    console.warn(
      "[fetch-error] unparseable redirect target:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

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
 * The two messages this module mints when a response body supplies none.
 *
 * Functions rather than inline template literals so {@link isSynthesizedMessage}
 * can be written in terms of the same builders the constructors use. Held
 * apart as string literals, the predicate and its constructors were one
 * careless edit away from disagreeing — and the whole `serverMessage` design
 * rests on them agreeing.
 */
const httpStatusMessage = (status: number | string) => `HTTP ${status}`;
const requestFailedMessage = (status: number | string) => `Request failed (${status})`;

/**
 * What to say when the server refused and explained nothing.
 *
 * Exported so `FeatureGate`'s 503 arm and `friendlyError` give one answer
 * rather than two. They disagreed for two commits — the gate had been
 * corrected to stop blaming DATABASE_URL for a restarting replica while this
 * file still said "Check server configuration", so the same status read as two
 * different diagnoses one file apart.
 *
 * The restarting/proxy guess is 5xx-only, and that boundary is the point. An
 * unexplained 409 is a conflict, which retrying in a moment reproduces; an
 * unexplained 429 came from a rate limiter that is working; an unexplained 400
 * is a client fault, and sending that operator to the API service logs is the
 * same misdiagnosis-from-status-alone this whole change removed from the 503
 * arm — one level up. Edge- and proxy-generated 4xx with no JSON body are
 * exactly the population reaching the caller, so 4xx gets the neutral line.
 */
export function unexplainedFailure(status: number | undefined): string {
  // No status means no HTTP response was parsed at all, so "the server
  // returned" would be a claim about something that never happened.
  if (status === undefined) {
    return "The request failed and no response could be read. Check your network connection; if it persists, check the API service logs.";
  }
  if (status >= 500) {
    return `The server returned an error (${status}) with no explanation — it may be restarting or behind an unhealthy proxy. Retry in a moment; if it persists, check the API service logs.`;
  }
  return `The server rejected the request (${status}) with no explanation. If it persists, check the API service logs.`;
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
    const fallback = requestFailedMessage(input.status ?? "unknown");
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
        // Sanitize HERE, at the one place the value enters `FetchError`, so the
        // consumers that read it off a `FetchError` inherit the guard:
        // `use-admin-fetch` / `use-admin-mutation` (which hand it to
        // `mfa-enrollment-dialog`'s `router.push`) and the dashboards index's
        // `router.replace`. #5189 round 1 guarded only the last of those.
        //
        // ⚠️ `admin-layout`'s `<Link href>` and its `trigger()` do NOT come
        // through here — they read `enrollmentUrl` from `usePasswordStatus`,
        // which parses the body itself. That hook applies `sameOriginPath`
        // directly for the same reason.
        enrollmentUrl = sameOriginPath(obj.enrollmentUrl) ?? undefined;
        if (enrollmentUrl === undefined) {
          console.warn(
            "[fetch-error] rejected an off-origin enrollmentUrl:",
            obj.enrollmentUrl,
          );
        }
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
    message: message ?? httpStatusMessage(res.status),
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
 * The message the *server* authored, or `undefined` when it authored none.
 *
 * This module mints two placeholder messages of its own when a body carries
 * none, and both keep the status alongside them (see
 * {@link isSynthesizedMessage}). So a bare truthiness check on `err.message`
 * hands a placeholder to any surface that treats a message as server copy —
 * "HTTP 403" rendered where a gate's canned explanation belongs. This is the
 * same precedence {@link friendlyError} applies before falling back to its
 * status copy, factored out so the gated surfaces (`FeatureGate`,
 * `EnterpriseUpsell`) draw the identical distinction instead of each
 * re-deriving the sentinels.
 *
 * A `FetchError` with no `status` never got an HTTP response at all (network
 * failure) or failed client-side (non-JSON body, schema mismatch), so it has
 * no server message by definition.
 *
 * Blank is treated as absent. `buildFetchError` refuses to construct one, but
 * `FetchError` is a bare interface that anything can build — and a caller that
 * renders `message ?? canned` would put an empty `<p>` on screen, which is the
 * blank-chrome failure that helper exists to prevent.
 */
export function serverMessage(err: FetchError): string | undefined {
  // `status === undefined` means no HTTP response was parsed, and every
  // status-less producer in this codebase authors its own message client-side
  // (the network catch, the non-JSON-body fallback, `schema_mismatch`, the
  // hand-built errors in `use-admin-mutation` / `use-config-form` /
  // `query-utils`). So a status-less error never carries server prose — which
  // holds regardless of `code`. `schema_mismatch` in particular IS status-less
  // *with* a code, and returning `undefined` for it is right, not a gap.
  if (err.status === undefined) return undefined;
  if (isSynthesizedMessage(err.message, err.status)) return undefined;
  return err.message.trim() || undefined;
}

/**
 * The two fields every gated placeholder — `FeatureGate`, `EnterpriseUpsell`,
 * `MfaRequiredPlaceholder` — takes from a {@link FetchError}, derived once.
 *
 * Spread it: `<FeatureGate status={s} feature={f} {...gateProps(err)} />`.
 *
 * The placeholders stay purely presentational (plain props, unit-testable
 * without a `FetchError`), but the decision of *which* two fields and *how*
 * they are derived stops being replicated per call site. #5068 was one call
 * site forgetting; the panel review then found a second call site with no test
 * at all, whose narrower status set turned out to be correct but was
 * indistinguishable from an accident.
 */
export interface GateErrorProps {
  message?: string;
  requestId?: string;
}

export function gateProps(err: FetchError): GateErrorProps {
  return { message: serverMessage(err), requestId: err.requestId };
}

/**
 * Is this error's `message` a placeholder this module minted, rather than
 * text worth showing or transforming?
 *
 * The narrower sibling of {@link serverMessage}, for the one caller that must
 * distinguish "synthesized" from "not the server's" — `combineMutationErrors`
 * decorates a message with a "+N more" suffix, and a *client*-authored message
 * ("Network error", a schema-mismatch sentence) is perfectly good to decorate
 * even though no server wrote it. Only the placeholders are not: suffixing one
 * yields `"HTTP 403 (+1 more)"`, which no longer matches the sentinels and so
 * reads as server prose to every surface downstream.
 */
export function isPlaceholderMessage(err: FetchError): boolean {
  if (err.status === undefined) {
    // `serverMessage` never sees this case (it early-returns on a missing
    // status), but `friendlyError`'s catch-all arm does, and it is where
    // `buildFetchError`'s third spelling lands: a status-less empty message
    // becomes `Request failed (unknown)`, which would otherwise render as if
    // a human had written it.
    return err.message.trim() === requestFailedMessage("unknown");
  }
  return isSynthesizedMessage(err.message, err.status);
}

/**
 * Convert a FetchError into a user-friendly message.
 *
 * Precedence: a non-empty server-typed message wins over the canned
 * status copy. `extractFetchError` only populates `message` from a real
 * body field, so any string here is server-authored — render it verbatim.
 * The status-code branches are the empty-body fallback, which
 * {@link isSynthesizedMessage} recognizes and round-trips back to the
 * friendly text.
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
  const authored = serverMessage(err);
  if (authored) return appendRequestId(authored, err.requestId);

  let msg: string;
  if (err.status === 401) msg = "Not authenticated. Please sign in.";
  else if (err.status === 403)
    msg = "Access denied. You may need additional permissions to view this page.";
  else if (err.status === 404)
    msg = "This feature is not enabled on this server.";
  else if (err.status === 503) msg = unexplainedFailure(503);
  // Every status without a friendly mapping — 500, 409, 429 — plus the
  // status-less client failures.
  //
  // `isPlaceholderMessage`, not a bare `.trim()` and not `serverMessage`.
  //
  // A trim check could never fire for the statuses this arm was written for:
  // an empty-bodied 500 arrives as the placeholder `"HTTP 500"`, which is
  // non-blank, so the banner rendered the status echo. But `serverMessage` is
  // too strong here — it discards every status-less message, and those are
  // client-authored ("Network error", the schema-mismatch sentence) and are
  // exactly what this arm should show. Only the placeholder and the blank are
  // worth replacing.
  else msg = (isPlaceholderMessage(err) ? "" : err.message.trim()) || unexplainedFailure(err.status);
  return appendRequestId(msg, err.requestId);
}

/**
 * Is this message one *this module* synthesized from the status, rather than
 * anything the server said?
 *
 * There are two spellings and they must be recognized together, or a surface
 * branching on "did the server explain itself" catches one and is fooled by
 * the other. Both are built by the functions above, which is the point: the
 * predicate calls the same builders its constructors do, so the two cannot
 * drift. A placeholder this predicate stops recognizing goes straight back to
 * being rendered as if a human had written it.
 *
 * `Request failed ({status})` looks unreachable and is not: `extractFetchError`
 * admits a whitespace-only body `message` (it tests `length > 0`, untrimmed),
 * which `buildFetchError` then trims to empty and substitutes. In development
 * that path throws instead, so this spelling only ever reaches a user in
 * production — where the dev-throw cannot warn anyone.
 *
 * A third spelling, `Request failed (unknown)`, exists for a status-less
 * `buildFetchError`. It is covered by {@link serverMessage}'s
 * `status === undefined` guard rather than by this predicate — relax that
 * guard and this needs to grow.
 */
function isSynthesizedMessage(message: string, status: number): boolean {
  // Trimmed, because every sibling guard on this path trims and this is the
  // one that decides provenance. A padded `"  HTTP 403  "` slipping through
  // reads as server prose to the gate — the defect, one space over.
  const m = message.trim();
  return m === httpStatusMessage(status) || m === requestFailedMessage(status);
}

function appendRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (Request ID: ${requestId})` : message;
}
