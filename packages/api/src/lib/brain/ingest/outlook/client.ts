/**
 * The Outlook mail vendor client (#4966) — the thin half of #4963's seam. It
 * walks each configured mailbox's messages, derives each message's audience,
 * and converts it to a {@link BrainEpisodeRecord}. It owns NO scheduling and NO
 * backoff policy: cadence and 429 retry are the shared engine's. It DOES own
 * bounding its own fetch, because the engine hands it the per-sync budget as
 * `maxEpisodes`.
 *
 * **The shared ingest ENGINE did not change to add this file** — `episode-sync.ts`,
 * `episodes.ts` and `ingest/types.ts` are all untouched, which is the same seam
 * proof #4965 made and the reason #4963 generalized the registry in the first
 * place. The one shared ingest file this connector extends is `ingest/grant.ts`,
 * which gains the email class's deriver alongside the chat and transcript ones
 * — ADDITIVELY, as a new function with no `[org]` arm, never by branching an
 * existing deriver.
 *
 * ## The walk, and why it is instant-granular where Zoom's is date-granular
 *
 * Graph's message collection takes `$filter=receivedDateTime ge <instant>`, so
 * the cursor stores an INSTANT rather than a date — Zoom's coarser date windows
 * exist because Zoom's endpoint takes dates and caps a query at one month, and
 * neither constraint applies here.
 *
 * The walk is ASCENDING (`$orderby=receivedDateTime asc`), and that is a
 * correctness requirement rather than a preference. A descending walk covers the
 * NEWEST slice first, so a pass that runs out of budget leaves a HOLE in the
 * middle of its window — and in an append-only store a hole and an absence look
 * identical forever. Ascending means an interrupted pass has covered a
 * contiguous PREFIX, which a resume point can describe.
 *
 * `params.since` and the returned `highWaterMark` are deliberately NOT this
 * client's resume path — the per-mailbox cursor is, because one high-water mark
 * cannot describe N mailboxes sitting at different depths. `since` is read for
 * nothing; `highWaterMark` is reported honestly for the engine's own bookkeeping.
 * Naming that here because it is the trap #4965's review found by execution: its
 * block arm nulled a mark the connector never read, while the CURSOR advanced
 * past the blocked meeting anyway.
 *
 * The resume point is inclusive (`ge`, not `gt`): a pass resumes AT the last
 * message it processed rather than after it. That re-reads one message, which is
 * a deduped no-op write, and it is the safe direction — an exclusive resume
 * skips every message sharing that exact timestamp, and bulk mail routinely
 * shares timestamps to the second.
 *
 * ## The block-vs-skip split, which is NOT the same as block-vs-flag
 *
 * ADR-0036 §T6's block-vs-flag asymmetry is about GRANTS: a grant Atlas cannot
 * derive blocks, an entity Atlas cannot resolve flags. This connector honours it
 * (it resolves exactly one thing, the audience, and resolves no entities at all
 * — sender and recipient names stay as text in the body for the extraction stage
 * to attribute, so there is no code path here that could turn an unrecognised
 * person into a block).
 *
 * On top of that there is a SECOND split, and conflating it with the first is
 * how #4965 shipped an outage. Among the things that stop a message being
 * ingested, some are RETRYABLE and some are PERMANENT:
 *
 *   - **BLOCK** — retryable. An access grant that could not be built from the
 *     mailbox/message ids; a membership write that failed. Nothing is ingested,
 *     the resume point does NOT advance past the message, and the pass reports
 *     `coverageIncomplete`. The next cycle tries again.
 *   - **SKIP** — permanent. Unreadable participant headers; headers that came
 *     back complete and named NOBODY; no RFC 5322 Message-ID; more participants
 *     than the cap; a body over the byte cap; a body Graph returned as HTML
 *     rather than the plain text asked for; a message that composed to nothing
 *     at all. Nothing is ingested, it is COUNTED, and the resume point DOES
 *     advance. All but one also warn — the empty-composed-body skip increments
 *     `skips.emptyBody` and surfaces only in the aggregate `log.info` at the end
 *     of the pass, which is deliberate (it is the high-volume one) but means
 *     "counted and warned" is not true of every arm.
 *
 * ⚠️ **Unreadable participant headers are PERMANENT and belong on the SKIP arm**
 * — the classification `runMessage` implements and the one this list got wrong
 * until it was corrected. Graph does not transiently omit a `$select`ed field on
 * a 200, so the headers of a stored message do not change; routing it down the
 * block arm would freeze the mailbox at the message before it. Stated loudly
 * here because this header is the first thing a maintainer of this file reads,
 * and it disagreed with the code ~350 lines below it.
 *
 * To be precise about whose outage that was: this connector has classified
 * `!headersComplete` as a skip since the day it landed, so the frozen mailbox is
 * the counterfactual, not history. The shipped freeze was ZOOM's (#4965), which
 * is what the paragraph below cites — an earlier wording compressed the two into
 * "the very outage", reading as though Outlook had shipped it.
 *
 * Routing a permanent condition down the block arm is what froze Zoom's cursor
 * every pass until it fell below the backfill floor and wedged the source
 * outright (`zoom/client.ts`'s `too_large` comment). A message with no
 * Message-ID does not grow one overnight.
 *
 * Both arms refuse to ingest and both refuse any wider grant. The difference is
 * only whether the walk waits for the condition to change.
 *
 * ## Extraction stays async
 *
 * `BrainEpisodeRecord` has no `extractedAt`, so this client cannot stamp one
 * even by accident, and it calls nothing in `lib/brain/extract.ts`. Messages
 * land with `extracted_at IS NULL` and the extraction fiber drains them on its
 * own clock. There is no synchronous fast-path, and the type is what prevents
 * one.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import { AUDIENCE_PREFIX } from "@atlas/api/lib/brain/acl";
import { deriveEmailRecipientGrant } from "../grant";
import type {
  BrainEpisodeRecord,
  BrainSourceChanges,
  BrainSourceFetchParams,
  BrainSourceVendorClient,
} from "../types";
import {
  fetchMailbox,
  fetchMailboxMessagesNextPage,
  fetchMailboxMessagesPage,
  type OutlookMessage,
  type OutlookMessagesPage,
  type OutlookReadError,
} from "./api";
import {
  MAX_MESSAGE_PARTICIPANTS,
  messageParticipants,
  reconcileEmailAudience,
  redactAudienceDigest,
  type OutlookAudienceDeps,
} from "./audience";
import { OUTLOOK_MAIL_SOURCE, normalizeInternetMessageId, outlookEpisodeSourceId } from "./config";

const log = createLogger("brain.ingest.outlook.client");

/**
 * Messages per page — a deliberate size well inside Graph's ceiling rather than
 * the ceiling itself. A page carries `$top` message BODIES, so this trades round
 * trips against `MAX_PAGE_BYTES`; raising it makes the buffered-response
 * pre-filter more likely to fire, which is a worse failure than one more request.
 */
export const MESSAGES_PAGE_SIZE = 50;

/** Hard bound on message pages per mailbox per pass — one mailbox can't hog the cycle. */
export const MAX_MESSAGE_PAGES_PER_MAILBOX = 40;

/**
 * Largest message body this connector will store, in bytes.
 *
 * An oversize body is SKIPPED WITH A WARNING, never truncated. Truncating
 * evidence is the one thing an evidence store must not do quietly: half a
 * message reads as a whole message to every downstream consumer, and the
 * extractor would produce confident facts from a mail whose ending it never saw.
 * A skip is visible, counted, and repairable by raising this bound.
 */
export const MAX_EMAIL_BODY_BYTES = 1024 * 1024;

/** The opaque cursor persisted in `knowledge_sync_state.sync_cursor`. */
export interface OutlookMailCursor {
  readonly v: 1;
  /**
   * Graph user OBJECT ID → the ISO-8601 instant that mailbox is covered through.
   *
   * Keyed on the object id rather than on the configured mailbox string so a
   * userPrincipalName rename does not reset the mailbox to the backfill floor
   * and re-walk months of mail. Same argument as the audience token's, one
   * directory over.
   */
  readonly mailboxes: Readonly<Record<string, string>>;
}

/**
 * Parse the stored cursor. An unreadable cursor DEGRADES to "no mark" rather
 * than throwing — throwing would wedge the source permanently on one bad row
 * with no operator-reachable repair, whereas re-crawling from the backfill floor
 * is a deduped no-op write. Every degrade is logged, because the loss is real
 * when the lost mark was OLDER than the floor: that history is then never
 * fetched.
 *
 * Individual malformed ENTRIES are dropped rather than failing the whole cursor:
 * one mailbox's bad watermark must not re-walk every other mailbox's backfill.
 */
export function parseOutlookCursor(raw: string | null): Record<string, string> {
  if (raw === null || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Outlook mail cursor is not valid JSON — restarting at the backfill floor",
    );
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn({}, "Outlook mail cursor is not an object — restarting at the backfill floor");
    return {};
  }
  const outer = parsed as Record<string, unknown>;
  if (outer.v !== 1) {
    log.warn(
      { version: outer.v },
      "Outlook mail cursor has an unrecognised version — restarting at the backfill floor",
    );
    return {};
  }
  const rawMailboxes = outer.mailboxes;
  if (rawMailboxes === null || typeof rawMailboxes !== "object" || Array.isArray(rawMailboxes)) {
    log.warn({}, "Outlook mail cursor carries no mailbox map — restarting at the backfill floor");
    return {};
  }
  const marks: Record<string, string> = {};
  for (const [mailboxId, value] of Object.entries(rawMailboxes as Record<string, unknown>)) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      log.warn({ mailboxId }, "Outlook mail cursor entry is not a parseable instant — that mailbox restarts at the backfill floor");
      continue;
    }
    marks[mailboxId] = value;
  }
  return marks;
}

/**
 * Serialise the cursor VERBATIM — this function keeps whatever it is handed.
 *
 * Pruning lives at the CALL SITE and is conditional; see the carry-forward block
 * at the end of `fetchEpisodes`. It is stated there rather than here because the
 * condition ("only when every configured mailbox resolved") is about what the
 * pass learned, which this function cannot see.
 *
 * ⚠️ This docstring previously claimed the pruning AND justified it by saying a
 * stale mark would "silently skip everything in between". That justification was
 * wrong on the merits and is corrected rather than moved: resuming from an OLDER
 * mark over-reads, and cannot skip. If the mark is below the backfill floor, the
 * `historyTruncated` branch warns and restarts at the floor. Carrying a dead
 * entry costs one map key; DROPPING a live one is what costs history — which is
 * the conclusion the carry-forward block reaches, and two contradictory accounts
 * of the same risk is how the next fix goes the wrong way.
 */
export function serialiseOutlookCursor(marks: Readonly<Record<string, string>>): string {
  return JSON.stringify({ v: 1, mailboxes: marks } satisfies OutlookMailCursor);
}

/**
 * Turn a Graph read failure into the shared throttle vocabulary, or a plain
 * `Error`. `ratelimited` becomes {@link ConnectorRateLimitError} so the ENGINE's
 * bounded backoff applies unchanged — a client that retried on its own would be
 * exactly the per-vendor backoff ADR-0030 forbids.
 *
 * The non-throttle sentences are admin-facing and name the repair, because they
 * land in `knowledge_sync_state.error` where an operator reads them. The
 * `missing_scope` / `mailbox_denied` pair is the one that earns its keep: both
 * are 403s, and they are repaired in two different Microsoft consoles.
 */
export function toOutlookClientError(context: string, failure: OutlookReadError): Error {
  switch (failure.error) {
    case "ratelimited":
      return new ConnectorRateLimitError(
        `Microsoft Graph is rate limiting ${context}`,
        failure.retryAfterSeconds,
      );
    case "invalid_auth":
      return new Error(
        `Microsoft rejected the workspace's credential while reading ${context} — check the app registration's client id, client secret and tenant id under Admin → Integrations, and confirm the secret has not expired, then sync again.`,
      );
    case "missing_scope":
      return new Error(
        `The Entra app registration is missing the application permission needed to read ${context} (Mail.Read) — add it, grant admin consent, then sync again.`,
      );
    case "mailbox_denied":
      return new Error(
        `Microsoft refused access to ${context} even though the app is consented — an Exchange ApplicationAccessPolicy is excluding this mailbox. Add it to the policy's mail-enabled security group, then sync again.`,
      );
    case "mailbox_unavailable":
      return new Error(
        `${context} has no Exchange Online mailbox — the user exists in the directory but is not licensed for mail. Remove it from this source's mailbox list, or license it.`,
      );
    case "not_found":
      return new Error(
        `Microsoft no longer recognises ${context} — the mailbox may have been deleted or renamed. Re-install this source with its current address.`,
      );
    case "too_large":
      // Reachable only if a caller throws on this instead of skipping it. The
      // `default` arm's "Microsoft rejected the request" would be a lie — Atlas
      // refused — and would name no cap and no repair.
      return new Error(
        `${context} returned more data than Atlas buffers in one page — it was not ingested. Nothing partial is stored.`,
      );
    default:
      return new Error(`Microsoft Graph rejected the request for ${context}: ${failure.error}`);
  }
}

/** Per-pass drop tally — every message seen but not stored, by reason. */
interface MessageSkips {
  /**
   * Messages BLOCKED — retryable, the resume point does not advance past them.
   * The safety counter an operator alerts on.
   */
  blockedAudience: number;
  /**
   * Messages whose headers arrived complete and named NOBODY — permanent, so the
   * resume point advances. Counted apart from `blockedAudience` deliberately:
   * folding it in inflates the one number that is supposed to mean "this mail is
   * coming back", and the block-vs-skip distinction is the whole organising idea
   * of this file.
   */
  unattributable: number;
  /** Messages with no usable RFC 5322 Message-ID. */
  unidentifiable: number;
  /** Messages whose participant set exceeded the cap. */
  oversizeAudience: number;
  /** Bodies skipped as oversize. */
  oversizeBody: number;
  /** Messages whose body was PRESENT but not plain text, so it was refused. */
  bodyUnreadable: number;
  /** Messages that composed to nothing at all — no headers and no body. */
  emptyBody: number;
}

export interface OutlookMailClientOptions {
  readonly workspaceId: string;
  /** Resolves the app-only bearer token. Called once per pass. */
  readonly resolveToken: () => Promise<string>;
  /** The configured mailboxes — GUIDs or userPrincipalNames. Never empty. */
  readonly mailboxes: readonly string[];
  /** How far back a never-synced mailbox backfills. */
  readonly backfillWindowMs: number;
  /** Test-only injection. */
  readonly api?: {
    readonly fetchMailbox: typeof fetchMailbox;
    readonly fetchMailboxMessagesPage: typeof fetchMailboxMessagesPage;
    readonly fetchMailboxMessagesNextPage: typeof fetchMailboxMessagesNextPage;
  };
  /** Test-only injection for the audience half. */
  readonly audienceDeps?: OutlookAudienceDeps;
  /** Test-only clock. */
  readonly now?: () => Date;
}

/**
 * Compose the stored episode body: an RFC-shaped header block, then the text.
 *
 * The headers are part of the EVIDENCE, not decoration. "Who said this, to whom,
 * when" is the question every extracted fact from a mail depends on, and leaving
 * it to the extractor to infer from a bare body is how a quoted sentence becomes
 * attributed to the wrong person.
 *
 * `Bcc` is absent here for the same reason it is absent from the grant — see
 * `grant.ts` — and the two must stay in step: writing a BCC line into the body
 * would disclose, to everyone in the audience, the one fact BCC exists to hide,
 * while the grant continued not to include that person.
 *
 * The To/Cc addresses this writes ARE visible to the episode's audience, which
 * is exactly the set of people who already received the message and saw the same
 * header block in their own mail client. So no address reaches any ACL-PATH
 * reader who did not already have it — scoped deliberately, because operator and
 * export paths are outside that claim: an episode body travels verbatim in a
 * region-migration bundle, exactly as `grant.ts` says of `visible_to`.
 */
export function composeEmailBody(message: OutlookMessage): string {
  const lines: string[] = [];
  if (message.subject !== null) lines.push(`Subject: ${message.subject}`);
  if (message.from !== null) lines.push(`From: ${formatAddress(message.from)}`);
  if (message.toRecipients.length > 0) {
    lines.push(`To: ${message.toRecipients.map(formatAddress).join(", ")}`);
  }
  if (message.ccRecipients.length > 0) {
    lines.push(`Cc: ${message.ccRecipients.map(formatAddress).join(", ")}`);
  }
  if (message.receivedDateTime !== null) lines.push(`Date: ${message.receivedDateTime}`);
  const header = lines.join("\n");
  const body = message.bodyText ?? "";
  return header === "" ? body.trim() : `${header}\n\n${body}`.trim();
}

function formatAddress(address: { readonly address: string | null; readonly name: string | null }): string {
  if (address.address === null) return address.name ?? "(unknown)";
  return address.name === null ? address.address : `${address.name} <${address.address}>`;
}

export function createOutlookMailClient(
  options: OutlookMailClientOptions,
): BrainSourceVendorClient {
  const api = options.api ?? {
    fetchMailbox,
    fetchMailboxMessagesPage,
    fetchMailboxMessagesNextPage,
  };
  const now = options.now ?? (() => new Date());
  const audienceDeps = options.audienceDeps ?? {};

  /**
   * One message → its episode, or nothing, plus WHY nothing.
   *
   * `blocked` is returned rather than left to the caller to infer from an absent
   * episode, because the empty cases mean opposite things and only some of them
   * may let the resume point advance — see the module header's block-vs-skip
   * split. Conflating them is how a blocked message gets skipped permanently:
   * the pass reports itself fully covered, the mark advances past the message,
   * and no later cycle ever looks at it again.
   *
   * The AUDIENCE is established and WRITTEN first, before an episode exists.
   * That ordering is the block arm, and `audience.ts` carries why the two
   * failure orders are not symmetric.
   */
  async function runMessage(
    mailboxId: string,
    message: OutlookMessage,
    skips: MessageSkips,
    warnings: string[],
  ): Promise<{ readonly episode: BrainEpisodeRecord | null; readonly blocked: boolean }> {
    const messageId = normalizeInternetMessageId(message.internetMessageId);
    if (messageId === null) {
      // PERMANENT: a message without a Message-ID header never grows one. A
      // fallback to Graph's own `message.id` is deliberately NOT taken — it is
      // per-mailbox, so it would re-introduce the one-episode-per-recipient
      // duplication for exactly the messages whose identity is already doubtful.
      skips.unidentifiable++;
      warnings.push(
        `A message in mailbox ${mailboxId} carries no RFC 5322 Message-ID and was skipped — it cannot be deduped against the copy in any other mailbox, so ingesting it would duplicate.`,
      );
      return { episode: null, blocked: false };
    }

    if (!message.headersComplete) {
      // PERMANENT, and it took two review rounds to classify correctly.
      //
      // Deriving from a partial header set does not merely under-grant — the set
      // is what `reconcileAudienceMembership` deletes against, so it would REVOKE
      // the people the missing field named. So nothing is ingested. The question
      // the block-vs-skip split asks is the OTHER one: does the walk wait?
      //
      // It must not. Graph does not transiently omit a `$select`ed field on a
      // 200 — an unattributable sender or an unreadable recipient entry is a
      // property of the STORED message, so this condition never clears. Routing
      // it to the retry arm froze the mailbox at the message before it: `since`
      // is inclusive, so every later cycle re-read the same message, blocked
      // again, and broke again, and every message received after it was never
      // ingested. That is #4965's size-guard outage wearing different clothes,
      // in the file whose header is about not doing exactly this.
      //
      // (A genuinely malformed OBJECT is a different path: `parseOutlookMessage`
      // returns null, the page reports it as `dropped`, and THAT truncates the
      // walk retryably.)
      skips.unattributable++;
      warnings.push(
        `Message ${messageId} was NOT ingested — Microsoft Graph did not return its full participant headers, so its audience could not be established. It is not retried; the headers of a stored message do not change.`,
      );
      log.warn(
        { workspaceId: options.workspaceId, mailboxId },
        "Outlook message refused — incomplete participant headers, so no access grant could be derived. Permanent: the walk advances past it",
      );
      return { episode: null, blocked: false };
    }

    const participants = messageParticipants(message);
    if (participants.length === 0) {
      // PERMANENT: headers came back complete and named nobody. A message with
      // no sender and no To/Cc has no audience to mint, and it will not acquire
      // one — the headers are immutable. So it is REFUSED, not blocked: nothing
      // is ingested and nothing is granted, but the walk does not wait for it.
      skips.unattributable++;
      warnings.push(
        `Message ${messageId} was NOT ingested — its headers name no sender and no recipients, so there is no audience to grant it to. It is not retried; the headers cannot change.`,
      );
      log.warn(
        { workspaceId: options.workspaceId, mailboxId },
        "Outlook message refused — headers complete but empty, so no access grant could be derived. Permanent: the walk advances past it",
      );
      return { episode: null, blocked: false };
    }
    if (participants.length > MAX_MESSAGE_PARTICIPANTS) {
      // PERMANENT: the recipient count of a stored message never changes.
      skips.oversizeAudience++;
      warnings.push(
        `Message ${messageId} is addressed to ${participants.length} people, over the ${MAX_MESSAGE_PARTICIPANTS}-participant limit — it was skipped. Raising the limit re-admits it on the next backfill.`,
      );
      return { episode: null, blocked: false };
    }

    // ── The BLOCK arm ─────────────────────────────────────────────────────
    const grant = deriveEmailRecipientGrant({
      source: OUTLOOK_MAIL_SOURCE,
      mailboxId,
      messageId,
      // Narrowed by the guard above rather than passed through from the message,
      // so the deriver cannot be handed a `false` this branch already rejected.
      headersComplete: true,
      // The SET, and the same one the reconcile below is handed. The audience id
      // embeds a digest of it, so passing a different collection here than to
      // `reconcileEmailAudience` would mint an audience under a name that does
      // not describe its own members.
      participants: participants.map((participant) => participant.address),
    });
    if (grant === null) {
      // ADR-0036 §T6: grant-derivation failure BLOCKS and LOGS. There is no
      // wider-grant fallback — `[org]` would publish somebody's mail to the
      // whole company. Retryable: the only ways to reach here past the guards
      // above are a malformed mailbox id or message id, which a re-read may fix.
      skips.blockedAudience++;
      warnings.push(
        `Message ${messageId} was NOT ingested — an access grant could not be built from its mailbox and message ids. Nothing from it is stored; it is retried next cycle.`,
      );
      log.warn(
        { workspaceId: options.workspaceId, mailboxId },
        "Outlook message blocked — no access grant could be derived, so nothing was ingested from it",
      );
      return { episode: null, blocked: true };
    }

    // Membership BEFORE the episode — see `audience.ts` for why the two failure
    // orders are not symmetric. A throw here is caught by the caller and blocks
    // the message, which is correct: an audience we could not write is an
    // audience nobody is in.
    const audienceId = grant[0].slice(AUDIENCE_PREFIX.length);
    const reconciled = await reconcileEmailAudience(
      { workspaceId: options.workspaceId, audienceId, participants },
      audienceDeps,
    );
    if (reconciled.unresolved > 0) {
      log.info(
        {
          workspaceId: options.workspaceId,
          mailboxId,
          // The audience id, so this line can be joined to `resolvePrincipals`'s
          // unresolved SAMPLE — which carries positional labels (`cc:3`) and, by
          // design, no addresses. Without an id on one side of that join the
          // labels name nothing an operator can open.
          //
          // REDACTED, like every other audience-id log site in this connector.
          // This one is the routine path — it fires for essentially every mail
          // with an external recipient — so shipping the raw id here would leak
          // the participants digest far more often than the abort branches
          // `audience.ts` guards, and would make that module's "goes out of its
          // way to keep addresses out of the sink" claim false in practice.
          audienceId: redactAudienceDigest(audienceId),
          unresolved: reconciled.unresolved,
          granted: reconciled.added,
        },
        "Outlook message audience reconciled — some participants matched no Atlas user and were not granted",
      );
    }

    if (message.bodyUnreadable) {
      // ⚠️ The message HAD a body and Atlas refused it (Graph answered HTML
      // despite the `Prefer` ask). Storing the header block alone would be
      // FABRICATED COMPLETENESS: the episode reads as a whole message to every
      // downstream consumer while the thing somebody actually wrote is missing,
      // and the extractor would draw confident facts from a mail it never saw
      // the contents of. Exactly the failure the oversize skip-don't-truncate
      // rule prevents, arriving by a different door — and this connector really
      // did store headers-only until a test caught it.
      //
      // A SKIP rather than a block: `contentType` is a property of the stored
      // message, so retrying reads the same answer forever.
      skips.bodyUnreadable++;
      warnings.push(
        `Message ${messageId} was skipped — Microsoft Graph returned its body as HTML rather than the plain text Atlas asked for, and storing the headers alone would look like a complete message.`,
      );
      return { episode: null, blocked: false };
    }

    const body = composeEmailBody(message);
    if (body === "") {
      // Nothing at all — no subject, no participants worth printing, no body.
      // `chk_brain_episodes_body_xor_locator` refuses `''` outright, so there is
      // nothing to store. Distinct from the branch above: a message that
      // genuinely has no body but DOES have headers is complete evidence (a
      // subject-only "approved — EOM" is a real mail) and is stored as its
      // header block. PERMANENT either way.
      skips.emptyBody++;
      return { episode: null, blocked: false };
    }
    if (Buffer.byteLength(body, "utf8") > MAX_EMAIL_BODY_BYTES) {
      // `Buffer.byteLength`, not `String.length`: the latter counts UTF-16 code
      // units, so a non-Latin message would pass at up to ~3× the stated bound.
      // PERMANENT, so a SKIP and not a block — routing a permanent size
      // condition through the retry arm is precisely how #4965's size guard
      // became an outage.
      skips.oversizeBody++;
      warnings.push(
        `Message ${messageId} has a body over the ${MAX_EMAIL_BODY_BYTES / 1_048_576}MB limit — it was skipped rather than truncated, so no partial message is stored as if it were whole.`,
      );
      return { episode: null, blocked: false };
    }

    return {
      episode: {
        sourceId: outlookEpisodeSourceId(messageId),
        // The SENDER's address. Recipients stay in the body for the extraction
        // stage to attribute; `sourceActor` is the source-side principal who
        // authored the evidence, which is the one identity a mail header states
        // unambiguously.
        sourceActor: message.from?.address ?? null,
        body,
        occurredAt: message.receivedDateTime === null ? null : parseDate(message.receivedDateTime),
        visibleTo: grant,
      },
      blocked: false,
    };
  }

  return {
    async fetchEpisodes(params: BrainSourceFetchParams): Promise<BrainSourceChanges> {
      const token = await options.resolveToken();
      const passStart = now();
      const passStartIso = passStart.toISOString();
      const floorIso = new Date(passStart.getTime() - options.backfillWindowMs).toISOString();
      const storedMarks = parseOutlookCursor(params.cursor);

      const episodes: BrainEpisodeRecord[] = [];
      const warnings: string[] = [];
      const skips: MessageSkips = {
        blockedAudience: 0,
        unattributable: 0,
        unidentifiable: 0,
        oversizeAudience: 0,
        oversizeBody: 0,
        bodyUnreadable: 0,
        emptyBody: 0,
      };
      // TWO flags, not one — the distinction #4965's round-2 review found by
      // execution and which this connector inherits deliberately.
      //
      //   `walkIncomplete`   — work INSIDE a walked range was left undone.
      //                        Reported to the engine.
      //   `historyTruncated` — history OLDER than the backfill floor is
      //                        unreachable. A statement about the past, and
      //                        REPORT-ONLY: the floor IS the new start, so there
      //                        is nothing for a frozen cursor to retry.
      //
      // In #4965 gating the CURSOR on the union of the two wedged the connector
      // permanently: the floor advances with the clock, so the mark written by
      // pass N is always older than the floor computed by pass N+1, the stale
      // branch re-fired forever, and every pass re-walked the whole backfill.
      //
      // Be precise about why that cannot recur HERE, because it is a property of
      // the structure rather than of these two flags: the resume point is
      // per-mailbox and is decided by `mailboxIncomplete`, which is scoped to
      // one mailbox's walk and is not reachable from either flag above. So
      // neither of them CAN freeze a cursor — a mutation setting `walkIncomplete`
      // on the stale-mark branch changes nothing but the reported coverage,
      // which is verified. Both still surface as `coverageIncomplete` to the
      // engine, which is the half that was right in #4965 too.
      let walkIncomplete = false;
      let historyTruncated = false;
      let remainingEpisodes = params.maxEpisodes;
      /** The marks to persist. Seeded empty; see the carry-forward after the loop. */
      const nextMarks: Record<string, string> = {};
      /**
       * Every mailbox whose OBJECT ID this pass resolved, configured-spelling →
       * id. The carry-forward below needs it because the cursor is keyed on the
       * object id while the config holds UPNs: a mailbox the pass never resolved
       * has no known key, so "did this pass reach it?" cannot be asked of
       * `nextMarks` alone.
       */
      const resolvedIds = new Map<string, string>();
      /** Newest source-side event time actually ingested, for the high-water mark. */
      let newestIngested: string | null = null;

      mailboxes: for (const configured of options.mailboxes) {
        // Resolve to the object id FIRST. Everything downstream — the cursor
        // key, the audience token — is keyed on it, so a mailbox whose identity
        // cannot be resolved contributes nothing rather than contributing
        // episodes under a key that will not match next pass.
        const resolved = await api.fetchMailbox(token, configured);
        if (resolved.ok) resolvedIds.set(configured, resolved.mailbox.id);
        if (!resolved.ok) {
          const error = toOutlookClientError(`the mailbox ${configured}`, resolved);
          if (error instanceof ConnectorRateLimitError && episodes.length === 0) throw error;
          walkIncomplete = true;
          warnings.push(`Mailbox ${configured} was not read: ${error.message}`);
          log.warn(
            { workspaceId: options.workspaceId, mailbox: configured, error: resolved.error },
            "Outlook mailbox could not be resolved — skipping it this pass",
          );
          if (error instanceof ConnectorRateLimitError) break mailboxes;
          continue;
        }
        const mailboxId = resolved.mailbox.id;

        const storedMark = storedMarks[mailboxId];
        let since = storedMark ?? floorIso;
        if (storedMark !== undefined && storedMark < floorIso) {
          // Report-only. NOT `walkIncomplete`: the walk starts at the floor and
          // covers everything from there, so freezing the resume point would
          // re-walk that same range next pass and every pass after it.
          historyTruncated = true;
          since = floorIso;
          warnings.push(
            `Mailbox ${configured}'s stored sync mark (${storedMark}) was older than the ${Math.round(options.backfillWindowMs / 86_400_000)}-day backfill window, so it restarts at ${floorIso}. Anything older is not ingested.`,
          );
        }
        // Carried forward by default: a mailbox whose walk does nothing must not
        // LOSE its mark, or the next pass re-walks its whole backfill.
        nextMarks[mailboxId] = since;

        /** The last message processed contiguously — this mailbox's resume point. */
        let coveredThrough: string | null = null;
        let mailboxIncomplete = false;
        let nextLink: string | null = null;
        let remainingPages = MAX_MESSAGE_PAGES_PER_MAILBOX;

        pages: for (;;) {
          if (remainingPages <= 0 || remainingEpisodes <= 0) {
            mailboxIncomplete = true;
            warnings.push(
              remainingEpisodes <= 0
                ? `The per-sync record budget (${params.maxEpisodes}) was reached in mailbox ${configured} — the rest of the backlog continues next cycle.`
                : `The per-pass page budget (${MAX_MESSAGE_PAGES_PER_MAILBOX}) was spent on mailbox ${configured} — the rest of the backlog continues next cycle.`,
            );
            break pages;
          }
          // Annotated, not inferred: `nextLink` is assigned from `page.nextLink`
          // at the bottom of this loop, so leaving it to inference makes the
          // initializer self-referential (TS7022) and quietly lands `any`.
          const page: OutlookMessagesPage | OutlookReadError =
            nextLink === null
              ? await api.fetchMailboxMessagesPage(token, {
                  mailboxId,
                  since,
                  pageSize: MESSAGES_PAGE_SIZE,
                })
              : await api.fetchMailboxMessagesNextPage(token, nextLink);
          if (!page.ok) {
            const error = toOutlookClientError(`messages in mailbox ${configured}`, page);
            // A rate limit is the one failure that also stops the PASS — Graph
            // is telling us to stop talking — but the pass still RETURNS rather
            // than throwing once anything has been banked, because throwing
            // would discard the episodes already earned and the same prefix
            // would be re-walked and re-lost every cycle. Only a pass with
            // nothing to bank rethrows, so the ENGINE's backoff owns the retry.
            const throttled = error instanceof ConnectorRateLimitError;
            if (throttled && episodes.length === 0) throw error;
            mailboxIncomplete = true;
            warnings.push(
              throttled
                ? `Mailbox ${configured} was not finished — Microsoft Graph is rate limiting this tenant. It resumes next cycle.`
                : `Mailbox ${configured} stopped early: ${error.message}`,
            );
            log.warn(
              { workspaceId: options.workspaceId, mailbox: configured, error: page.error, throttled },
              throttled
                ? "Microsoft Graph rate limit mid-pass — banking the messages already read and stopping"
                : "Outlook mailbox page read failed — banking what was read and continuing",
            );
            if (throttled) {
              // Persist what this mailbox covered before leaving, then stop the
              // whole pass. Falling straight out of the labelled loop would
              // discard a contiguous prefix this mailbox really did read.
              if (coveredThrough !== null) nextMarks[mailboxId] = coveredThrough;
              walkIncomplete = true;
              break mailboxes;
            }
            break pages;
          }
          remainingPages--;

          if (page.dropped > 0) {
            // Entries with no readable shape sit INSIDE the range this pass is
            // about to mark covered, so advancing past them would be a silent
            // skip. Truncating re-reads them next cycle — a visible stall, never
            // a silent loss.
            mailboxIncomplete = true;
            warnings.push(
              `Microsoft Graph returned ${page.dropped} unreadable message entr${page.dropped === 1 ? "y" : "ies"} in mailbox ${configured} — that range was not marked covered and is re-read next cycle.`,
            );
            break pages;
          }

          for (const message of page.messages) {
            if (remainingEpisodes <= 0) {
              // `break pages` and not a bare `break`. In #4965 the equivalent
              // bare break was a SILENT SKIP, because that connector set no flag
              // here — the loops ran out, the window was marked covered, and the
              // unread tail was gone with `coverageIncomplete: false`.
              //
              // Here the flag is set on the line below BEFORE breaking, so a
              // bare `break` would merely push a duplicate budget warning — the
              // top-of-page guard runs before the next fetch, so not even a
              // wasted round trip. Stated plainly because the difference matters
              // to whoever edits this next: the correctness lives in the flag,
              // and `break pages` is tidiness.
              mailboxIncomplete = true;
              warnings.push(
                `The per-sync record budget (${params.maxEpisodes}) was reached inside mailbox ${configured} — the unread messages in it resume next cycle.`,
              );
              break pages;
            }
            try {
              const produced = await runMessage(mailboxId, message, skips, warnings);
              if (produced.blocked) {
                // A blocked message leaves its range UNCOVERED. Without this the
                // pass reports itself fully covered, the resume point advances
                // past the message, and no later cycle ever looks at it again —
                // a permanent silent skip on the SAFETY arm, which is the worst
                // place to have one.
                mailboxIncomplete = true;
                break pages;
              }
              if (produced.episode !== null) {
                episodes.push(produced.episode);
                remainingEpisodes--;
                const at = message.receivedDateTime;
                if (at !== null && (newestIngested === null || at > newestIngested)) {
                  newestIngested = at;
                }
              }
              // Advanced for SKIPPED messages too, and that is the whole point
              // of the block-vs-skip split: a permanent skip must not hold the
              // resume point, or the walk stalls on it forever.
              if (message.receivedDateTime !== null) coveredThrough = message.receivedDateTime;
            } catch (err) {
              // Per-message isolation, matching the engine's per-collection
              // posture.
              const throttled = err instanceof ConnectorRateLimitError;
              if (throttled && episodes.length === 0) throw err;
              mailboxIncomplete = true;
              const messageText = err instanceof Error ? err.message : String(err);
              if (!throttled) {
                // The dominant throw on this path is a failed membership WRITE —
                // the most safety-relevant failure in the file, since an audience
                // that could not be written is an audience nobody is in. It is
                // counted as a BLOCK so the dedicated safety warning below fires,
                // and it is worded "NOT ingested … retried" rather than "skipped":
                // "skipped" is this module's word for the permanent arm, and this
                // one comes back.
                skips.blockedAudience++;
              }
              warnings.push(
                throttled
                  ? `Mailbox ${configured} stopped mid-page — Microsoft Graph is rate limiting this tenant. It resumes next cycle.`
                  : `A message in mailbox ${configured} was NOT ingested — ${messageText}. Nothing from it is stored; it is retried next cycle.`,
              );
              log.warn(
                { workspaceId: options.workspaceId, mailbox: configured, err: messageText, throttled },
                throttled
                  ? "Microsoft Graph rate limit mid-message — banking what was read and stopping"
                  : "Outlook message pass failed — that range is re-read next cycle",
              );
              if (coveredThrough !== null) nextMarks[mailboxId] = coveredThrough;
              walkIncomplete = true;
              if (throttled) break mailboxes;
              break pages;
            }
          }

          if (page.nextLink === null) break pages;
          nextLink = page.nextLink;
        }

        if (mailboxIncomplete) {
          walkIncomplete = true;
          // ⚠️ STALL DETECTOR. The block arm is retryable BY DESIGN, which means
          // a block that never clears re-reads the same message every cycle and
          // silently stops the mailbox dead — every later message never
          // ingested, while the pass reports the same `blockedAudience > 0` a
          // single transient failure would. Nothing distinguishes "blocked once"
          // from "blocked on the same message for 400 consecutive cycles", and
          // that is the shape an operator has no way to see.
          //
          // Every PERMANENT condition is now a skip, so a stall here means a
          // genuinely retryable block is not clearing — a membership write that
          // fails deterministically for one message, say. Loud, distinct, and
          // naming the instant it is stuck at, because the repair is not the
          // same as for a one-off block.
          if (
            skips.blockedAudience > 0 &&
            (coveredThrough === null || coveredThrough === storedMark)
          ) {
            log.error(
              { workspaceId: options.workspaceId, mailbox: configured, stalledAt: since },
              "Outlook mailbox made NO forward progress and blocked at least one message — it is stuck at this instant and every later message in it is not being ingested. A block is retried by design, so a repeat of this line across cycles is a block that is not clearing, not a transient failure",
            );
            warnings.push(
              `Mailbox ${configured} made no forward progress this cycle and is stuck at ${since}. Messages after that point are not being ingested.`,
            );
          }
          // Resume at the last message processed contiguously. Inclusive, so it
          // is re-read and deduped rather than skipped — bulk mail shares
          // timestamps to the second, and an exclusive resume would drop every
          // message sharing the boundary instant.
          if (coveredThrough !== null) nextMarks[mailboxId] = coveredThrough;
        } else {
          // The mailbox was walked to the end. The resume point is the instant
          // the PASS STARTED, not `now()` and not the newest message seen:
          // `$filter` used `>= since` and the pass read everything Graph had at
          // that moment, so anything delivered DURING the walk is not
          // guaranteed to have been seen. Using pass-start re-reads that sliver
          // next cycle (deduped) instead of jumping over it.
          nextMarks[mailboxId] = passStartIso;
        }
      }

      // ── Carry forward every mailbox this pass did not WALK ────────────────
      //
      // Structural, and done ONCE here rather than per-branch, because per-branch
      // is exactly how the Slack connector lost every channel after a throttled
      // one (`slack/client.ts` carries the same block and the same post-mortem).
      // `serialiseOutlookCursor` writes a whole-cursor REPLACEMENT and
      // `connector-sync.ts` only COALESCEs a NULL cursor forward, so a mailbox
      // missing from `nextMarks` is a mailbox whose mark is DELETED — it restarts
      // at the backfill floor, and because the floor slides with the clock, any
      // history older than it is never re-fetched. Worse, the "stored mark was
      // older than the backfill window" warning cannot fire for it, because by
      // then there is no stored mark to compare against.
      //
      // Three paths reach here without having walked a mailbox: an unresolvable
      // identity read (`continue`), a rate limit (`break mailboxes`), and a
      // per-message throttle. None of them is evidence that the mailbox left the
      // config, which is the only thing pruning is for.
      //
      // PRUNING therefore requires PROOF. The cursor is keyed on the Graph object
      // id while the config holds UPNs, so "is this stored key still configured?"
      // is only answerable for mailboxes this pass resolved. When every
      // configured mailbox resolved, `resolvedIds.values()` IS the configured set
      // and a stored key outside it really was removed. When any mailbox did not
      // resolve, nothing is pruned — carrying a dead map entry costs one key,
      // dropping a live one costs history nothing will ever re-fetch.
      const everyMailboxResolved = resolvedIds.size === options.mailboxes.length;
      const configuredIds = new Set(resolvedIds.values());
      for (const [mailboxId, mark] of Object.entries(storedMarks)) {
        if (nextMarks[mailboxId] !== undefined) continue;
        if (everyMailboxResolved && !configuredIds.has(mailboxId)) continue;
        nextMarks[mailboxId] = mark;
      }

      if (skips.blockedAudience > 0) {
        // Surfaced at WARN and separately from the other skips: every other
        // entry in this tally is a quality loss, this one is a SAFETY refusal,
        // and an operator seeing mail vanish needs to know which.
        log.warn(
          { workspaceId: options.workspaceId, blocked: skips.blockedAudience },
          "Outlook pass blocked messages whose audience could not be established — nothing was ingested from them, and nothing was granted more widely",
        );
      }
      if (
        skips.unidentifiable +
          skips.unattributable +
          skips.oversizeAudience +
          skips.oversizeBody +
          skips.bodyUnreadable +
          skips.emptyBody >
        0
      ) {
        log.info(
          { workspaceId: options.workspaceId, kept: episodes.length, ...skips },
          "Outlook mail pass complete — messages read but not stored, by reason",
        );
      }

      return {
        episodes,
        // Honest by the same rule `slack/client.ts` and `zoom/client.ts` follow:
        // `null` whenever coverage was incomplete, because a high-water mark must
        // cover only the CONTIGUOUS part of the window. The state upsert
        // COALESCEs the previous mark forward, so null loses nothing.
        highWaterMark: walkIncomplete || historyTruncated ? null : newestIngested,
        cursor: serialiseOutlookCursor(nextMarks),
        coverageIncomplete: walkIncomplete || historyTruncated,
        warnings,
      };
    },
  };
}

/** A Graph `receivedDateTime` → `Date`, or null when it does not parse. */
function parseDate(raw: string): Date | null {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}
