/**
 * The Zoom transcript {@link BrainSourceConnector} (#4965, ADR-0036 §Ingestion
 * & connectors) — the catalog-id-keyed adapter the shared sync cycle dispatches
 * on. It owns only the factory contract: bind the stored account scope + the
 * workspace's Server-to-Server OAuth credential into a vendor client.
 * Scheduling, backoff, caps, and the episode ingest are elsewhere.
 *
 * ## The credential, and the one shape that differs from every sibling
 *
 * `knowledge_sync_credentials` holds ONE secret per (workspace, collection).
 * Zoom's Server-to-Server OAuth needs TWO — a client id and a client secret —
 * so both are stored as a JSON object in that single slot rather than as two
 * rows. The alternative, putting the client id in `workspace_plugins.config`
 * because it "is not really a secret", was rejected: the pair is useless split
 * and an operator rotating the app would then have to edit two places, which is
 * the shape of drift that ends with a config naming one app and a credential
 * authenticating another.
 *
 * The `accountId` genuinely is non-secret scope and stays in the config, where
 * the install form and the audience re-verifier can both read it without
 * decrypting anything.
 *
 * ## Registration binds the connector AND its re-verifier, together
 *
 * {@link registerZoomTranscriptConnector} registers both. That coupling is the
 * point: a deployment with the connector and no re-verifier mints `audience:`
 * grants that stop granting at the staleness bound a week later, silently, with
 * every sync green. Making them one call means a future wiring edit cannot drop
 * half of it by omission.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { readSyncCredential } from "@atlas/api/lib/knowledge/sync-credentials";
import { createZoomTranscriptClient } from "./client";
import { fetchZoomAccessToken } from "./api";
import { createZoomAudienceReverifier } from "./audience";
import {
  ZOOM_TRANSCRIPTS_CATALOG_ID,
  ZOOM_TRANSCRIPT_SOURCE,
  parseZoomTranscriptsConfig,
} from "./config";
import {
  getBrainSourceConnector,
  registerBrainSourceConnector,
  type BrainSourceConnector,
  type BrainSourceInstallContext,
  type BrainSourceVendorClient,
} from "../types";

const log = createLogger("brain.ingest.zoom.connector");

/** Default backfill window for an install with no stored mark: 30 days. */
export const DEFAULT_TRANSCRIPT_BACKFILL_DAYS = 30;

/**
 * Zoom serves at most the last SIX MONTHS of account recordings, so a backfill
 * window wider than this cannot return anything and would only spend vendor
 * calls walking empty date windows. Clamped rather than rejected: an operator
 * who asked for a year should get everything Zoom has, with a warning, not a
 * failed sync.
 */
export const MAX_TRANSCRIPT_BACKFILL_DAYS = 180;

/**
 * How far back a never-synced install reads (ms), from the settings-registry
 * knob `ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS`.
 *
 * A knob rather than a constant for the same reason the chat one is: it is the
 * operator's lever when a first sync reports more history than one cycle can
 * read. Fractional days are legal (soak-testing); non-positive / unparseable
 * values fall back to the default WITH A WARN rather than backfilling nothing,
 * because a zero window would produce a sync that succeeds, finds no
 * recordings, and reports itself green forever.
 */
export function getTranscriptBackfillWindowMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS");
  if (raw === undefined || raw === "") return DEFAULT_TRANSCRIPT_BACKFILL_DAYS * 86_400_000;
  const days = Number.parseFloat(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS is non-positive or unparseable — using the default",
    );
    return DEFAULT_TRANSCRIPT_BACKFILL_DAYS * 86_400_000;
  }
  if (days > MAX_TRANSCRIPT_BACKFILL_DAYS) {
    log.warn(
      { raw, clamped: MAX_TRANSCRIPT_BACKFILL_DAYS },
      "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS is wider than Zoom's six-month retention — clamping",
    );
    return MAX_TRANSCRIPT_BACKFILL_DAYS * 86_400_000;
  }
  return days * 86_400_000;
}

/** The Zoom Server-to-Server OAuth app credential, as stored. */
export interface ZoomAppCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Parse the stored credential blob.
 *
 * Returns an actionable, admin-facing error rather than throwing a shape error:
 * the message lands in `knowledge_sync_state.error`, and "re-install it" is the
 * repair for every way this can fail. The secret VALUES never appear in the
 * message — CLAUDE.md's no-secrets-in-responses rule covers sync state, which
 * is admin-readable.
 *
 * `owner` names WHOSE credential failed. Redacting the payload and logging
 * nothing else is the opposite failure: on a deployment with many workspaces,
 * "a Zoom credential is unreadable — re-install the source" tells an operator
 * to go repair something without saying whose. The ids are not secret; the blob
 * is. Optional because the shape check is also exercised directly.
 */
export function parseZoomAppCredential(
  raw: string | null,
  owner?: { readonly workspaceId: string; readonly installId: string },
): ZoomAppCredential | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // No `// intentionally ignored:` marker — that marker is for a catch that
    // emits NO signal, and this one warns below. What is discarded here is the
    // error OBJECT, deliberately, and the reason is worth the paragraph:
    //
    // the parse error's MESSAGE echoes the input, and the
    // input is the decrypted client secret — `JSON.parse("s3cr3t-value")` throws
    // `Unexpected identifier "s3cr3t"`. Excluding `raw` from the payload is NOT
    // enough, which is what the previous version of this catch got wrong: it
    // logged `err.message` under a comment claiming the payload was withheld,
    // and shipped a fragment of the secret to the log sink on any blob that is
    // not JSON (a hand-repaired row, a legacy plaintext secret, a partial
    // decrypt). `outlook/connector.ts` reached this conclusion two review rounds
    // in; this is the same code path with the same blob. The shape failure plus
    // the OWNER is the whole signal; nothing else in the error is actionable.
    log.warn(
      { workspaceId: owner?.workspaceId, installId: owner?.installId },
      "Zoom app credential is not readable JSON — re-install the Zoom transcripts source for this workspace to repair it",
    );
    return null;
  }
  // The three SHAPE failures below warn too. They used to return `null` in
  // silence while the parse failure above warned — so three of the four ways
  // this can fail produced an unreadable-credential error downstream with
  // nothing in the log saying which shape was wrong, or whose.
  //
  // Still no payload: a well-formed JSON object that is missing a field carries
  // the secret in its OTHER field, so naming the keys is the most that can be
  // said. Which is enough — the repair is the same re-install either way, and
  // the distinction an operator needs is "the row is malformed" vs "the row is
  // fine and Zoom rejected it", which these lines now make.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(
      { workspaceId: owner?.workspaceId, installId: owner?.installId },
      "Zoom app credential is valid JSON but not an object — re-install the Zoom transcripts source for this workspace to repair it",
    );
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const clientId = typeof row.clientId === "string" ? row.clientId.trim() : "";
  const clientSecret = typeof row.clientSecret === "string" ? row.clientSecret.trim() : "";
  if (clientId === "" || clientSecret === "") {
    log.warn(
      {
        workspaceId: owner?.workspaceId,
        installId: owner?.installId,
        // WHICH field, never its value.
        missing: [clientId === "" ? "clientId" : null, clientSecret === "" ? "clientSecret" : null]
          .filter((field) => field !== null)
          .join(", "),
      },
      "Zoom app credential is missing a required field — re-install the Zoom transcripts source for this workspace to repair it",
    );
    return null;
  }
  return { clientId, clientSecret };
}

/** The credential surface the connector needs — injectable for tests. */
export interface ZoomCredentialReader {
  readSyncCredential: typeof readSyncCredential;
  fetchZoomAccessToken: typeof fetchZoomAccessToken;
}

/**
 * Resolve a workspace's Zoom bearer token, mapping every absence to an
 * actionable error. Exported so the install handler and the audience
 * re-verifier run the SAME resolution — install-time, sync-time and
 * re-verify-time must not be able to disagree about whether Zoom is connected.
 */
export async function resolveZoomToken(
  reader: ZoomCredentialReader,
  workspaceId: string,
  installId: string,
  accountId: string,
): Promise<string> {
  const stored = await reader.readSyncCredential(workspaceId, installId);
  const credential = parseZoomAppCredential(stored, { workspaceId, installId });
  if (credential === null) {
    throw new Error(
      "This workspace has no readable Zoom credential — re-install the Zoom transcripts source under Admin → Integrations with your Server-to-Server OAuth app's client id and secret.",
    );
  }
  const token = await reader.fetchZoomAccessToken({ accountId, ...credential });
  if (!token.ok) {
    // The token exchange's own failure vocabulary, translated once. A raw Zoom
    // code here would be the operator's first and least useful clue.
    // Three different repairs, so three different sentences. Routing a
    // transport fault to "check the app is activated" sends an admin to inspect
    // a configuration that was never wrong.
    if (token.error === "invalid_auth") {
      throw new Error(
        "Zoom rejected the workspace's Server-to-Server OAuth credential — check the client id, client secret, and account id, then sync again.",
      );
    }
    if (token.error === "transport") {
      throw new Error(
        "Zoom returned an unreadable response while issuing an access token — this is usually transient and the next scheduled cycle retries it.",
      );
    }
    throw new Error(
      `Could not obtain a Zoom access token (${token.error}) — check the Server-to-Server OAuth app is activated, then sync again.`,
    );
  }
  return token.token;
}

export interface ZoomTranscriptConnectorDeps {
  /** Injected credential reader for tests; defaults to the real one. */
  readonly reader?: ZoomCredentialReader;
}

/** Build the Zoom transcript brain source. `deps` is test-only injection. */
export function createZoomTranscriptConnector(
  deps: ZoomTranscriptConnectorDeps = {},
): BrainSourceConnector<typeof ZOOM_TRANSCRIPT_SOURCE> {
  const reader: ZoomCredentialReader = deps.reader ?? { readSyncCredential, fetchZoomAccessToken };
  return {
    catalogId: ZOOM_TRANSCRIPTS_CATALOG_ID,
    source: ZOOM_TRANSCRIPT_SOURCE,
    // Per-install, and unlike Slack that is not a second act: this connector
    // COLLECTS A SECRET (a Server-to-Server OAuth app's client id + secret) and
    // Zoom has no Atlas pillar install to inherit one from, so its install is
    // the only place the connection exists. #5203 retired the Slack install
    // precisely because it carried no secret and duplicated a pillar install
    // that already existed; neither is true here.
    scope: { kind: "per-install" },
    // Transcripts are a grant-DERIVING class: a meeting's audience comes from its
    // own participant list, so nothing but this re-verifier can refresh it and
    // `BrainSourceAudienceFor<"zoom">` admits no other arm. Built here, beside the
    // client, so the connector and its re-verifier share one `reader` and reach
    // the registry as one value.
    audience: {
      kind: "reverified",
      reverifier: createZoomAudienceReverifier({
        // The install id doubles as the credential's `collection_id`, the same
        // convention every knowledge connector uses.
        resolveToken: async (workspaceId, installId, config) => {
          const parsed = parseZoomTranscriptsConfig(config);
          if (!parsed.ok) throw new Error(parsed.error);
          return resolveZoomToken(reader, workspaceId, installId, parsed.accountId);
        },
      }),
    },
    createClient(ctx: BrainSourceInstallContext): BrainSourceVendorClient {
      const parsed = parseZoomTranscriptsConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);
      return createZoomTranscriptClient({
        workspaceId: ctx.workspaceId,
        accountId: parsed.accountId,
        hosts: parsed.hosts,
        backfillWindowMs: getTranscriptBackfillWindowMs(),
        // Deferred, not resolved here: `createClient` runs before the engine's
        // rate-limit backoff wraps the fetch, so a token exchange done at
        // construction time would sit OUTSIDE the retry it needs.
        resolveToken: () =>
          resolveZoomToken(reader, ctx.workspaceId, ctx.installId, parsed.accountId),
      });
    },
  };
}

/**
 * Register the Zoom transcript source AND its audience re-verifier idempotently
 * — called from the boot seam that also registers install handlers, and from
 * tests.
 *
 * The pair is ONE value and ONE call (#4985). Both registries throw on a
 * duplicate, and the gate below reads only the connector registry — so a
 * registration that committed the connector first and collided on the re-verifier
 * second would leave this source ingesting transcripts whose grants nothing
 * refreshes, permanently and silently, because the retry short-circuits on the
 * connector the failed attempt left behind. `registerBrainSourceConnector` does
 * all of its throwing before any of its writing, so that half-state has no path.
 */
export function registerZoomTranscriptConnector(deps: ZoomTranscriptConnectorDeps = {}): void {
  if (getBrainSourceConnector(ZOOM_TRANSCRIPTS_CATALOG_ID) !== undefined) return;
  registerBrainSourceConnector(createZoomTranscriptConnector(deps));
  log.info(
    { catalogId: ZOOM_TRANSCRIPTS_CATALOG_ID },
    "Registered Zoom transcript brain source and its audience re-verifier",
  );
}
