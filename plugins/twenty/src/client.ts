/**
 * TwentyClient — REST wrapper around the Twenty CRM API.
 *
 * Translation rules baked into `upsertPerson`:
 *  - First-source preservation. `atlasFirstSource` is sticky; once set on
 *    a Person it is never overwritten. Only `atlasLastSource` is updated
 *    thereafter. Implemented via a GET-then-(POST or PATCH) round trip —
 *    Twenty has no atomic "upsert with conditional field" primitive.
 *  - Custom fields live INLINE on the Person record (not under a
 *    `customFields` wrapper). Twenty's REST surface synthesizes fields
 *    from the schema, so `atlasFirstSource` / `atlasLastSource` /
 *    `atlasIp` are siblings of `emails` and `name` on both read and
 *    write.
 *
 * URL composition:
 *  - Core records:   `{baseUrl}/rest/people` etc.
 *  - Metadata probe: `{baseUrl}/metadata/` (GraphQL; metadata's REST
 *    surface lists objects but does NOT expose a per-object fields list).
 *
 * Verified against Twenty docs (REST: GET /rest/{namePlural} + filter
 * bracket syntax; metadata GraphQL: `objects { fields { name } }`).
 * See README.md for endpoint references.
 */
import { Data } from "effect";

import type { AtlasEventSource } from "./lead-normalizer";

/**
 * Which underlying operation a failure came from. Slice consumers
 * (outbox metrics, retry policy) branch on this rather than parsing
 * the message string.
 */
export type TwentyOperation =
  | "findPersonByEmail"
  | "createPerson"
  | "updatePerson"
  | "getPersonMetadata"
  | "createNote"
  | "createNoteTarget";

/** Structured error for typed routing inside SaasCrmLayer. */
export class TwentyClientError extends Data.TaggedError("TwentyClientError")<{
  readonly message: string;
  /** HTTP status code; 0 for transport-level failures (DNS, network, timeout). */
  readonly status: number;
  /** Best-effort upstream error code from Twenty's JSON body, if present. */
  readonly upstreamCode?: string;
  /** Which client method raised the failure. */
  readonly operation: TwentyOperation;
  /**
   * Best-effort `Retry-After` from the response, normalised to
   * milliseconds. Set when the upstream returned a 429 (or any other
   * status) with a parseable `Retry-After` header. The outbox honours
   * this on the row's `retry_after` column so the next claim respects
   * the upstream's requested delay instead of the tier-based default.
   */
  readonly retryAfterMs?: number;
}> {}

/**
 * Atlas-specific Person custom fields. Read-side type stays wide
 * (`string`) because Twenty round-trips whatever was last written
 * (including legacy values from prior schemas); the write side narrows
 * to `AtlasEventSource` via `UpsertPersonInput.eventSource`, so a typo
 * cannot enter the system today.
 */
export interface AtlasPersonCustomFields {
  readonly atlasFirstSource?: string;
  readonly atlasLastSource?: string;
  readonly atlasIp?: string;
}

/**
 * Subset of Twenty Person fields we read or write. Custom fields live
 * INLINE alongside the standard ones — Twenty's REST API does not nest
 * them under a `customFields` wrapper (confirmed via docs: companies
 * PATCH writes `annualRecurringRevenue` at the top level).
 */
export interface TwentyPerson extends AtlasPersonCustomFields {
  readonly id?: string;
  readonly emails?: { primaryEmail?: string };
  readonly name?: { firstName?: string; lastName?: string };
}

export interface UpsertPersonInput {
  /** Required — the email Twenty matches on. */
  readonly email: string;
  /** Optional name fields. */
  readonly name?: { firstName?: string; lastName?: string };
  /**
   * Extra Atlas custom fields to write through on every call. The
   * source fields (`atlasFirstSource` / `atlasLastSource`) are
   * intentionally excluded — they're derived from `eventSource`
   * inside upsertPerson.
   */
  readonly customFields?: Omit<AtlasPersonCustomFields, "atlasFirstSource" | "atlasLastSource">;
  /**
   * Current event's source label. Translated into `atlasFirstSource`
   * (only when the existing Person has none) and `atlasLastSource`
   * (always) inside the client. Narrow union prevents typos from
   * persisting in Twenty forever.
   */
  readonly eventSource: AtlasEventSource;
}

export interface TwentyClientConfig {
  /** API base URL, e.g. https://crm.example.com */
  readonly baseUrl: string;
  /** Bearer token. NEVER logged. */
  readonly apiKey: string;
  /** Per-request timeout in ms. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** Fetch impl override. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Strip trailing slashes WITHOUT a polynomial-time regex. Bounded loop
 * runs at most once per trailing slash, never backtracks.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Strip leading slashes WITHOUT a polynomial-time regex.
 */
function stripLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47 /* '/' */) start++;
  return start === 0 ? s : s.slice(start);
}

/** path arg must not start with `/rest/` — composed here universally. */
function buildRestUrl(baseUrl: string, path: string): string {
  return `${stripTrailingSlashes(baseUrl)}/rest/${stripLeadingSlashes(path)}`;
}

/** Metadata GraphQL endpoint — Twenty docs: `/metadata/` (no `/rest/`). */
function buildMetadataUrl(baseUrl: string): string {
  return `${stripTrailingSlashes(baseUrl)}/metadata`;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Parse the `Retry-After` header per RFC 9110 §10.2.3. Two valid forms:
 *  - `delta-seconds` (e.g. `120`) — non-negative integer.
 *  - `HTTP-date` (e.g. `Wed, 21 Oct 2015 07:28:00 GMT`) — `Date.parse`able.
 *
 * Returns the wait in milliseconds, or `undefined` when the header is
 * absent or unparseable. Always clamped to a non-negative value so a
 * server clock skew can't ask us to retry "in the past" (which would
 * collapse to no delay) or — worse — produce a negative interval the
 * outbox would store as a Postgres-rejected timestamp.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;

  // delta-seconds form — integer, possibly with leading zeros.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, seconds * 1000);
  }

  // HTTP-date form. Date.parse returns NaN on garbage.
  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) return undefined;
  const delta = target - Date.now();
  return Math.max(0, delta);
}

/**
 * Parse a Twenty error response without ever including the raw body in
 * the thrown error message — Twenty may include sensitive context. We
 * surface the upstream `messages[0]` (canonical envelope) or fall back
 * to `HTTP <status>`.
 */
async function readErrorDetail(response: Response): Promise<{ message: string; code?: string }> {
  let upstreamMessage = "";
  let upstreamCode: string | undefined;
  try {
    const body = (await response.clone().json()) as {
      messages?: string[];
      message?: string;
      code?: string;
      error?: string;
    };
    upstreamMessage =
      (Array.isArray(body.messages) ? body.messages[0] : undefined) ??
      body.message ??
      body.error ??
      "";
    upstreamCode = typeof body.code === "string" ? body.code : undefined;
  } catch (err) {
    // Body wasn't JSON. Try text but cap length so a huge HTML 502 page
    // from a fronting proxy doesn't bloat the log.
    try {
      const txt = await response.text();
      upstreamMessage = txt.slice(0, 200);
    } catch (textErr) {
      upstreamMessage =
        `[body unreadable: text=${textErr instanceof Error ? textErr.message : String(textErr)}; ` +
        `json=${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  const message = upstreamMessage ? upstreamMessage : `HTTP ${response.status}`;
  return { message, code: upstreamCode };
}

/**
 * Look up a Person by primary email. Returns the first match or
 * undefined when Twenty returns a 2xx with an empty result set.
 *
 * Twenty's REST filter syntax (bracket-nested, per their docs):
 *   ?filter[emails.primaryEmail][eq]=<email>&limit=1
 *
 * Throws TwentyClientError when the response body is a 2xx but its
 * shape doesn't match `{ data: { people: TwentyPerson[] } }` — silently
 * returning undefined would cause `upsertPerson` to POST a duplicate
 * Person and clobber any sticky `atlasFirstSource` on the existing one.
 */
async function findPersonByEmail(
  config: TwentyClientConfig,
  email: string,
): Promise<TwentyPerson | undefined> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const filter = `filter[emails.primaryEmail][eq]=${encodeURIComponent(email)}`;
  const url = buildRestUrl(config.baseUrl, `people?${filter}&limit=1`);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: buildAuthHeaders(config.apiKey),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new TwentyClientError({
      message: `findPersonByEmail failed: ${detail.message}`,
      status: response.status,
      upstreamCode: detail.code,
      operation: "findPersonByEmail",
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    });
  }

  let body: { data?: { people?: unknown } };
  try {
    body = (await response.json()) as typeof body;
  } catch (err) {
    throw new TwentyClientError({
      message: `findPersonByEmail: unparseable success response (${err instanceof Error ? err.message : String(err)})`,
      status: response.status,
      operation: "findPersonByEmail",
    });
  }

  const list = body.data?.people;
  if (Array.isArray(list)) {
    return list.length > 0 ? (list[0] as TwentyPerson) : undefined;
  }
  // Twenty returned 200 with neither an array nor a documented shape we
  // recognize. Fail loud rather than return undefined and risk a duplicate
  // Person on the POST path that would clobber sticky source state.
  throw new TwentyClientError({
    message: "findPersonByEmail: unexpected response shape (expected data.people to be an array)",
    status: response.status,
    operation: "findPersonByEmail",
  });
}

/** POST a new Person. */
async function createPerson(
  config: TwentyClientConfig,
  payload: Record<string, unknown>,
): Promise<TwentyPerson> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const url = buildRestUrl(config.baseUrl, "people");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: buildAuthHeaders(config.apiKey),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new TwentyClientError({
      message: `createPerson failed: ${detail.message}`,
      status: response.status,
      upstreamCode: detail.code,
      operation: "createPerson",
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    });
  }

  try {
    const body = (await response.json()) as {
      data?: { createPerson?: TwentyPerson; person?: TwentyPerson };
    };
    return body.data?.createPerson ?? body.data?.person ?? {};
  } catch (err) {
    throw new TwentyClientError({
      message: `createPerson: unparseable success response (${err instanceof Error ? err.message : String(err)})`,
      status: response.status,
      operation: "createPerson",
    });
  }
}

/** PATCH an existing Person by id with the supplied partial payload. */
async function updatePerson(
  config: TwentyClientConfig,
  id: string,
  payload: Record<string, unknown>,
): Promise<TwentyPerson> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const url = buildRestUrl(config.baseUrl, `people/${encodeURIComponent(id)}`);
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: buildAuthHeaders(config.apiKey),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new TwentyClientError({
      message: `updatePerson failed: ${detail.message}`,
      status: response.status,
      upstreamCode: detail.code,
      operation: "updatePerson",
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    });
  }

  try {
    const body = (await response.json()) as {
      data?: { updatePerson?: TwentyPerson; person?: TwentyPerson };
    };
    return body.data?.updatePerson ?? body.data?.person ?? {};
  } catch (err) {
    throw new TwentyClientError({
      message: `updatePerson: unparseable success response (${err instanceof Error ? err.message : String(err)})`,
      status: response.status,
      operation: "updatePerson",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Notes — POST /rest/notes + POST /rest/noteTargets
// ─────────────────────────────────────────────────────────────────────
//
// Twenty's Note entity stores rich text under `bodyV2.markdown` (the
// `body` field was retired in favor of the BlockNote-shaped `bodyV2`).
// Linking a Note to a Person is a SECOND request to `/rest/noteTargets`
// with `{ noteId, targetPersonId }` — Twenty does not expose a combined
// create-and-link primitive. The two-step shape is mirrored in
// `dispatchOutboxRow`'s sub-step idempotency: if the link step fails
// after the note is created, the note is orphaned but the lead is NOT
// lost (the row stays `in_flight` and the next claim re-runs the link
// step against a fresh note — operator cleans up the orphan; acceptable
// cost vs. dropping the lead).

export interface CreateNoteInput {
  /** Person id returned by upsertPerson — the note attaches to this Person. */
  readonly personId: string;
  /** Title surfaced in Twenty's note list view. */
  readonly title: string;
  /** Note body as markdown. Stored under `bodyV2.markdown`. */
  readonly body: string;
}

export interface TwentyNote {
  readonly id: string;
}

/**
 * Create a Note in Twenty and link it to a Person via NoteTarget.
 * Returns the created note's id so the caller (outbox dispatcher) can
 * persist it for idempotent replay.
 */
export async function createNote(
  config: TwentyClientConfig,
  input: CreateNoteInput,
): Promise<TwentyNote> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  // ── Step 1: POST /rest/notes ──────────────────────────────────────
  const noteUrl = buildRestUrl(config.baseUrl, "notes");
  const noteResponse = await fetchImpl(noteUrl, {
    method: "POST",
    headers: buildAuthHeaders(config.apiKey),
    body: JSON.stringify({
      title: input.title,
      bodyV2: { markdown: input.body },
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!noteResponse.ok) {
    const detail = await readErrorDetail(noteResponse);
    throw new TwentyClientError({
      message: `createNote failed: ${detail.message}`,
      status: noteResponse.status,
      upstreamCode: detail.code,
      operation: "createNote",
      retryAfterMs: parseRetryAfterMs(noteResponse.headers.get("Retry-After")),
    });
  }

  let noteId: string | undefined;
  try {
    const noteBody = (await noteResponse.json()) as {
      data?: { createNote?: TwentyNote; note?: TwentyNote };
    };
    noteId = noteBody.data?.createNote?.id ?? noteBody.data?.note?.id;
  } catch (err) {
    throw new TwentyClientError({
      message: `createNote: unparseable success response (${err instanceof Error ? err.message : String(err)})`,
      status: noteResponse.status,
      operation: "createNote",
    });
  }

  if (!noteId) {
    // Twenty returned 2xx with no id — we can't link the noteTarget
    // without it. Fail loud rather than silently complete; the row will
    // retry (transient) and create a duplicate note on the next attempt,
    // which is preferable to a missing note that the operator never
    // notices.
    throw new TwentyClientError({
      message: "createNote: 2xx response had no id",
      status: noteResponse.status,
      operation: "createNote",
    });
  }

  // ── Step 2: POST /rest/noteTargets ────────────────────────────────
  const linkUrl = buildRestUrl(config.baseUrl, "noteTargets");
  const linkResponse = await fetchImpl(linkUrl, {
    method: "POST",
    headers: buildAuthHeaders(config.apiKey),
    body: JSON.stringify({
      noteId,
      targetPersonId: input.personId,
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!linkResponse.ok) {
    const detail = await readErrorDetail(linkResponse);
    throw new TwentyClientError({
      message: `createNoteTarget failed (note=${noteId}): ${detail.message}`,
      status: linkResponse.status,
      upstreamCode: detail.code,
      operation: "createNoteTarget",
      retryAfterMs: parseRetryAfterMs(linkResponse.headers.get("Retry-After")),
    });
  }

  // We don't need the noteTarget id for anything — the noteId is the
  // load-bearing identifier the outbox persists for idempotency.
  return { id: noteId };
}

// ─────────────────────────────────────────────────────────────────────
//  Public surface
// ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a Person by email with first/last source translation.
 *
 *  - Person absent → POST with both source fields set to `eventSource`.
 *  - Person present + `atlasFirstSource` set → PATCH `atlasLastSource`
 *    only (preserves original first-touch attribution).
 *  - Person present + `atlasFirstSource` absent → PATCH both, treating
 *    this dispatch as the first stamped touch.
 *
 * `name` and any caller-supplied `customFields` are merged into every
 * write (POST and both PATCH branches) so a later dispatch that brings
 * fresh `firstName` / `lastName` etc. doesn't silently drop them.
 */
export async function upsertPerson(
  config: TwentyClientConfig,
  input: UpsertPersonInput,
): Promise<TwentyPerson> {
  const existing = await findPersonByEmail(config, input.email);

  // Build the merge-on-every-write base. Spread first so source fields
  // computed below can override any caller-supplied collision.
  const baseFields: Record<string, unknown> = {
    ...(input.customFields ?? {}),
  };
  if (input.name) baseFields.name = input.name;

  if (!existing) {
    const payload: Record<string, unknown> = {
      ...baseFields,
      emails: { primaryEmail: input.email },
      atlasFirstSource: input.eventSource,
      atlasLastSource: input.eventSource,
    };
    return createPerson(config, payload);
  }

  if (!existing.id) {
    // Twenty always returns id on a hit — bail loudly rather than
    // swallow and risk a duplicate Person on a downstream POST.
    throw new TwentyClientError({
      message: "upsertPerson: existing Person lookup returned no id",
      status: 0,
      operation: "findPersonByEmail",
    });
  }

  const existingFirstSource = existing.atlasFirstSource;
  if (existingFirstSource && existingFirstSource.length > 0) {
    // Sticky — never overwrite atlasFirstSource.
    const payload: Record<string, unknown> = {
      ...baseFields,
      atlasLastSource: input.eventSource,
    };
    return updatePerson(config, existing.id, payload);
  }

  // Existing Person but no first source yet → treat as first stamped touch.
  const payload: Record<string, unknown> = {
    ...baseFields,
    atlasFirstSource: input.eventSource,
    atlasLastSource: input.eventSource,
  };
  return updatePerson(config, existing.id, payload);
}

// ─────────────────────────────────────────────────────────────────────
//  Metadata probe (GraphQL — Twenty's REST `/rest/metadata/objects`
//  endpoint lists objects but doesn't expose a per-object fields list)
// ─────────────────────────────────────────────────────────────────────

export interface PersonMetadataField {
  readonly name: string;
}

export interface PersonMetadata {
  readonly fields: PersonMetadataField[];
}

const METADATA_FIELDS_QUERY =
  "query GetPersonFields { objects(filter: { nameSingular: { eq: \"person\" } }, paging: { first: 1 }) { edges { node { fields { edges { node { name } } } } } } }";

/**
 * Fetch the Person object's metadata so callers can verify the required
 * custom fields exist before dispatch. Errors propagate as
 * TwentyClientError so the layer can distinguish transient failures
 * from configuration errors.
 */
export async function getPersonMetadata(
  config: TwentyClientConfig,
): Promise<PersonMetadata> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const url = buildMetadataUrl(config.baseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: buildAuthHeaders(config.apiKey),
    body: JSON.stringify({ query: METADATA_FIELDS_QUERY }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new TwentyClientError({
      message: `getPersonMetadata failed: ${detail.message}`,
      status: response.status,
      upstreamCode: detail.code,
      operation: "getPersonMetadata",
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    });
  }

  let body: {
    data?: {
      objects?: {
        edges?: Array<{ node?: { fields?: { edges?: Array<{ node?: { name?: string } }> } } }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch (err) {
    throw new TwentyClientError({
      message: `getPersonMetadata: unparseable success response (${err instanceof Error ? err.message : String(err)})`,
      status: response.status,
      operation: "getPersonMetadata",
    });
  }

  // GraphQL conventions: 2xx with `errors[]` is still an error.
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0]?.message ?? "(unknown GraphQL error)";
    throw new TwentyClientError({
      message: `getPersonMetadata: GraphQL error: ${first}`,
      status: response.status,
      operation: "getPersonMetadata",
    });
  }

  const personNode = body.data?.objects?.edges?.[0]?.node;
  const fieldEdges = personNode?.fields?.edges ?? [];
  const fields: PersonMetadataField[] = [];
  for (const edge of fieldEdges) {
    const name = edge?.node?.name;
    if (typeof name === "string") fields.push({ name });
  }
  return { fields };
}
