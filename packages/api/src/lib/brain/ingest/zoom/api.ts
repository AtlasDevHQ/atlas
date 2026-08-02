/**
 * The Zoom REST surface this connector needs (#4965) — four reads and an auth
 * exchange, with every vendor failure mapped into ONE error vocabulary.
 *
 * Modelled on `lib/slack/api.ts`: each read returns a discriminated
 * `{ ok: true, … } | ZoomReadError` rather than throwing, so the caller decides
 * per read whether a failure is fatal to a meeting, to a pass, or to nothing.
 * Only {@link toZoomClientError} (in `client.ts`) turns one into an exception,
 * and only `ratelimited` becomes the shared `ConnectorRateLimitError` — so the
 * ENGINE's bounded backoff owns the retry and this module owns no policy.
 *
 * ## Server-to-Server OAuth, and why the token is not cached across passes
 *
 * {@link fetchZoomAccessToken} exchanges the account credential for a bearer
 * token valid for one hour. It is fetched ONCE PER PASS and held in the
 * client's closure — not cached in a module-level map keyed by account.
 *
 * A process-wide cache would be a cross-tenant object holding decrypted
 * credentials' derivatives for every workspace on the box, and the region
 * process is shared. The cost of not having one is one extra token call per
 * sync cycle per install, against an endpoint with its own generous limit;
 * that is a trade the security side wins outright.
 *
 * ## The uuid encoding rule, restated where it is USED
 *
 * `ingest/zoom/config.ts` documents that a stored meeting uuid is the RAW
 * base64 value. This module is the only place that value becomes part of a URL,
 * and Zoom requires a uuid containing `/` or starting with `/` to be **double**
 * URL-encoded as a path segment. {@link encodeMeetingUuidForPath} is the single
 * site that does it — if it existed at two call sites they could disagree, and
 * the symptom would be a 404 on exactly the meetings whose uuid happened to
 * contain a slash.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { guardedFetch, EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";

const log = createLogger("brain.ingest.zoom.api");

/** Zoom's API origin. Fixed — this connector never talks to a customer host. */
export const ZOOM_API_BASE = "https://api.zoom.us/v2";

/** Zoom's OAuth token endpoint. Separate origin from the API base. */
export const ZOOM_OAUTH_TOKEN_URL = "https://zoom.us/oauth/token";

/**
 * Hosts a recording `download_url` may point at.
 *
 * A `download_url` is VENDOR-SUPPLIED DATA that this connector then fetches,
 * which makes it an SSRF surface even though the vendor is trusted — a
 * compromised or confused upstream is exactly the case a guard is for.
 * {@link fetchTranscriptText} runs it through `guardedFetch` (which re-validates
 * every redirect hop against the private-range blocklist) AND pins the initial
 * host to this suffix. The pin is the stronger half: a Zoom download_url that
 * is not on a Zoom host is an anomaly worth refusing outright, not merely one
 * worth checking for private addresses.
 */
export const ZOOM_DOWNLOAD_HOST_SUFFIX = ".zoom.us";

/** Per-request timeout. Zoom is fast; a hung read must not hold the pass. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Transcript downloads get longer — a VTT for a long meeting is large. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The failure codes this module maps, beyond the open string set.
 *
 * Named because the client's error table branches on them and an admin-facing
 * sentence per code is the whole point — a raw Zoom status reaching
 * `knowledge_sync_state.error` tells an operator nothing actionable.
 */
export type ZoomReadErrorCode =
  | "ratelimited"
  | "invalid_auth"
  | "missing_scope"
  | "not_found"
  | "plan_required"
  | "too_large"
  /**
   * The `download_url` Zoom handed back is unusable — unparseable, not HTTPS,
   * or not a Zoom host.
   *
   * Separate from `transport` because the two have opposite retry semantics and
   * the caller acts on that difference. A transport fault is a bad moment; a
   * stored recording's `download_url` is the same string next pass, so retrying
   * it freezes the walk at the meeting before it — the exact cursor-freeze that
   * `too_large` was split out to avoid, and that `outlook/client.ts`'s header
   * cites as how #4965 shipped an outage.
   */
  | "unusable_url"
  | "transport";

export interface ZoomReadError {
  readonly ok: false;
  /** Open on purpose — an unmapped Zoom code still reaches the operator verbatim. */
  readonly error: ZoomReadErrorCode | (string & {});
  /** Seconds Zoom asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;
}

/**
 * Double-encode a meeting uuid for use as a URL PATH SEGMENT.
 *
 * Zoom's documented rule: if the uuid begins with `/` or contains `//`, it must
 * be double URL-encoded. Applying it unconditionally is deliberate — the
 * conditional form has two branches that are exercised by different meetings,
 * so the rare branch is the one that is never tested and always broken. Double
 * encoding a uuid that did not need it is still correct (Zoom decodes twice
 * either way).
 *
 * This is a TRANSPORT concern only. The value stored in `source_id` and in the
 * `audience:` grant is the RAW uuid — see `config.ts`'s encoding trap.
 */
export function encodeMeetingUuidForPath(uuid: string): string {
  return encodeURIComponent(encodeURIComponent(uuid));
}

/** Map an HTTP status + body into the shared error vocabulary. */
function toReadError(status: number, retryAfter: string | null, body: string): ZoomReadError {
  const retryAfterSeconds = parseRetryAfter(retryAfter);
  if (status === 429) return { ok: false, error: "ratelimited", retryAfterSeconds };
  if (status === 401) return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
  // Zoom returns 403 both for a missing OAuth scope and for a feature the
  // account's PLAN does not include (cloud recording, participant reports).
  // They need different sentences — one is repaired in the Zoom app config, the
  // other needs a plan change — so the body's error code disambiguates.
  if (status === 403) {
    return {
      ok: false,
      error: /scope/i.test(body) ? "missing_scope" : "plan_required",
      retryAfterSeconds: null,
    };
  }
  if (status === 404) return { ok: false, error: "not_found", retryAfterSeconds: null };
  return { ok: false, error: `http_${status}`, retryAfterSeconds };
}

/**
 * `Retry-After` is seconds or an HTTP-date. Both are parsed; anything else is
 * `null`, which the engine's backoff reads as "use your own schedule" rather
 * than as zero.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && String(seconds) === raw.trim()) return seconds;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** One authenticated Zoom GET, returning parsed JSON or the mapped failure. */
async function zoomGet(
  token: string,
  path: string,
  query: Record<string, string | undefined>,
): Promise<{ ok: true; data: Record<string, unknown> } | ZoomReadError> {
  const url = new URL(`${ZOOM_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Type-narrowed per CLAUDE.md, and logged rather than swallowed. A
    // transport fault is per-read, so the caller decides its blast radius.
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ path, err: message }, "Zoom request failed at the transport layer");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  if (!res.ok) {
    // intentionally ignored: this reads the error body of an ALREADY-failed
    // response, purely to enrich the mapped error. The STATUS is the signal and
    // it is already in hand; a body that will not read (truncated, connection
    // dropped mid-error) must not turn a clean `http_429` into a transport
    // fault. `toReadError` treats "" as "no detail", which is the truth.
    const body = await res.text().catch(() => "");
    return toReadError(res.status, res.headers.get("retry-after"), body);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn({ path }, "Zoom returned a non-object JSON body");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Exchange the Server-to-Server OAuth credential for a bearer token.
 *
 * The client id/secret go in a Basic header, never in the query string:
 * `zoomGet`'s URL would otherwise be a candidate for any log line that records
 * request URLs, and CLAUDE.md forbids secrets reaching a response or a log.
 */
export async function fetchZoomAccessToken(params: {
  readonly accountId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<{ ok: true; token: string } | ZoomReadError> {
  const url = new URL(ZOOM_OAUTH_TOKEN_URL);
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", params.accountId);
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, "Zoom token exchange failed at the transport layer");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  if (!res.ok) {
    // intentionally ignored: this reads the error body of an ALREADY-failed
    // response, purely to enrich the mapped error. The STATUS is the signal and
    // it is already in hand; a body that will not read (truncated, connection
    // dropped mid-error) must not turn a clean `http_429` into a transport
    // fault. `toReadError` treats "" as "no detail", which is the truth.
    const body = await res.text().catch(() => "");
    return toReadError(res.status, res.headers.get("retry-after"), body);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A 200 whose body is not JSON is Zoom-side (a proxy interstitial, a
    // maintenance page) — NOT a bad credential. Collapsing it into
    // `invalid_auth` sends the admin to rotate a secret that was fine, which
    // is the "no generic/misleading error messages" rule in its most expensive
    // form. Only a genuine 401 (mapped in `toReadError`) blames the credential.
    log.warn({}, "Zoom token exchange returned an unreadable body");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  const token = (parsed as Record<string, unknown>).access_token;
  if (typeof token !== "string" || token === "") {
    log.warn({}, "Zoom token exchange returned no access_token");
    return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
  }
  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/** One file inside a meeting's recording set. */
export interface ZoomRecordingFile {
  readonly id: string;
  readonly fileType: string | null;
  readonly downloadUrl: string | null;
  readonly fileSize: number | null;
}

/** One recorded meeting INSTANCE, with its files. */
export interface ZoomRecordingMeeting {
  /** The instance uuid, RAW — never encoded. See `config.ts`. */
  readonly uuid: string;
  readonly topic: string | null;
  readonly hostId: string | null;
  readonly startTime: string | null;
  readonly files: readonly ZoomRecordingFile[];
}

export interface ZoomRecordingsPage {
  readonly ok: true;
  readonly meetings: readonly ZoomRecordingMeeting[];
  readonly nextPageToken: string | null;
  /**
   * Entries Zoom returned that carried no usable identity (no uuid, or a
   * non-array file list). COUNTED rather than dropped silently: they sit inside
   * the window the pass is about to mark covered, so the client truncates
   * instead of advancing past them — the same rule `slack/client.ts` applies to
   * a page with dropped messages.
   */
  readonly dropped: number;
}

/** Narrow one JSON value to a string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * List an account's cloud recordings within `[from, to]`.
 *
 * ⚠️ Zoom caps this endpoint's range at ONE MONTH and serves at most the last
 * six months. The client's window walk respects both; a caller passing a wider
 * range gets a 400 with no partial results, which would look like an empty
 * account.
 */
export async function fetchAccountRecordingsPage(
  token: string,
  params: {
    readonly accountId: string;
    readonly from: string;
    readonly to: string;
    readonly pageSize: number;
    readonly nextPageToken?: string;
  },
): Promise<ZoomRecordingsPage | ZoomReadError> {
  const result = await zoomGet(token, `/accounts/${encodeURIComponent(params.accountId)}/recordings`, {
    from: params.from,
    to: params.to,
    page_size: String(params.pageSize),
    next_page_token: params.nextPageToken,
  });
  if (!result.ok) return result;

  const rawMeetings = result.data.meetings;
  if (!Array.isArray(rawMeetings)) {
    // An absent `meetings` key is Zoom's shape for "no recordings in this
    // window" — an empty page, not a fault. A PRESENT but non-array value is
    // shape drift and is reported as a drop so the pass truncates rather than
    // claiming to have covered the window.
    const absent = rawMeetings === undefined;
    if (!absent) log.warn({}, "Zoom recordings response carried a non-array `meetings`");
    return { ok: true, meetings: [], nextPageToken: null, dropped: absent ? 0 : 1 };
  }

  const meetings: ZoomRecordingMeeting[] = [];
  let dropped = 0;
  for (const raw of rawMeetings) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      dropped++;
      continue;
    }
    const row = raw as Record<string, unknown>;
    const uuid = str(row.uuid);
    if (uuid === null) {
      // No uuid means no source-id and no audience id. Unidentifiable, so it
      // cannot be stored and must not be marked covered.
      dropped++;
      continue;
    }
    const rawFiles = row.recording_files;
    const files: ZoomRecordingFile[] = [];
    if (Array.isArray(rawFiles)) {
      for (const rawFile of rawFiles) {
        if (rawFile === null || typeof rawFile !== "object" || Array.isArray(rawFile)) continue;
        const file = rawFile as Record<string, unknown>;
        const id = str(file.id);
        if (id === null) continue;
        files.push({
          id,
          fileType: str(file.file_type),
          downloadUrl: str(file.download_url),
          fileSize: typeof file.file_size === "number" ? file.file_size : null,
        });
      }
    }
    meetings.push({
      uuid,
      topic: str(row.topic),
      hostId: str(row.host_id),
      startTime: str(row.start_time),
      files,
    });
  }
  return { ok: true, meetings, nextPageToken: str(result.data.next_page_token), dropped };
}

// ---------------------------------------------------------------------------
// Participants — the audience roster
// ---------------------------------------------------------------------------

export interface ZoomParticipant {
  /** The participant's email, when Zoom exposes one. Null for a dial-in guest. */
  readonly email: string | null;
  readonly name: string | null;
  /** Zoom's user id, present only for signed-in participants. */
  readonly userId: string | null;
}

export interface ZoomParticipantsPage {
  readonly ok: true;
  readonly participants: readonly ZoomParticipant[];
  readonly nextPageToken: string | null;
}

/**
 * One page of a past meeting instance's participant list — the roster the
 * audience grant is derived from.
 *
 * `/past_meetings/{uuid}/participants` rather than
 * `/report/meetings/{uuid}/participants`: the report endpoint needs the
 * `report:read:admin` scope AND a Pro-or-above plan, so choosing it would make
 * the whole connector silently unavailable on plans that can otherwise record
 * meetings perfectly well. The past-meetings endpoint returns the same identity
 * fields this connector consumes.
 *
 * The caller MUST treat a failure here as roster-incomplete and block the
 * meeting — see `deriveMeetingParticipantGrant`. This function cannot enforce
 * that, which is why the type it returns has no partial arm: there is no
 * "here is some of the roster" value to accidentally consume.
 */
export async function fetchMeetingParticipantsPage(
  token: string,
  meetingUuid: string,
  params: { readonly pageSize: number; readonly nextPageToken?: string },
): Promise<ZoomParticipantsPage | ZoomReadError> {
  const result = await zoomGet(
    token,
    `/past_meetings/${encodeMeetingUuidForPath(meetingUuid)}/participants`,
    { page_size: String(params.pageSize), next_page_token: params.nextPageToken },
  );
  if (!result.ok) return result;

  const raw = result.data.participants;
  if (!Array.isArray(raw)) {
    // Unlike the recordings page, an unreadable participant list is NEVER
    // treated as "empty". An empty roster and an unreadable one are the two
    // situations the block-vs-flag split turns on, and collapsing them here
    // would hand the deriver a complete-looking empty roster — which reconciles
    // the audience to nobody and revokes every existing member.
    log.warn({}, "Zoom participants response carried no participant array");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  const participants: ZoomParticipant[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    participants.push({
      email: str(row.user_email),
      name: str(row.name),
      userId: str(row.user_id) ?? str(row.id),
    });
  }
  return { ok: true, participants, nextPageToken: str(result.data.next_page_token) };
}

// ---------------------------------------------------------------------------
// Transcript download
// ---------------------------------------------------------------------------

/**
 * Download a transcript file's VTT text.
 *
 * Two guards, and they cover different things. The HOST PIN refuses a
 * `download_url` that is not Zoom's at all — vendor data pointing somewhere
 * unexpected is an anomaly, not a URL to go and check. `guardedFetch` then
 * covers what the pin cannot: Zoom's download URLs redirect to a signed CDN
 * location, and the guard re-validates each hop against the private-range
 * blocklist before following it (#4779's connect-time DNS check included).
 *
 * The bearer token is dropped by `guardedFetch` on a cross-origin hop, which is
 * both correct and required — the signed redirect target does not want it, and
 * forwarding a workspace credential across an origin boundary is the leak the
 * guard exists to prevent.
 */
export async function fetchTranscriptText(
  token: string,
  downloadUrl: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<{ ok: true; text: string } | ZoomReadError> {
  let host: string;
  let scheme: string;
  try {
    const parsed = new URL(downloadUrl);
    host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    scheme = parsed.protocol;
  } catch {
    // Not a silent catch, so no `// intentionally ignored:` marker — that
    // marker is reserved for a genuinely swallowed error and using it here
    // would cost it its signal value. The URL is refused and reported; the
    // throw carries nothing this log line does not.
    log.warn({}, "Zoom recording download_url is not a parseable URL — refusing to fetch it");
    return { ok: false, error: "unusable_url", retryAfterSeconds: null };
  }
  // Scheme pinned HERE, not only in the egress guard. `guardedFetch` does reject
  // non-HTTPS (`isSafeExternalUrl`), so this is defence in depth rather than a
  // hole being closed — but the bearer token is attached below, and a local
  // refusal keeps that fact legible at the call site instead of resting on a
  // property of a helper three modules away. `outlook/api.ts`'s `isGraphUrl`
  // pins both axes for the same reason; this one had drifted to host-only.
  if (scheme !== "https:") {
    log.error({ host }, "Zoom recording download_url is not HTTPS — refusing to fetch it");
    return { ok: false, error: "unusable_url", retryAfterSeconds: null };
  }
  if (host !== "zoom.us" && !host.endsWith(ZOOM_DOWNLOAD_HOST_SUFFIX)) {
    // Loud, and with the host named: this is the one failure here that could
    // indicate something other than a bad day at the vendor.
    log.error(
      { host },
      "Zoom recording download_url points at a non-Zoom host — refusing to fetch it",
    );
    return { ok: false, error: "unusable_url", retryAfterSeconds: null };
  }

  let res: Response;
  try {
    res = await guardedFetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      log.error({ host: err.host }, "Zoom transcript download was blocked by the egress guard");
      return { ok: false, error: "transport", retryAfterSeconds: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, "Zoom transcript download failed at the transport layer");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  if (!res.ok) {
    // intentionally ignored: this reads the error body of an ALREADY-failed
    // response, purely to enrich the mapped error. The STATUS is the signal and
    // it is already in hand; a body that will not read (truncated, connection
    // dropped mid-error) must not turn a clean `http_429` into a transport
    // fault. `toReadError` treats "" as "no detail", which is the truth.
    const body = await res.text().catch(() => "");
    return toReadError(res.status, res.headers.get("retry-after"), body);
  }
  // A cheap PRE-FILTER, deliberately not called a bound. It refuses the common
  // case before buffering, but a chunked response carries no `Content-Length` —
  // `Number("")` is 0, the check passes, and `res.text()` buffers unbounded. A
  // signed CDN redirect for a large download is exactly where chunked shows up,
  // so the memory bound is still Zoom's in the case that matters most. Claiming
  // otherwise would be worse than the gap. A streaming reader with a running
  // byte counter is the real fix.
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    log.warn(
      { declared, maxBytes },
      "Zoom transcript exceeds the stored-transcript byte cap — refusing the download rather than buffering it",
    );
    // Release the connection rather than leaving it held until GC — the whole
    // point of this branch is not spending the resource.
    await res.body?.cancel().catch((err: unknown) => {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "Zoom transcript body cancel failed after an over-cap refusal",
      );
    });
    return { ok: false, error: "too_large", retryAfterSeconds: null };
  }
  try {
    return { ok: true, text: await res.text() };
  } catch (err) {
    // The one place this module could otherwise THROW, breaking its stated
    // "every read returns a discriminated result" contract: a mid-stream socket
    // reset happens after the headers are in hand.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Zoom transcript body read failed mid-stream",
    );
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
}
