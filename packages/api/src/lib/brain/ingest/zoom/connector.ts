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
import { registerZoomAudienceReverifier } from "./audience";
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
 */
export function parseZoomAppCredential(raw: string | null): ZoomAppCredential | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Logged without the payload — it IS the secret.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Zoom app credential is not valid JSON",
    );
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const clientId = typeof row.clientId === "string" ? row.clientId.trim() : "";
  const clientSecret = typeof row.clientSecret === "string" ? row.clientSecret.trim() : "";
  if (clientId === "" || clientSecret === "") return null;
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
  const credential = parseZoomAppCredential(stored);
  if (credential === null) {
    throw new Error(
      "This workspace has no readable Zoom credential — re-install the Zoom transcripts source under Admin → Integrations with your Server-to-Server OAuth app's client id and secret.",
    );
  }
  const token = await reader.fetchZoomAccessToken({ accountId, ...credential });
  if (!token.ok) {
    // The token exchange's own failure vocabulary, translated once. A raw Zoom
    // code here would be the operator's first and least useful clue.
    throw new Error(
      token.error === "invalid_auth"
        ? "Zoom rejected the workspace's Server-to-Server OAuth credential — check the client id, client secret, and account id, then sync again."
        : `Could not obtain a Zoom access token (${token.error}) — check the Server-to-Server OAuth app is activated, then sync again.`,
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
): BrainSourceConnector {
  const reader: ZoomCredentialReader = deps.reader ?? { readSyncCredential, fetchZoomAccessToken };
  return {
    catalogId: ZOOM_TRANSCRIPTS_CATALOG_ID,
    source: ZOOM_TRANSCRIPT_SOURCE,
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
 * tests. Both registries throw on a duplicate, so gate on the connector registry
 * first.
 */
export function registerZoomTranscriptConnector(deps: ZoomTranscriptConnectorDeps = {}): void {
  if (getBrainSourceConnector(ZOOM_TRANSCRIPTS_CATALOG_ID) !== undefined) return;
  const reader: ZoomCredentialReader = deps.reader ?? { readSyncCredential, fetchZoomAccessToken };
  registerBrainSourceConnector(createZoomTranscriptConnector({ reader }));
  registerZoomAudienceReverifier({
    // The install id doubles as the credential's `collection_id`, the same
    // convention every knowledge connector uses.
    resolveToken: async (workspaceId, installId, config) => {
      const parsed = parseZoomTranscriptsConfig(config);
      if (!parsed.ok) throw new Error(parsed.error);
      return resolveZoomToken(reader, workspaceId, installId, parsed.accountId);
    },
  });
  log.info(
    { catalogId: ZOOM_TRANSCRIPTS_CATALOG_ID },
    "Registered Zoom transcript brain source and its audience re-verifier",
  );
}
