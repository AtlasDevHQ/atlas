/**
 * Outlook / Microsoft Graph mail brain source: identity + stored-config
 * contract (#4966, ADR-0036 §Ingestion & connectors).
 *
 * A leaf module: the catalog id / slug / source constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), the audience re-verifier,
 * and the catalog seed share ONE definition. It imports nothing from the ingest
 * core — the whole point of #4963's seam is that adding a vendor is additive.
 *
 * ## Vendor: MAINTAINER-CONFIRMED, not inferred
 *
 * #4966's own text recommends Gmail and says the vendor is undecided. It was
 * decided against that recommendation: Microsoft Graph, because Atlas already
 * ships a Teams adapter and the Microsoft OAuth surface is partly familiar
 * (`lib/integrations/install/teams-static-bot-handler.ts`,
 * `lib/integrations/operator-credentials/platforms.ts`). #4972 set the
 * precedent that a connector states which of the two it was.
 *
 * ## Credentials: client-credentials (app-only), tenant-scoped
 *
 * The same shape as Zoom's Server-to-Server OAuth and chosen for the same three
 * reasons — the grain matches (a company brain wants the TENANT's mail, not one
 * admin's delegated view), there is no redirect surface, and it works
 * self-hosted where there is no Atlas-registered Microsoft app to 3-leg
 * through. The `tenantId` is NOT a secret and lives in
 * `workspace_plugins.config`; the client id and client secret go to
 * `knowledge_sync_credentials` (encrypted via `db/secret-encryption.ts`) as one
 * JSON blob, exactly as `zoom/connector.ts` argues for its pair.
 *
 * ⚠️ THE SCOPE HAZARD, which has no Zoom analogue. Graph's application
 * permission `Mail.Read` grants read access to **every mailbox in the tenant**.
 * There is no narrower app-only mail scope. Microsoft's own mitigation is an
 * ApplicationAccessPolicy bound to a mail-enabled security group, applied by the
 * tenant admin OUTSIDE Atlas — so Atlas cannot verify the app is narrowed and
 * must not assume it is.
 *
 * That is why {@link OutlookMailInstallConfig.mailboxes} is REQUIRED and must be
 * non-empty, and it is the one place this connector deliberately diverges from
 * its Zoom sibling, where an empty `hosts` list means the whole account. The
 * divergence is not stylistic: "every recorded meeting in the company" and
 * "every mailbox in the company" are different orders of hazard, and an empty
 * field is exactly what a half-finished install form submits. An admin who
 * genuinely wants tenant-wide ingest lists the mailboxes; there is no spelling
 * of this config that means "all of them" by omission.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  THE SOURCE-ID CONTRACT
 * ══════════════════════════════════════════════════════════════════════
 *
 *     source_id = <RFC 5322 Message-ID, angle brackets stripped>
 *                                        (see {@link outlookEpisodeSourceId})
 *
 * ### Granularity: ONE MESSAGE, never a thread
 *
 * Stated explicitly because a thread is the shape a reader expects an email
 * connector to ingest, and it is wrong here for two independent reasons:
 *
 *   - **An episode is immutable evidence.** A thread GROWS. A thread-grained
 *     episode would have to be rewritten as replies land, and `episodes.ts` has
 *     no upsert by construction (`ingest/types.ts`'s header: an edited Slack
 *     message is a NEW episode, not a mutation). A thread-grained id would
 *     therefore freeze the thread at whatever state the first poll saw and
 *     silently drop every later reply as a duplicate.
 *   - **The audience is per message, not per thread.** Someone added on reply
 *     #5 never received #1. A thread-grained grant would be the union of every
 *     message's recipients, which grants #5's late arrival access to facts
 *     extracted from #1 — an over-grant, and ADR-0036 §T6's asymmetry puts
 *     over-granting on the side that is a leak rather than a loss.
 *
 * Graph's `conversationId` is therefore read for NOTHING in this connector. It
 * is not in the source-id, not in the audience id, and not stored. A future
 * thread-level view would derive it at read time from the messages, which is the
 * direction that cannot corrupt a stored key.
 *
 * ### Why the Message-ID and not Graph's own `message.id`
 *
 * This is the email-specific trap, and it is the exact analogue of Zoom's
 * `uuid`-vs-`id` trap one directory over — with the polarity reversed, which is
 * what makes it easy to get backwards.
 *
 *   - `message.id` is Graph's identifier and it is **per-mailbox**. The same
 *     message sitting in Alice's Sent Items and in Bob's Inbox has two entirely
 *     different `id` values. It is also **not stable**: moving a message between
 *     folders re-mints it, so archiving an email would re-ingest it.
 *   - `internetMessageId` is the RFC 5322 `Message-ID` header, minted once by
 *     the sending mail system and **identical in every copy of the message, in
 *     every mailbox, in every tenant**. It survives folder moves, and it is what
 *     every mail system on earth already uses for exactly this purpose.
 *
 * The dedupe tuple is `(workspace_id, source, source_id)` and has NO mailbox
 * column. So keying on `message.id` would ingest one 5-recipient email as five
 * separate episodes with byte-identical bodies — and then the extraction stage
 * would derive the same fact five times, each citing its own "independent"
 * evidence. Keying on the Message-ID makes the cross-mailbox collapse automatic:
 * whichever mailbox is walked first writes the episode, the rest no-op in the
 * `ON CONFLICT DO NOTHING`.
 *
 * ⚠️ The consequence a maintainer must hold onto: **which mailbox wins is not
 * determined.** It depends on the configured order and on which pass had budget.
 *
 * That is safe because every copy resolves to the IDENTICAL SET OF PEOPLE — see
 * `ingest/grant.ts`'s {@link deriveEmailRecipientGrant}, where ignoring BCC is
 * what buys that. Note the precise claim: the grant TOKEN is *not* identical
 * across copies, because it embeds the mailbox on purpose (the re-verifier has
 * to know where to re-read from). Only the membership it resolves to is.
 *
 * That distinction has a real cost, so do not read the winning mailbox as
 * inconsequential: it is baked into the stored row, so if THAT mailbox later
 * loses `Mail.Read`, the episode's audience fails re-verification forever and
 * goes invisible at the staleness bound — while every other recipient's mailbox
 * still holds the message. If anything ever makes the granted PEOPLE depend on
 * which copy was read, this dedupe turns into a non-deterministic ACL and the
 * two decisions have to be revisited together.
 *
 * ### The absent-header case
 *
 * A message with no usable `internetMessageId` is SKIPPED, counted, and the
 * walk still marks its window covered. It is not blocked-and-retried, because a
 * header a message does not have is a PERMANENT condition and retrying it
 * forever freezes the cursor — the failure the Zoom connector shipped and its
 * round-2 review caught (see `zoom/client.ts`'s `too_large` comment). There is
 * deliberately NO fallback to `message.id`: a fallback would restore the
 * five-copies duplication for exactly the messages whose identity is already
 * doubtful.
 *
 * The one thing that must never change is the FORMAT. It is a stored key; a
 * reformat re-ingests every message in every workspace as a new episode, and
 * the extraction fiber (`lib/brain/extract.ts`) would re-extract facts from all
 * of them.
 */

import { OUTLOOK_SOURCE } from "@atlas/api/lib/brain/sources";

/** The built-in catalog slug + row id for the Outlook mail brain source. */
export const OUTLOOK_MAIL_SLUG = "outlook-mail";
export const OUTLOOK_MAIL_CATALOG_ID = "catalog:outlook-mail";

/**
 * The value stamped into `brain_episodes.source`. ADR-0036 sequences SOURCES
 * class-major, vendor-minor; within the email class the stored value is the
 * VENDOR.
 *
 * Note this is NOT for the usual reason. Chat and transcript are vendor-grained
 * because two vendors' source-ids would collide in one dedupe namespace; email's
 * ids are RFC 5322 Message-IDs and would NOT collide — a Gmail connector reading
 * the same message would mint the same id. The grain is still vendor here
 * because the stored value does more than dedupe: it is the audience
 * re-verifier's scan key (`brain_episodes.source = $2` in
 * `audience/reverify.ts`'s `REVERIFY_CANDIDATES_SQL`) and the routing key for every
 * class-keyed discriminator. Two vendors sharing it would put one vendor's
 * re-verifier in front of the other's audiences holding the wrong credential.
 *
 * Aliased off `lib/brain/sources.ts` rather than spelled again here: the column
 * is read as a discriminator (`isWarehouseDerived`), so its vocabulary is one
 * shared fact and not a literal each producer repeats.
 */
export const OUTLOOK_MAIL_SOURCE = OUTLOOK_SOURCE;

/**
 * Defensive bound on the configured mailbox set (one install, one scope).
 *
 * Mirrors `ZOOM_MAX_HOSTS` and exists for the same reason — an install form is a
 * place a paste accident lands — but it does MORE work here, because there is no
 * "leave blank for everything" escape valve to fall back to. A tenant needing
 * more than this many mailboxes on one brain source is a conversation, not a
 * config field.
 */
export const OUTLOOK_MAX_MAILBOXES = 50;

/**
 * Longest `Message-ID` this connector will store, in characters.
 *
 * RFC 5322 bounds a header line at 998 octets, so anything past it is malformed
 * or hostile rather than merely long. The bound matters because the value is
 * interpolated into a stored key AND into an `audience:` grant token, and both
 * are read back by `LIKE` scans.
 */
export const MAX_INTERNET_MESSAGE_ID_LENGTH = 998;

/**
 * Normalise a raw `internetMessageId` into the stored form, or `null` when it
 * carries no usable identity.
 *
 * Graph returns the header verbatim, which per RFC 5322 means it is wrapped in
 * angle brackets: `<AAMkAG...@example.com>`. Exactly one enclosing pair is
 * stripped, and the result must contain no further `<` or `>` — two bracketed
 * ids in one field is a malformed header, not a value to guess at.
 *
 * ⚠️ Deliberately NOT lowercased. RFC 5322's `id-left` is case-SENSITIVE, so
 * two ids differing only in case are genuinely two messages; lowercasing would
 * collapse them and silently drop one as a duplicate. (The domain half is
 * case-insensitive in principle, but no mail system varies it between copies of
 * one message — and normalising only half of a value is worse than normalising
 * none of it.)
 *
 * Whitespace anywhere is a refusal rather than something to trim out of the
 * middle: a Message-ID contains none, so its presence means the header was
 * folded, concatenated, or is not a Message-ID at all.
 */
export function normalizeInternetMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">") && value.length >= 2) {
    value = value.slice(1, -1).trim();
  }
  if (value === "") return null;
  if (value.length > MAX_INTERNET_MESSAGE_ID_LENGTH) return null;
  // No residual brackets, no whitespace, no control bytes. Each would otherwise
  // reach a stored key AND an `audience:` grant token, and both are read back by
  // `LIKE` scans that a stray byte silently defeats.
  //
  // The control-byte check is a CODEPOINT SCAN rather than a regex, for two
  // reasons that point the same way. `oxlint`'s `no-control-regex` rejects the
  // character class even spelled with `\u` escapes, so a regex here needs a
  // suppression comment to exist at all; and a regex written with LITERAL
  // control characters — the form that lints clean — is invisible in review and
  // a formatter is free to eat it, leaving a guard that looks present and does
  // nothing. (That is not hypothetical: this file was written that way first and
  // it was caught only because `grep` stopped matching it.) `\s` does not cover
  // these — it stops at the usual five.
  if (/[<>]/.test(value)) return null;
  if (/\s/.test(value)) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/**
 * Build the episode `source_id`. THE contract — see the module header.
 *
 * Throws rather than returning a sentinel WHEN THE CALLER HAS ALREADY DECIDED
 * the message is identifiable: every caller is a WRITER and the value is half of
 * the `(workspace_id, source, source_id)` dedupe tuple, so a malformed id would
 * not fail — it would land a row no other writer ever dedupes against.
 *
 * Callers that are still DECIDING should ask {@link normalizeInternetMessageId}
 * and skip on `null`; the throw here is the backstop, not the gate. That split
 * is why a message with no Message-ID is a counted skip rather than an
 * exception-driven abort.
 */
export function outlookEpisodeSourceId(internetMessageId: string): string {
  const normalized = normalizeInternetMessageId(internetMessageId);
  if (normalized === null) {
    throw new Error(
      `Outlook message id "${internetMessageId.slice(0, 80)}" is not a usable RFC 5322 Message-ID — refusing to build a source_id from it. Never fall back to Graph's own message.id: it is per-mailbox and per-folder, so it would ingest one message once per recipient.`,
    );
  }
  return normalized;
}

/** The non-secret config persisted on the install's `workspace_plugins` row. */
export interface OutlookMailInstallConfig {
  /** The Entra (Azure AD) tenant id the app is registered in. Not a secret. */
  readonly tenantId: string;
  /**
   * Mailboxes to ingest, as Graph user ids or userPrincipalNames.
   *
   * REQUIRED and non-empty — see the header's scope hazard. This is the inverse
   * of `ZoomTranscriptsInstallConfig.hosts`, where empty means the whole
   * account, and the two sit two directories apart; the asymmetry is the point,
   * not an oversight.
   */
  readonly mailboxes: readonly string[];
  readonly description?: string;
}

export type ParsedOutlookMailConfig =
  | { readonly ok: true; readonly tenantId: string; readonly mailboxes: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * or invalid field means someone edited the row out of band; re-installing
 * repairs it.
 */
export function parseOutlookMailConfig(
  config: Record<string, unknown> | null,
): ParsedOutlookMailConfig {
  const rawTenantId = config?.tenantId;
  if (typeof rawTenantId !== "string" || rawTenantId.trim() === "") {
    return {
      ok: false,
      error:
        "This Outlook mail source has no Microsoft tenant id configured — re-install it and enter the Directory (tenant) ID from your Entra app registration.",
    };
  }
  const tenantId = rawTenantId.trim();

  const rawMailboxes = config?.mailboxes;
  if (!Array.isArray(rawMailboxes)) {
    // An ABSENT mailbox list is an ERROR here, where the Zoom sibling's absent
    // host list is a documented "the whole account". Widening to every mailbox
    // in the tenant on a missing field is the one failure this source must not
    // have — `Mail.Read` is tenant-wide and Atlas cannot see whether the admin
    // narrowed the app with an ApplicationAccessPolicy.
    return {
      ok: false,
      error:
        "This Outlook mail source has no mailboxes configured — re-install it and list the mailboxes to ingest. There is deliberately no setting that means every mailbox in the tenant.",
    };
  }
  const mailboxes: string[] = [];
  for (const entry of rawMailboxes) {
    // A non-string entry is REFUSED, not skipped, exactly as the Slack and Zoom
    // configs refuse one: silently narrowing the configured scope produces a
    // source that reports success while never reading a mailbox the admin
    // believes is connected.
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        error:
          "This Outlook mail source has a malformed mailbox list configured — re-install it and pick the mailboxes again.",
      };
    }
    const trimmed = entry.trim();
    // Case-insensitively deduped: a userPrincipalName is an address and mail
    // systems treat it case-insensitively, so listing `Ann@x.com` and
    // `ann@x.com` is one mailbox walked twice — doubling the vendor spend and
    // the audience writes for no additional coverage. The FIRST spelling is
    // kept, because it is what Graph was given and what its errors will name.
    if (!mailboxes.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      mailboxes.push(trimmed);
    }
  }
  if (mailboxes.length === 0) {
    return {
      ok: false,
      error:
        "This Outlook mail source has an empty mailbox list — re-install it and list at least one mailbox to ingest.",
    };
  }
  if (mailboxes.length > OUTLOOK_MAX_MAILBOXES) {
    return {
      ok: false,
      error: `This Outlook mail source has ${mailboxes.length} mailboxes configured, over the ${OUTLOOK_MAX_MAILBOXES}-mailbox limit — re-install it with a narrower scope.`,
    };
  }
  return { ok: true, tenantId, mailboxes };
}
