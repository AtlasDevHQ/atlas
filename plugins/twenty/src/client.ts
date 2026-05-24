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
  | "getPersonMetadata";

/** Structured error for typed routing inside SaasCrmLayer. */
export class TwentyClientError extends Data.TaggedError("TwentyClientError")<{
  readonly message: string;
  /** HTTP status code; 0 for transport-level failures (DNS, network, timeout). */
  readonly status: number;
  /** Best-effort upstream error code from Twenty's JSON body, if present. */
  readonly upstreamCode?: string;
  /** Which client method raised the failure. */
  readonly operation: TwentyOperation;
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
