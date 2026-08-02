/**
 * Zoom cloud-recording transcript brain source: identity + stored-config
 * contract (#4965, ADR-0036 §Ingestion & connectors).
 *
 * A leaf module: the catalog id / slug / source constants and the non-secret
 * install config shape live here so the install handler (writes the config),
 * the connector (reads it back in `createClient`), the audience re-verifier,
 * and the catalog seed share ONE definition. It imports nothing from the ingest
 * core — the whole point of #4963's seam is that adding a vendor is additive.
 *
 * ## Credentials: Server-to-Server OAuth, account-scoped
 *
 * Unlike `slack-history` — which reuses the workspace's existing Slack OAuth
 * install and stores no credential of its own (ADR-0030 amendment #4397) —
 * Zoom is a NEW credential surface. It uses Zoom's **Server-to-Server OAuth**
 * app type rather than the 3-legged user flow, for three reasons:
 *
 *   - the grain matches. A company brain wants the ACCOUNT's recorded
 *     meetings, and an S2S app is account-scoped by construction. A 3-legged
 *     install would bind to whichever admin happened to click Authorize, and
 *     silently lose scope the day they left;
 *   - no redirect surface. There is no callback route, no `oauth_state` token,
 *     and nothing new in the public API's attack surface;
 *   - it works self-hosted. BYOT deploys have no Atlas-registered Zoom app to
 *     3-leg through, and per `project_integrations_dual_model` an integration
 *     that only works in SaaS is half an integration.
 *
 * The `accountId` is NOT a secret and lives in `workspace_plugins.config`
 * alongside the scope fields. The client id and client secret go to
 * `knowledge_sync_credentials` (encrypted via `db/secret-encryption.ts`),
 * never to the config — the same split every credential-bearing form handler
 * in `lib/integrations/install/` makes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  THE SOURCE-ID CONTRACT
 * ══════════════════════════════════════════════════════════════════════
 *
 *     source_id = `<meetingUuid>:<recordingFileId>`   (see {@link zoomEpisodeSourceId})
 *
 * ADR-0036 §Ingestion makes a stable source-id a per-connector OBLIGATION, not
 * a nicety: freshness is "poll + reconcile universally, PLUS a webhook
 * fast-path" (M3), and the fast-path is *an alternate writer into the same
 * idempotent episode store*. Two writers that disagree about the id duplicate
 * every recording they race on — and because episodes are append-only there is
 * no upsert to converge them afterwards.
 *
 * **This is a published contract, not a private naming choice** — the grammar
 * is stamped into an append-only `brain_episodes.source_id`, so any second
 * writer that spells it differently mints episodes nothing converges.
 *
 * ⚠️ There is no second writer today. This said "#4967 is being built against
 * this section in parallel… two in-flight branches", which was true while
 * #4967 was in flight and wrong once it shipped SLACK-only. The guidance below
 * still stands for whoever writes a Zoom webhook later; the counterparty does
 * not exist yet.
 *
 * Why THIS id satisfies the contract:
 *
 *   - Zoom's meeting `uuid` identifies a meeting INSTANCE, not a meeting
 *     series. A recurring standup has one `uuid` per occurrence and one
 *     `id` (the 11-digit meeting number) for all of them, so keying on `id`
 *     would collapse every occurrence into one episode and drop all but the
 *     first. The `uuid` is the only correct half.
 *   - `recordingFileId` is Zoom's own GUID for one file within that instance,
 *     and a single instance genuinely can hold SEVERAL transcripts: stopping
 *     and restarting the recording mid-meeting produces one recording file set
 *     per segment, each with its own transcript. Keying on the uuid alone
 *     would silently drop every segment after the first as a duplicate.
 *   - It is stable across re-fetches. Zoom does not re-mint a recording file's
 *     id when the file is re-processed, and the transcript's CONTENT settling
 *     later (Zoom publishes the VTT asynchronously, minutes after the meeting)
 *     does not change it — which is what makes a re-poll a deduped no-op
 *     rather than a duplicate.
 *
 * ⚠️ WHERE THE WEBHOOK WRITER MUST READ IT FROM (the trap this section exists
 * for). The two writers read the same two values from DIFFERENT SHAPES:
 *
 *   - poll (`GET /accounts/{accountId}/recordings`)
 *       → `meeting.uuid` + `meeting.recording_files[].id`
 *   - webhook (`recording.transcript_completed`)
 *       → `payload.object.uuid` + `payload.object.recording_files[].id`
 *
 * and the webhook's `recording_files[]` is filtered to the files that event is
 * about, so a webhook writer must NOT assume index 0 is the transcript — it
 * must select on `file_type === "TRANSCRIPT"` exactly as {@link isTranscriptFile}
 * does here. `recording.completed` fires EARLIER and carries the audio/video
 * files with no transcript at all; writing an episode from it mints an id for a
 * transcript that does not exist yet, which the later
 * `recording.transcript_completed` then dedupes against — losing the
 * transcript permanently.
 *
 * ⚠️ AND THE ENCODING TRAP, which is specific to Zoom and has no Slack analogue.
 * A meeting `uuid` is base64 (`A-Za-z0-9+/=`), so it routinely contains `/`
 * and `+`. Zoom's documented rule is that a uuid which BEGINS with `/` or
 * CONTAINS `//` must be **double** URL-encoded as a path segment;
 * `api.ts`'s `encodeMeetingUuidForPath` applies it unconditionally (the
 * conditional form has a rare branch that is never tested and always broken).
 * What matters for THIS contract is the other direction: That encoding is a TRANSPORT
 * concern and must never reach the stored id:
 *
 *     store   `4kd8sZTiSHagYbwYtLpMRA==`      ← the RAW value, verbatim
 *     request `4kd8sZTiSHagYbwYtLpMRA%253D%253D` ← double-encoded, per request
 *
 * The poll path encodes because it puts the uuid in a URL; the webhook path
 * never does, because the uuid arrives in a JSON body. If either normalises
 * before storing, the two writers mint different ids for the same recording and
 * duplicate every meeting whose uuid happens to contain a `/`, `+` or `=` —
 * which is most of them. {@link zoomEpisodeSourceId} therefore refuses a value
 * that has already been percent-encoded, rather than trusting the caller.
 *
 * `:` is a safe separator precisely because neither half can contain one:
 * base64 has no colon, and a Zoom recording-file id is a GUID.
 *
 * The one thing that must never change is the FORMAT. It is a stored key; a
 * reformat re-ingests every meeting in every workspace as a new episode, and
 * the extraction fiber (`lib/brain/extract.ts`) would then re-extract facts
 * from all of them.
 */

import { ZOOM_SOURCE } from "@atlas/api/lib/brain/sources";

/** The built-in catalog slug + row id for the Zoom transcript brain source. */
export const ZOOM_TRANSCRIPTS_SLUG = "zoom-transcripts";
export const ZOOM_TRANSCRIPTS_CATALOG_ID = "catalog:zoom-transcripts";

/**
 * The value stamped into `brain_episodes.source`. ADR-0036 sequences SOURCES
 * class-major, vendor-minor; within the transcript class the stored value is
 * the VENDOR, because the source-id contract above is vendor-specific and two
 * vendors sharing one stored value would share one dedupe namespace. So Google
 * Meet / Fireflies become their OWN members whenever they arrive, each
 * declaring `class: "transcript"` — not reuses of this one.
 *
 * Aliased off `lib/brain/sources.ts` rather than spelled again here: the column
 * is read as a discriminator (`isWarehouseDerived`), so its vocabulary is one
 * shared fact and not a literal each producer repeats.
 */
export const ZOOM_TRANSCRIPT_SOURCE = ZOOM_SOURCE;

/**
 * The `file_type` Zoom stamps on a closed-caption/transcript artifact.
 *
 * Zoom returns SEVERAL transcript-ish types and they are not interchangeable:
 * `TRANSCRIPT` is the timestamped VTT this connector ingests, `CC` is the
 * live closed-caption track (often absent, and truncated when present), and
 * `SUMMARY` / `TIMELINE` are Zoom AI artifacts that are Zoom's INFERENCE
 * rather than what was said. Ingesting a summary would put a vendor's
 * paraphrase into an evidence store and let the brain cite it as a quote —
 * the same self-echo ADR-0036 §T9 neutralises elsewhere.
 */
export const ZOOM_TRANSCRIPT_FILE_TYPE = "TRANSCRIPT" as const;

/**
 * Defensive bound on the configured host set (one install, one scope).
 *
 * Mirrors `SLACK_HISTORY_MAX_CHANNELS` and exists for the same reason: an
 * install form is a place a paste accident lands, and an unbounded scope list
 * is an unbounded per-cycle vendor spend.
 */
export const ZOOM_MAX_HOSTS = 50;

/**
 * A Zoom meeting `uuid` is base64 — `A-Za-z0-9+/=` — and a recording file id
 * is a GUID. Both are validated because they are interpolated into a
 * `source_id`, which is a stored key.
 *
 * ⚠️ NOT into the `audience:` grant token, despite the obvious reading. The
 * grant is `audience:meeting:<source>:<meetingUuid>` — the recording-file id
 * never appears in it — and the uuid reaching it is checked only by
 * `meetingAudienceId`'s own blank/colon guards, because `client.ts` derives the
 * grant and WRITES the audience membership before `zoomEpisodeSourceId` runs.
 * That ordering is deliberate (the block arm must be decided before any
 * transcript byte is fetched), so these patterns are a source-id guard only.
 *
 * Deliberately NOT anchored to a fixed LENGTH. Zoom has changed uuid width
 * before (the 22-char form predates the 24-char one) and a length check would
 * turn a vendor-side change into a per-cycle rejection of every new meeting,
 * with the previous ones still ingesting — the hardest possible shape to
 * diagnose. Character class only.
 */
export const ZOOM_MEETING_UUID_PATTERN = /^[A-Za-z0-9+/=]+$/;

/** A Zoom recording-file id: a hyphenated GUID. Case-INSENSITIVE deliberately — the vendor's casing is not a contract. */
export const ZOOM_RECORDING_FILE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Has this value already been percent-encoded? Used to refuse a uuid that a
 * caller URL-encoded before storing it — see the encoding trap in the header.
 *
 * `%` cannot appear in base64, so its presence at all is the signal; matching
 * the full `%XX` triple rather than a bare `%` keeps the error message honest
 * about what it found.
 */
function looksPercentEncoded(value: string): boolean {
  return /%[0-9a-fA-F]{2}/.test(value);
}

/**
 * Build the episode `source_id`. THE contract — see the module header.
 *
 * Throws rather than returning a sentinel: every caller is a WRITER, and the
 * value is half of the `(workspace_id, source, source_id)` dedupe tuple. A
 * malformed id that reached storage would not fail, it would land a row that
 * the other writer never dedupes against — so this is precisely the case where
 * CLAUDE.md's "prefer errors over silent fallbacks" applies. The connector
 * turns the throw into that meeting's skip warning; it never aborts a pass.
 */
export function zoomEpisodeSourceId(meetingUuid: string, recordingFileId: string): string {
  if (looksPercentEncoded(meetingUuid)) {
    throw new Error(
      `Zoom meeting uuid "${meetingUuid.slice(0, 60)}" is percent-encoded — store the RAW uuid the API returned. Encoding is per-request and must not reach the stored source_id, or the poll and webhook writers mint different ids for the same recording.`,
    );
  }
  if (!ZOOM_MEETING_UUID_PATTERN.test(meetingUuid)) {
    throw new Error(
      `Zoom meeting uuid "${meetingUuid.slice(0, 60)}" is not base64 — refusing to build a source_id from it.`,
    );
  }
  if (!ZOOM_RECORDING_FILE_ID_PATTERN.test(recordingFileId)) {
    throw new Error(
      `Zoom recording file id "${recordingFileId.slice(0, 60)}" is not a GUID — refusing to build a source_id from it.`,
    );
  }
  return `${meetingUuid}:${recordingFileId}`;
}

/**
 * Does this recording file carry the transcript this connector ingests?
 *
 * Exported so that a future Zoom WEBHOOK writer applies the SAME selection: its
 * `recording_files[]` arrives pre-filtered by the event, and "take index 0" is
 * the shape that silently ingests an audio file's metadata as a transcript. One
 * predicate, however many writers.
 *
 * ⚠️ One writer today. This said "#4967's webhook writer must apply" it, as
 * though that writer existed; #4967 shipped Slack-only.
 *
 * Case-INSENSITIVE on `file_type`. Zoom documents the type as uppercase and
 * returns it that way today; a vendor-side case change would otherwise stop
 * every transcript being recognised while the sync reported a clean, empty,
 * entirely green pass — the exact silent-drop failure an evidence store must
 * not have.
 *
 * The parameter admits `undefined` as well as `null` because a webhook writer
 * would hand it a different shape than the poll does: the poll path normalises
 * through `api.ts`'s `str()` and always passes `null`, while a writer reading
 * raw event JSON sees `undefined` for an absent `file_type`. A `!== null` test
 * would let that through to `.toUpperCase()` and throw. Kept deliberately —
 * widening it later, from the handler that trips over it, is the expensive
 * order to discover this in.
 */
export function isTranscriptFile(file: {
  readonly fileType: string | null | undefined;
}): boolean {
  return (
    file.fileType !== null &&
    file.fileType !== undefined &&
    file.fileType.toUpperCase() === ZOOM_TRANSCRIPT_FILE_TYPE
  );
}

/** The non-secret config persisted on the install's `workspace_plugins` row. */
export interface ZoomTranscriptsInstallConfig {
  /** The Zoom account id the S2S app is installed on. Not a secret. */
  readonly accountId: string;
  /**
   * Host user ids to narrow ingestion to. EMPTY MEANS THE WHOLE ACCOUNT, which
   * is the documented default and is what an admin installing a company brain
   * almost always wants — but it is stated here because "empty list" reading as
   * "everything" is the opposite of how `SlackHistoryInstallConfig.channels`
   * reads, and the two sit side by side in the same directory.
   */
  readonly hosts?: readonly string[];
  readonly description?: string;
}

export type ParsedZoomTranscriptsConfig =
  | { readonly ok: true; readonly accountId: string; readonly hosts: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a stored install config back into the connector's inputs. Actionable,
 * admin-facing errors (they land in `knowledge_sync_state.error`) — a missing
 * or invalid field means someone edited the row out of band; re-installing
 * repairs it.
 */
export function parseZoomTranscriptsConfig(
  config: Record<string, unknown> | null,
): ParsedZoomTranscriptsConfig {
  const rawAccountId = config?.accountId;
  if (typeof rawAccountId !== "string" || rawAccountId.trim() === "") {
    return {
      ok: false,
      error:
        "This Zoom transcripts source has no Zoom account id configured — re-install it and enter the account id from your Server-to-Server OAuth app.",
    };
  }
  const accountId = rawAccountId.trim();

  const rawHosts = config?.hosts;
  if (rawHosts === undefined || rawHosts === null) {
    return { ok: true, accountId, hosts: [] };
  }
  if (!Array.isArray(rawHosts)) {
    return {
      ok: false,
      error:
        "This Zoom transcripts source has a malformed host list configured — re-install it, leaving the host field blank to ingest the whole account.",
    };
  }
  const hosts: string[] = [];
  for (const entry of rawHosts) {
    // A non-string entry is REFUSED, not skipped, exactly as the Slack config
    // refuses one: silently narrowing the configured scope produces a source
    // that reports success while never reading a host the admin believes is
    // connected. The asymmetry with the empty case is deliberate — an absent
    // list is a stated "whole account", a malformed one is a stated something
    // we cannot read.
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        error:
          "This Zoom transcripts source has a malformed host list configured — re-install it and pick hosts from the list.",
      };
    }
    const trimmed = entry.trim();
    if (!hosts.includes(trimmed)) hosts.push(trimmed);
  }
  if (hosts.length > ZOOM_MAX_HOSTS) {
    return {
      ok: false,
      error: `This Zoom transcripts source has ${hosts.length} hosts configured, over the ${ZOOM_MAX_HOSTS}-host limit — re-install it with a narrower scope.`,
    };
  }
  return { ok: true, accountId, hosts };
}
