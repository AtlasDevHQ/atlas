/**
 * The Microsoft Graph surface this connector needs (#4966) — three reads and an
 * auth exchange, with every vendor failure mapped into ONE error vocabulary.
 *
 * Modelled on `zoom/api.ts`, which is modelled on `lib/slack/api.ts`: each read
 * returns a discriminated `{ ok: true, … } | OutlookReadError` rather than
 * throwing, so the caller decides per read whether a failure is fatal to a
 * message, to a mailbox, to a pass, or to nothing. Only
 * `toOutlookClientError` (in `client.ts`) turns one into an exception, and only
 * `ratelimited` becomes the shared `ConnectorRateLimitError` — so the ENGINE's
 * bounded backoff owns the retry and this module owns no policy.
 *
 * ## Why not `@microsoft/microsoft-graph-client` / `@azure/identity`
 *
 * Microsoft ships good SDKs and this file does not use them. Asked and answered
 * once, here, because it is the first question a reader has.
 *
 * Every vendor connector in this repo hand-rolls `fetch` — Zoom, Slack,
 * Confluence, GitBook, Intercom, Front, Freshdesk, Zendesk, and Notion, which
 * has an official SDK that is likewise unused. That precedent alone would be a
 * weak argument; what settles it is that the SDKs' three headline features are
 * each something this architecture deliberately does NOT want:
 *
 *   - **Token caching.** `@azure/identity`'s credential types cache and refresh
 *     by design. The §"Client credentials" note below is the argument against
 *     exactly that: a process-wide cache is a cross-tenant object holding every
 *     workspace's decrypted-credential derivatives on a shared region process.
 *   - **Automatic retry.** The Graph client's middleware retries 429s itself.
 *     ADR-0030 puts backoff in the shared engine precisely so one vendor cannot
 *     have its own policy; adopting the SDK means disabling its best feature.
 *   - **Transparent pagination.** `PageIterator` follows `@odata.nextLink`
 *     internally — which is where {@link isGraphUrl}'s host pin lives. Handing
 *     that to a library means either losing the guard or fighting the middleware
 *     to keep it.
 *
 * Add the non-throwing result contract the ingest seam is built on (an SDK
 * throws, so every call would be wrapped back into this shape) and the SDK
 * version of this file is this file, plus a dependency tree, on an image that
 * already ships more than it needs.
 *
 * `@microsoft/microsoft-graph-types` is types-only and is the closest call. It
 * is still declined: this module parses from `unknown` on purpose, because an
 * omitted `ccRecipients` is a RUNTIME condition the whole `headersComplete`
 * guard exists to catch, and a compile-time model asserts the field is present.
 *
 * ## Client credentials (app-only), and why the token is not cached
 *
 * {@link fetchGraphAccessToken} exchanges the tenant's app registration for a
 * bearer token valid for roughly an hour. It is fetched ONCE PER PASS and held
 * in the client's closure — not cached in a module-level map keyed by tenant.
 * `zoom/api.ts` carries the argument in full and it is unchanged here: a
 * process-wide cache would be a cross-tenant object holding decrypted
 * credentials' derivatives for every workspace on a shared region process, and
 * one extra token call per sync cycle per install is a trade the security side
 * wins outright.
 *
 * The secrets go in the POST BODY, which is where Microsoft's token endpoint
 * wants them — not in the query string, which would make them a candidate for
 * any log line that records request URLs. Nothing in this module logs a request
 * body.
 *
 * ## The `@odata.nextLink` pin
 *
 * Graph paginates by handing back a FULL URL to follow. That is vendor-supplied
 * data this connector then fetches, which makes it an SSRF surface even though
 * the vendor is trusted — a compromised or confused upstream is exactly the case
 * a guard is for. {@link isGraphUrl} pins every followed link to Graph's own
 * host, and a link that is not on it is refused outright rather than merely
 * checked for private addresses. (No `guardedFetch` here, unlike Zoom's
 * transcript download: that call follows a signed redirect to a CDN and needs
 * per-hop re-validation, whereas a Graph page never leaves `graph.microsoft.com`
 * — so a link that wants to is already the anomaly, and refusing beats
 * following it carefully.)
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("brain.ingest.outlook.api");

/** Graph's v1.0 origin. Fixed — this connector never talks to a customer host. */
export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

/** The host every Graph request and every `@odata.nextLink` must be on. */
export const GRAPH_API_HOST = "graph.microsoft.com";

/** Microsoft's identity platform origin. Separate host from the API base. */
export const GRAPH_LOGIN_HOST = "https://login.microsoftonline.com";

/**
 * The app-only scope. `.default` means "every application permission already
 * consented for this app", which is the only form the client-credentials flow
 * accepts — you cannot narrow at request time, only at consent time.
 */
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

/** Per-request timeout. A hung read must not hold the pass. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a single Graph page's buffered response.
 *
 * A pre-filter on `Content-Length`, not a bound — the same honest caveat
 * `zoom/api.ts` makes about its own: a chunked response carries no length, so
 * this refuses the common case before buffering and does not make the memory
 * bound ours. It is generous because one page legitimately carries `$top`
 * message bodies; the per-MESSAGE cap in `client.ts` is what actually decides
 * what gets stored.
 */
export const MAX_PAGE_BYTES = 32 * 1024 * 1024;

/**
 * Rows a single Message-ID lookup will consider.
 *
 * Above one because same-mailbox duplicates are ORDINARY — `/users/{id}/messages`
 * spans every folder, so a self-CC puts one copy in Sent Items and one in the
 * Inbox with the same id. Bounded because the caller discriminates by digest and
 * a mailbox holding many rows for one Message-ID is anomalous regardless.
 */
export const MESSAGE_LOOKUP_MATCH_LIMIT = 5;

/**
 * The failure codes this module maps, beyond the open string set.
 *
 * Named because the client's error table branches on them and an admin-facing
 * sentence per code is the whole point — a raw Graph error code reaching
 * `knowledge_sync_state.error` tells an operator nothing actionable.
 */
export type OutlookReadErrorCode =
  | "ratelimited"
  | "invalid_auth"
  | "missing_scope"
  /** The app is consented but an ApplicationAccessPolicy excludes this mailbox. */
  | "mailbox_denied"
  /** The mailbox exists in the directory but has no Exchange Online mailbox. */
  | "mailbox_unavailable"
  | "not_found"
  | "too_large"
  /** A message row Graph returned could not be parsed into a message at all. */
  | "unreadable_message"
  | "transport";

export interface OutlookReadError {
  readonly ok: false;
  /** Open on purpose — an unmapped Graph code still reaches the operator verbatim. */
  readonly error: OutlookReadErrorCode | (string & {});
  /** Seconds Graph asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;
}

/** Is this URL one this connector may follow? Host-pinned, scheme-pinned. */
export function isGraphUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a silent catch, and no `// intentionally ignored:` marker: that marker
    // is reserved for a genuinely swallowed error, and using it for a parse
    // failure whose whole meaning is the `false` below would cost it its signal.
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Trailing dots make `graph.microsoft.com.` resolve identically while failing
  // a naive equality check, so they are stripped before comparing. Exact host
  // match, never a suffix test: `graph.microsoft.com.evil.test` ends with
  // nothing that matters, but `notgraph.microsoft.com` would pass a careless
  // `endsWith(".microsoft.com")`.
  return url.hostname.toLowerCase().replace(/\.+$/, "") === GRAPH_API_HOST;
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

/**
 * Map an HTTP status + body into the shared error vocabulary.
 *
 * The 403 split is the one that earns its keep. Graph returns 403 both for an
 * app that was never granted `Mail.Read` and for an app that HAS it but whose
 * ApplicationAccessPolicy excludes this particular mailbox — and those need
 * opposite repairs (consent the permission in Entra vs. widen the mail policy in
 * Exchange). Collapsing them sends an admin to re-consent a permission that was
 * already there, which is the "no generic error messages" rule in its most
 * expensive form.
 *
 * The 404-vs-400 split matters for the same reason: a mailbox that exists in the
 * directory but has no Exchange Online licence answers 400
 * `MailboxNotEnabledForRESTAPI`, which reads as a malformed request and is
 * actually a licensing fact about one user.
 */
export function toReadError(
  status: number,
  retryAfter: string | null,
  body: string,
): OutlookReadError {
  const retryAfterSeconds = parseRetryAfter(retryAfter);
  if (status === 429) return { ok: false, error: "ratelimited", retryAfterSeconds };
  if (status === 401) return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
  if (status === 403) {
    return {
      ok: false,
      error: /ApplicationAccessPolicy|ErrorAccessDenied/i.test(body)
        ? "mailbox_denied"
        : "missing_scope",
      retryAfterSeconds: null,
    };
  }
  if (status === 404) return { ok: false, error: "not_found", retryAfterSeconds: null };
  if (status === 400 && /MailboxNotEnabledForRESTAPI/i.test(body)) {
    return { ok: false, error: "mailbox_unavailable", retryAfterSeconds: null };
  }
  // 503/504 carry a Retry-After often enough that dropping it would waste the
  // one hint Graph gave us; the engine treats a null as "use your own schedule".
  return { ok: false, error: `http_${status}`, retryAfterSeconds };
}

/**
 * One authenticated Graph GET against an ABSOLUTE url, returning parsed JSON or
 * the mapped failure.
 *
 * Absolute rather than path-relative because pagination hands back whole URLs,
 * and having one function that takes either shape is how a followed link
 * eventually skips the host pin. Callers building a first-page URL use
 * {@link graphUrl}; callers following a page use the `@odata.nextLink` verbatim.
 * Both arrive here and both are pinned.
 */
async function graphGet(
  token: string,
  url: string,
  options: { readonly plainTextBody?: boolean } = {},
): Promise<{ ok: true; data: Record<string, unknown> } | OutlookReadError> {
  if (!isGraphUrl(url)) {
    // Loud, and without echoing the whole URL (a Graph link carries an opaque
    // skip token that is not a secret but is noise). This is the one failure
    // here that could indicate something other than a bad day at the vendor.
    log.error(
      { host: safeHost(url) },
      "Microsoft Graph request target is not on the Graph host — refusing to fetch it",
    );
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options.plainTextBody === true) {
    // Ask Exchange to convert the message body to plain text server-side.
    // Doing it here rather than stripping HTML ourselves matters for an EVIDENCE
    // store: a hand-rolled tag stripper silently drops content it mis-parses,
    // and a half-stripped message reads as a whole message to everything
    // downstream.
    headers.Prefer = 'outlook.body-content-type="text"';
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // Type-narrowed per CLAUDE.md, and logged rather than swallowed. A transport
    // fault is per-read, so the caller decides its blast radius.
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, "Microsoft Graph request failed at the transport layer");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    return toReadError(res.status, res.headers.get("retry-after"), body);
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    log.warn(
      { declared, maxBytes: MAX_PAGE_BYTES },
      "Microsoft Graph page exceeds the buffered-response cap — refusing it rather than buffering",
    );
    // Release the connection rather than leaving it held until GC — the whole
    // point of this branch is not spending the resource.
    await res.body?.cancel().catch((err: unknown) => {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "Microsoft Graph body cancel failed after an over-cap refusal",
      );
    });
    return { ok: false, error: "too_large", retryAfterSeconds: null };
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn({}, "Microsoft Graph returned a non-object JSON body");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}

/**
 * Read an error response's body for {@link toReadError} to classify.
 *
 * The empty-string fallback is NOT cosmetic and is therefore logged rather than
 * swallowed: `toReadError` decides `mailbox_denied` vs `missing_scope` — two
 * repairs in two different Microsoft consoles — by regexing this body, and it
 * decides `invalid_auth` vs a bare `http_400` the same way. A body that could
 * not be read silently downgrades both splits to their generic arm, which is the
 * "no generic error messages" rule failing in its most expensive form.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    log.warn(
      { status: res.status, err: err instanceof Error ? err.message : String(err) },
      "Microsoft Graph error body could not be read — the 403/400 repair split falls back to its generic arm",
    );
    return "";
  }
}

/** A URL's host for logging, or a placeholder — never throws on a bad URL. */
function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    // See `isGraphUrl` on why there is no ignore-marker here: the fallback IS
    // the handling, and it is the value the caller logs.
    return "(unparseable)";
  }
}

/** Build an absolute Graph URL from a path + query. */
export function graphUrl(path: string, query: Record<string, string | undefined> = {}): string {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Exchange the tenant's app registration for a bearer token.
 *
 * `tenantId` is interpolated into the PATH, so it is validated first. An
 * unvalidated value there is a path-traversal surface on an identity endpoint —
 * `common/oauth2/v2.0/token/../../..` — and the value arrives from an install
 * form.
 *
 * `encodeURIComponent` at the interpolation site is the PRIMARY defence and this
 * pattern is defence in depth — worth keeping because a value that is neither
 * GUID- nor domain-shaped is wrong for reasons beyond traversal. A tenant id is
 * a GUID or a verified domain name; both are covered by the character class, and
 * neither contains a slash.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;

export async function fetchGraphAccessToken(params: {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<{ ok: true; token: string } | OutlookReadError> {
  if (!TENANT_ID_PATTERN.test(params.tenantId)) {
    log.warn({}, "Microsoft tenant id is not a GUID or domain — refusing to build a token request");
    return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
  }
  const url = `${GRAPH_LOGIN_HOST}/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "client_credentials",
    scope: GRAPH_DEFAULT_SCOPE,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, "Microsoft token exchange failed at the transport layer");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    // Microsoft answers a bad client secret with 401 AND a bad tenant/app with
    // 400 `unauthorized_client` / `invalid_client`. Both are credential faults
    // and both must reach the admin as one, or a 400 falls through to
    // `http_400` and reads as an Atlas bug.
    if (res.status === 400 && /invalid_client|unauthorized_client|invalid_request/i.test(body)) {
      return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
    }
    return toReadError(res.status, res.headers.get("retry-after"), body);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A 200 whose body is not JSON is Microsoft-side (a proxy interstitial, a
    // maintenance page) — NOT a bad credential. Collapsing it into
    // `invalid_auth` sends the admin to rotate a secret that was fine.
    log.warn({}, "Microsoft token exchange returned an unreadable body");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  const token = (parsed as Record<string, unknown>).access_token;
  if (typeof token !== "string" || token === "") {
    log.warn({}, "Microsoft token exchange returned no access_token");
    return { ok: false, error: "invalid_auth", retryAfterSeconds: null };
  }
  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Mailbox identity
// ---------------------------------------------------------------------------

export interface OutlookMailbox {
  /** The Graph user OBJECT ID — a GUID. What the audience token carries. */
  readonly id: string;
  readonly userPrincipalName: string | null;
  /** The mailbox's primary SMTP address, when the directory exposes one. */
  readonly mail: string | null;
}

/**
 * Resolve a configured mailbox (a GUID or a userPrincipalName) to its object id.
 *
 * Called once per mailbox per pass, and the extra round trip buys two things
 * that are worth it. The audience token then carries a GUID rather than a
 * personal email address — `grant.ts`'s {@link emailMessageAudienceId} argues
 * why that matters for a token stored in `visible_to` and exported in region
 * bundles — and the token survives a rename, which a UPN does not: renaming a
 * user would otherwise orphan every audience minted from their mailbox, and the
 * facts would go invisible at the staleness bound with nothing red anywhere.
 *
 * ⚠️ THIS READ NEEDS A SECOND APPLICATION PERMISSION. `/users/{id}` is a
 * DIRECTORY read, so the app registration needs one on top of `Mail.Read` — the
 * install form and the catalog row both say so, because discovering it as a sync
 * error a cycle later is discovering it in the wrong place.
 *
 * **`User.ReadBasic.All`, not `User.Read.All`.** The `$select` below asks for
 * exactly `id`, `userPrincipalName` and `mail`, all three of which are in the
 * basic profile, so the wider grant buys nothing — and naming it would undercut
 * the next paragraph at the moment an Entra admin is most likely to push back.
 * (`User.Read.All` also works; an app that already has it needs no change.)
 *
 * Worth being explicit that this is not a permission ESCALATION, since asking
 * for a second scope reads like one. `Mail.Read` (application) already grants
 * this app the contents of every mailbox in the tenant; `User.ReadBasic.All`
 * grants names and addresses of directory objects, which is strictly less than
 * what it can already read. What it buys is that no personal address is written
 * into a stored ACL token.
 *
 * The asymmetry to know about: an Exchange ApplicationAccessPolicy narrows
 * `Mail.Read` to a security group, and it does NOT narrow `User.Read.All`. So a
 * correctly-narrowed install can still resolve identities for mailboxes it
 * cannot read mail from — which is why the install probe exercises BOTH.
 */
export async function fetchMailbox(
  token: string,
  mailbox: string,
): Promise<{ ok: true; mailbox: OutlookMailbox } | OutlookReadError> {
  const result = await graphGet(
    token,
    graphUrl(`/users/${encodeURIComponent(mailbox)}`, {
      $select: "id,userPrincipalName,mail",
    }),
  );
  if (!result.ok) return result;
  const id = str(result.data.id);
  if (id === null) {
    log.warn({}, "Microsoft Graph returned a user with no object id");
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  return {
    ok: true,
    mailbox: {
      id,
      userPrincipalName: str(result.data.userPrincipalName),
      mail: str(result.data.mail),
    },
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One participant address as the directory reported it. */
export interface OutlookAddress {
  /** Lower-cased SMTP address, or null when the entry carried none. */
  readonly address: string | null;
  readonly name: string | null;
}

/**
 * One mail message, normalised.
 *
 * `headersComplete` is the field to read carefully — see
 * {@link EmailMessageParticipation.headersComplete} in `grant.ts`. It reports
 * whether the participant FIELDS came back, and it is keyed on the presence of
 * the keys rather than on their contents, because "this message has no Cc" and
 * "the Cc field was not returned" are opposite situations that a contents check
 * cannot tell apart. Getting it wrong does not merely under-grant: the same set
 * is what `reconcileAudienceMembership` deletes against, so an omitted field
 * REVOKES the people it dropped.
 *
 * There is deliberately no `bcc` field on this type at all. `grant.ts` decides
 * that BCC is ignored for the whole email class, and the cheapest way to keep a
 * later edit from quietly honouring it is for the value never to be carried
 * here. (`$select` does not request it either, so nothing is being hidden — the
 * shape and the request agree.)
 *
 * There is no `conversationId` either, for the reason `config.ts` gives: the
 * connector is message-grained and a thread id it never reads cannot end up in
 * a stored key by accident.
 */
export interface OutlookMessage {
  /**
   * Graph's own per-mailbox id. Parsed but currently READ BY NOTHING — carried
   * so a future log line has a vendor-side handle on a message the per-message
   * warnings identify only by mailbox today. Never a stored key: it differs per
   * mailbox and is re-minted when a message moves between folders.
   */
  readonly graphId: string | null;
  /** The RFC 5322 Message-ID, RAW as Graph returned it (brackets included). */
  readonly internetMessageId: string | null;
  readonly subject: string | null;
  readonly receivedDateTime: string | null;
  readonly from: OutlookAddress | null;
  readonly toRecipients: readonly OutlookAddress[];
  readonly ccRecipients: readonly OutlookAddress[];
  /** True when `from`, `toRecipients` and `ccRecipients` were all present. */
  readonly headersComplete: boolean;
  /** The plain-text body, or null when Graph returned none. */
  readonly bodyText: string | null;
  /**
   * True when the message DID carry a body and Atlas refused it — Graph
   * returned HTML despite the `Prefer: outlook.body-content-type="text"` ask.
   *
   * Separate from `bodyText === null` because the two must not be handled
   * alike, and collapsing them was a real defect caught by test. A message with
   * genuinely no body (a subject-only "approved — EOM") is COMPLETE evidence
   * and can be stored as its header block. A message whose body was refused is
   * NOT: storing its headers alone produces an episode that reads as a whole
   * message to every downstream consumer while the thing somebody actually
   * wrote is missing — the same fabricated-completeness failure the oversize
   * SKIP-don't-truncate rule exists to prevent, arriving by a different door.
   */
  readonly bodyUnreadable: boolean;
}

export interface OutlookMessagesPage {
  readonly ok: true;
  readonly messages: readonly OutlookMessage[];
  /** The `@odata.nextLink`, host-pinned, or null when this was the last page. */
  readonly nextLink: string | null;
  /**
   * Entries Graph returned that were not readable objects. COUNTED rather than
   * dropped silently: they sit inside the window the pass is about to mark
   * covered, so the client truncates instead of advancing past them — the same
   * rule `zoom/api.ts` and `slack/client.ts` apply.
   *
   * ⚠️ A message with no `internetMessageId` is NOT counted here. That is a
   * permanent condition (a header a message does not have, it never acquires),
   * and truncating on it would freeze the cursor forever — the failure mode
   * `zoom/client.ts`'s `too_large` comment describes. `client.ts` counts those
   * as a skip instead, and the window still advances.
   */
  readonly dropped: number;
}

/** Narrow one JSON value to a non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The `$select` both message reads share for their participant half.
 *
 * One constant, two callers, on purpose: the ingest walk and the audience
 * re-verifier must agree EXACTLY on which participant fields they ask for, or
 * they derive different audiences for the same message and the re-verifier
 * revokes whatever ingest granted. The re-verifier adds nothing to this list;
 * the ingest walk adds only `body`.
 */
export const MESSAGE_PARTICIPANT_SELECT =
  "id,internetMessageId,subject,receivedDateTime,from,toRecipients,ccRecipients";

/** Normalise one Graph `emailAddress`-shaped entry. */
function toAddress(raw: unknown): OutlookAddress | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const wrapper = raw as Record<string, unknown>;
  const inner = wrapper.emailAddress;
  const row =
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : wrapper;
  const address = str(row.address);
  // An entry that is an object but names no address — Graph's "Undisclosed
  // recipients" shape — is REFUSED, not returned with a null address. Returned,
  // it survives `toAddressList`, keeps `headersComplete: true`, and is then
  // silently dropped by `messageParticipants`: a roster under-reported on the
  // one path the vendor plausibly produces, which is exactly what
  // `toAddressList`'s "no safe way to under-report a roster" is about.
  //
  // Safe to refuse only because `headersComplete: false` is a permanent SKIP
  // rather than a retryable block (`client.ts`). Making this strict while that
  // was still a block converted a data-quality case into a stalled mailbox.
  if (address === null) return null;
  return {
    // Lower-cased at the boundary, once. The address is a JOIN KEY against
    // `user.email` in `resolvePrincipals`, and mail systems are case-insensitive
    // on the domain half and conventionally on the local half too; leaving the
    // vendor's casing would make `Ann@x.com` and `ann@x.com` two principals and
    // resolve neither reliably.
    address: address === null ? null : address.trim().toLowerCase(),
    name: str(row.name),
  };
}

/**
 * Normalise a Graph recipient ARRAY, or null when the key was absent, was not an
 * array, or held an entry this parser could not read.
 *
 * An unreadable ENTRY fails the whole list rather than being dropped from it,
 * on the same argument `headersComplete` rests on one level up: a silently
 * shortened recipient list is a PARTIAL set that LOOKS complete, and the set is
 * what `reconcileAudienceMembership` deletes against — so the dropped entries
 * would be REVOKED rather than merely ungranted. There is no safe way to
 * under-report a roster here.
 */
function toAddressList(raw: unknown): OutlookAddress[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OutlookAddress[] = [];
  for (const entry of raw) {
    const address = toAddress(entry);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

/** Parse one message object out of a Graph response. */
export function parseOutlookMessage(raw: unknown): OutlookMessage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const to = toAddressList(row.toRecipients);
  const cc = toAddressList(row.ccRecipients);
  // An absent `from` and an unattributable one (some system-generated mail) are
  // folded together into `headersComplete: false`, deliberately: this parser
  // cannot tell them apart from the payload alone, and the safe reading of an
  // unattributable sender is the same as the safe reading of a missing one — do
  // not derive an audience from headers that did not fully arrive.
  //
  // No `Object.hasOwn` guard, because it would draw a distinction the sentence
  // above disclaims: `toAddress(undefined)` already answers `null`.
  const from = toAddress(row.from);
  return {
    graphId: str(row.id),
    internetMessageId: str(row.internetMessageId),
    subject: str(row.subject),
    receivedDateTime: str(row.receivedDateTime),
    from,
    toRecipients: to ?? [],
    ccRecipients: cc ?? [],
    // Keyed on the KEYS, never on the contents. An empty `toRecipients` array is
    // a complete answer (a Cc-only message); an ABSENT one is not an answer at
    // all, and treating it as empty would revoke every To recipient on the next
    // reconcile.
    headersComplete: to !== null && cc !== null && from !== null,
    ...readBody(row.body),
  };
}

/**
 * Pull the plain-text content out of Graph's `body` wrapper, and report whether
 * a body was PRESENT but refused.
 *
 * The `Prefer` header asks Exchange for text and it honours it — but a response
 * that came back HTML anyway is NOT stored as if it were text: a stored HTML
 * blob puts markup into an evidence body that every reader, and the extractor,
 * treats as what somebody wrote.
 *
 * Refusing is only half the job. The caller must also be able to tell that
 * refusal apart from "this message has no body", because the safe handling
 * differs — see {@link OutlookMessage.bodyUnreadable}. Returning both fields
 * together is what makes the two states impossible to conflate at the call site.
 */
function readBody(raw: unknown): { bodyText: string | null; bodyUnreadable: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { bodyText: null, bodyUnreadable: false };
  }
  const row = raw as Record<string, unknown>;
  const contentType = str(row.contentType);
  const content = str(row.content);
  if (content === null) return { bodyText: null, bodyUnreadable: false };
  // An ABSENT `contentType` with content present is REFUSED, not trusted. The
  // module applies "keyed on presence, not contents" to `headersComplete` two
  // functions up and must apply it here too: content whose type Graph did not
  // state could be HTML, and storing HTML as evidence is the whole failure
  // `bodyUnreadable` exists to prevent. Reading absence as "probably text" is a
  // fail-OPEN in the one direction this docstring claims is closed.
  if (contentType === null || contentType.toLowerCase() !== "text") {
    return { bodyText: null, bodyUnreadable: true };
  }
  return { bodyText: content, bodyUnreadable: false };
}

/**
 * One page of a mailbox's messages, oldest first, from `since` onward.
 *
 * `$orderby` and `$filter` are on the SAME property deliberately: Graph rejects
 * a message query that filters on one property and orders by another, and the
 * rejection is a 400 that reads like a malformed request rather than like an
 * unsupported combination.
 *
 * Ascending order is what makes the cursor meaningful. A descending walk cannot
 * produce a contiguous "covered through" instant — it covers the NEWEST slice
 * first, so an interrupted pass leaves a hole in the middle that nothing
 * re-reads, and in an append-only store a hole and an absence look identical.
 *
 * `isDraft eq false` excludes drafts, and that is a correctness filter rather
 * than a tidiness one: a draft was never sent, so nobody received it, so it has
 * no audience to derive — and its `internetMessageId` is absent or provisional
 * until it is, which would put an unstable value in a stored key.
 */
export async function fetchMailboxMessagesPage(
  token: string,
  params: {
    readonly mailboxId: string;
    /** ISO-8601 instant. Messages received at or after it (`ge`, inclusive). */
    readonly since: string;
    readonly pageSize: number;
  },
): Promise<OutlookMessagesPage | OutlookReadError> {
  const url = graphUrl(`/users/${encodeURIComponent(params.mailboxId)}/messages`, {
    $select: `${MESSAGE_PARTICIPANT_SELECT},body`,
    // ⚠️ ORDER MATTERS INSIDE `$filter`, and not for the reason it looks like.
    // Outlook's documented restriction is that every property in `$orderby` must
    // ALSO appear in `$filter`, in the SAME order, and BEFORE any property that
    // appears only in `$filter`. So `receivedDateTime` leads and `isDraft`
    // follows; the reverse spelling risks a 400 (`InefficientFilter` / "the
    // restriction or sort order is too complex"), which reads like a malformed
    // request rather than like an unsupported combination.
    $filter: `receivedDateTime ge ${params.since} and isDraft eq false`,
    $orderby: "receivedDateTime asc",
    $top: String(params.pageSize),
  });
  return readMessagesPage(token, url);
}

/** Follow an `@odata.nextLink` from a previous page. Host-pinned in `graphGet`. */
export async function fetchMailboxMessagesNextPage(
  token: string,
  nextLink: string,
): Promise<OutlookMessagesPage | OutlookReadError> {
  return readMessagesPage(token, nextLink);
}

async function readMessagesPage(
  token: string,
  url: string,
): Promise<OutlookMessagesPage | OutlookReadError> {
  const result = await graphGet(token, url, { plainTextBody: true });
  if (!result.ok) return result;

  const rawValue = result.data.value;
  if (!Array.isArray(rawValue)) {
    // An absent `value` key is not a shape Graph produces for a collection —
    // an empty page is `{ value: [] }`. So unlike the Zoom recordings read,
    // where an absent key legitimately means "nothing in this window", this is
    // drift either way and is reported as a drop so the pass truncates rather
    // than claiming to have covered the window.
    log.warn({}, "Microsoft Graph messages response carried no `value` array");
    return { ok: true, messages: [], nextLink: null, dropped: 1 };
  }

  const messages: OutlookMessage[] = [];
  let dropped = 0;
  for (const raw of rawValue) {
    const message = parseOutlookMessage(raw);
    if (message === null) {
      dropped++;
      continue;
    }
    messages.push(message);
  }

  const rawNext = str(result.data["@odata.nextLink"]);
  // A nextLink off the Graph host is refused HERE rather than at follow time, so
  // the pass reports an incomplete page instead of silently stopping early: an
  // unfollowed link means the rest of the window was never read, and the
  // difference between "last page" and "would not follow" is the difference
  // between advancing the cursor and freezing it.
  if (rawNext !== null && !isGraphUrl(rawNext)) {
    log.error(
      { host: safeHost(rawNext) },
      "Microsoft Graph @odata.nextLink points off the Graph host — refusing to follow it",
    );
    return { ok: false, error: "transport", retryAfterSeconds: null };
  }
  return { ok: true, messages, nextLink: rawNext, dropped };
}

/**
 * Find ONE message in ONE mailbox by its RFC 5322 Message-ID — the audience
 * re-verifier's read.
 *
 * `$filter` on `internetMessageId` rather than a direct `GET /messages/{id}`,
 * even though the direct GET is one fewer moving part. Graph's own message id is
 * re-minted when a message MOVES BETWEEN FOLDERS, so an archived or
 * rule-filed message would 404 on the direct form and its audience would fail
 * every cycle forever. Rotation (#4971) bounds what that costs the rest of the
 * workspace to one slot per cycle; it does nothing for the audience itself,
 * which would simply never be repaired. The Message-ID is immutable, so the
 * filter finds the message wherever it now lives.
 *
 * Returns EVERY match, not one, and that is the correction to a fix that was
 * itself wrong. An earlier cut refused any lookup returning more than one row,
 * reasoning that two messages sharing a Message-ID is the shape of a forged
 * header. It is — but it is also the shape of ORDINARY MAIL: this is the
 * MAILBOX-WIDE collection, spanning every folder, so a user who CCs themselves
 * (or a shared mailbox that mails a distribution list it belongs to) has one
 * copy in Sent Items and one in the Inbox, same id, same mailbox. Refusing that
 * turned a routine habit into an audience that fails EVERY cycle forever. Since
 * #4971 that no longer spreads across the whole workspace — the scan rotates on
 * attempt — but the self-CC's own audience would still never be repaired.
 * Trading an integrity hole for an availability hole is not a fix.
 *
 * So ambiguity is resolved rather than refused, and the discriminator already
 * exists: `outlook/audience.ts` keeps the matches whose participant digest is
 * the one the audience was MINTED from. The benign duplicate collapses (both
 * copies carry identical From/To/Cc, so identical digests); a forged copy is
 * simply not among the matches, so it can neither rewrite membership nor deny
 * service to the real message.
 *
 * An empty array means Graph answered cleanly and the mailbox does not contain
 * the message. The caller must treat that as UNREADABLE and abort, never as
 * "this message has no recipients" — reconciling an absent message would revoke
 * its whole audience.
 */
export async function fetchMessageByInternetMessageId(
  token: string,
  mailboxId: string,
  internetMessageId: string,
): Promise<{ ok: true; messages: readonly OutlookMessage[] } | OutlookReadError> {
  // TWO spellings, tried in order, and the second is not belt-and-braces.
  //
  // Graph stores `internetMessageId` as the raw RFC 5322 header, which is
  // angle-bracketed — but `config.ts` STRIPS the brackets before storing, so the
  // id arriving here has none and the bracketed form is the one that matches.
  // `normalizeInternetMessageId` strips only when BOTH brackets are present, so
  // a sending system that emitted a bare id round-trips bare, and the bracketed
  // filter would miss it.
  //
  // Missing here is not a benign miss: the caller reads a zero-result lookup as
  // "unreadable" and aborts, so a message that is really there would fail its
  // audience EVERY cycle — permanently, and rotation (#4971) does not repair it,
  // it only stops it starving the rest of the workspace.
  // The fallback costs one extra call only when the first found nothing.
  const literal = internetMessageId.replace(/'/g, "''");
  for (const filterValue of [`<${literal}>`, literal]) {
    const url = graphUrl(`/users/${encodeURIComponent(mailboxId)}/messages`, {
      $select: MESSAGE_PARTICIPANT_SELECT,
      // Single-quoted OData string literal: the escape is a DOUBLED single
      // quote, not a backslash. A Message-ID legally contains `'` (RFC 5322
      // `atext` includes it), so without the doubling an apostrophe in an id
      // produces a malformed filter — Graph answers 400, the audience fails
      // every cycle, and the cause is one character in a value nobody prints.
      $filter: `internetMessageId eq '${filterValue}'`,
      // Enough to carry the benign same-mailbox duplicates (Sent Items + Inbox)
      // plus a forged copy or two, without paging. The caller discriminates by
      // digest, so extra rows are cheap and a missing row is not.
      $top: String(MESSAGE_LOOKUP_MATCH_LIMIT),
    });
    const result = await graphGet(token, url);
    if (!result.ok) return result;

    const rawValue = result.data.value;
    if (!Array.isArray(rawValue)) {
      log.warn({}, "Microsoft Graph message lookup carried no `value` array");
      return { ok: false, error: "transport", retryAfterSeconds: null };
    }
    if (rawValue.length === 0) continue;
    const messages: OutlookMessage[] = [];
    for (const raw of rawValue) {
      const message = parseOutlookMessage(raw);
      if (message === null) {
        // An unparseable row is refused rather than dropped: the caller picks a
        // match by digest, and a row it could not read is a match it cannot
        // rule in OR out. Its own code, not `transport` — an operator reading
        // "transport" on a permanently-failing audience is told a network story
        // about a data-shape event.
        log.warn(
          { mailboxId },
          "Microsoft Graph message lookup returned an unreadable message object — refusing the whole lookup rather than silently narrowing the matches",
        );
        return { ok: false, error: "unreadable_message", retryAfterSeconds: null };
      }
      messages.push(message);
    }
    return { ok: true, messages };
  }
  return { ok: true, messages: [] };
}
