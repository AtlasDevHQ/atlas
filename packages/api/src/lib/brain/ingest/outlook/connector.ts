/**
 * The Outlook mail {@link BrainSourceConnector} (#4966, ADR-0036 §Ingestion &
 * connectors) — the catalog-id-keyed adapter the shared sync cycle dispatches
 * on. It owns only the factory contract: bind the stored tenant scope + the
 * workspace's app-only credential into a vendor client. Scheduling, backoff,
 * caps, and the episode ingest are elsewhere.
 *
 * ## The credential
 *
 * `knowledge_sync_credentials` holds ONE secret per (workspace, collection), and
 * Microsoft's client-credentials flow needs TWO values — a client id and a
 * client secret — so both are stored as a JSON object in that single slot rather
 * than as two rows. Identical to the shape `zoom/connector.ts` argues for, and
 * for the identical reason: the pair is useless split, and an operator rotating
 * the app registration would otherwise have to edit two places, which is the
 * drift that ends with a config naming one app and a credential authenticating
 * another.
 *
 * The `tenantId` is non-secret scope and stays in the config, where the install
 * form and the audience re-verifier can both read it without decrypting
 * anything.
 *
 * ## Registration binds the connector AND its re-verifier, together
 *
 * {@link registerOutlookMailConnector} registers both, and that coupling is not
 * a convenience. A deployment with the connector and no re-verifier mints
 * `audience:` grants that stop granting at the staleness bound a week later,
 * silently, with every sync green. Making them one call means a future wiring
 * edit cannot drop half of it by omission.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { readSyncCredential } from "@atlas/api/lib/knowledge/sync-credentials";
import { createOutlookMailClient } from "./client";
import { fetchGraphAccessToken } from "./api";
import { registerOutlookAudienceReverifier } from "./audience";
import {
  OUTLOOK_MAIL_CATALOG_ID,
  OUTLOOK_MAIL_SOURCE,
  parseOutlookMailConfig,
} from "./config";
import {
  getBrainSourceConnector,
  registerBrainSourceWithAudienceReverifier,
  type BrainSourceConnector,
  type BrainSourceInstallContext,
  type BrainSourceVendorClient,
} from "../types";

const log = createLogger("brain.ingest.outlook.connector");

/** Default backfill window for a mailbox with no stored mark: 30 days. */
export const DEFAULT_EMAIL_BACKFILL_DAYS = 30;

/**
 * Ceiling on the backfill window, in days.
 *
 * Unlike `MAX_TRANSCRIPT_BACKFILL_DAYS` this is NOT a vendor retention limit —
 * Exchange keeps mail for years, so a wider window really would return more. It
 * is a COST bound, and stating that matters because the two look identical in
 * code and behave differently under pressure: asking Zoom for a year returns
 * nothing past six months, while asking Graph for a year returns a year, one
 * `maxEpisodes` batch per cycle, minting one audience per message the whole way.
 *
 * Clamped rather than rejected: an operator who asked for five years should get
 * a year with a warning, not a failed sync.
 */
export const MAX_EMAIL_BACKFILL_DAYS = 365;

/**
 * How far back a never-synced mailbox reads (ms), from the settings-registry
 * knob `ATLAS_BRAIN_EMAIL_BACKFILL_DAYS`.
 *
 * A knob rather than a constant for the same reason the chat one is: it is the
 * operator's lever when a first sync reports more history than one cycle can
 * read. Fractional days are legal (soak-testing); non-positive / unparseable
 * values fall back to the default WITH A WARN rather than backfilling nothing,
 * because a zero window would produce a sync that succeeds, finds no mail, and
 * reports itself green forever.
 */
export function getEmailBackfillWindowMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_EMAIL_BACKFILL_DAYS");
  if (raw === undefined || raw === "") return DEFAULT_EMAIL_BACKFILL_DAYS * 86_400_000;
  const days = Number.parseFloat(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS is non-positive or unparseable — using the default",
    );
    return DEFAULT_EMAIL_BACKFILL_DAYS * 86_400_000;
  }
  if (days > MAX_EMAIL_BACKFILL_DAYS) {
    log.warn(
      { raw, clamped: MAX_EMAIL_BACKFILL_DAYS },
      "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS is wider than the supported backfill ceiling — clamping",
    );
    return MAX_EMAIL_BACKFILL_DAYS * 86_400_000;
  }
  return days * 86_400_000;
}

/** The Entra app registration's credential, as stored. */
export interface OutlookAppCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Parse the stored credential blob.
 *
 * Returns `null` rather than throwing a shape error; the caller turns it into an
 * actionable, admin-facing message that lands in `knowledge_sync_state.error`,
 * where "re-install it" is the repair for every way this can fail. The secret
 * VALUES never appear in a message or a log — CLAUDE.md's no-secrets rule covers
 * sync state, which is admin-readable.
 */
export function parseOutlookAppCredential(raw: string | null): OutlookAppCredential | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // intentionally ignored: the parse error's MESSAGE echoes the input, and the
    // input is the decrypted client secret — `JSON.parse("s3cr3t-value")` throws
    // `Unexpected identifier "s3cr3t"`. Carrying `err.message` here would ship a
    // fragment of the secret to the log sink on any blob that is not JSON (a
    // hand-repaired row, a legacy plaintext secret, a partial decrypt), which is
    // exactly what CLAUDE.md's no-secrets-in-logs rule forbids. The shape
    // failure IS the whole signal; there is nothing else actionable in it.
    log.warn({}, "Outlook app credential is not readable JSON — re-install the source to repair it");
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
export interface OutlookCredentialReader {
  readSyncCredential: typeof readSyncCredential;
  fetchGraphAccessToken: typeof fetchGraphAccessToken;
}

/**
 * Resolve a workspace's Graph bearer token, mapping every absence to an
 * actionable error. Exported so the install handler and the audience
 * re-verifier run the SAME resolution — install-time, sync-time and
 * re-verify-time must not be able to disagree about whether Outlook is
 * connected.
 */
export async function resolveOutlookToken(
  reader: OutlookCredentialReader,
  workspaceId: string,
  installId: string,
  tenantId: string,
): Promise<string> {
  const stored = await reader.readSyncCredential(workspaceId, installId);
  const credential = parseOutlookAppCredential(stored);
  if (credential === null) {
    throw new Error(
      "This workspace has no readable Microsoft credential — re-install the Outlook mail source under Admin → Integrations with your Entra app registration's client id and secret.",
    );
  }
  const token = await reader.fetchGraphAccessToken({ tenantId, ...credential });
  if (!token.ok) {
    // The token exchange's own failure vocabulary, translated once. A raw
    // Microsoft code here would be the operator's first and least useful clue,
    // and the three repairs are genuinely different places — routing a
    // transport fault to "check the app registration" sends an admin to inspect
    // a configuration that was never wrong.
    if (token.error === "invalid_auth") {
      throw new Error(
        "Microsoft rejected the workspace's app credential — check the client id, client secret and tenant id, and confirm the client secret has not expired (Entra secrets expire on a schedule), then sync again.",
      );
    }
    if (token.error === "transport") {
      throw new Error(
        "Microsoft returned an unreadable response while issuing an access token — this is usually transient and the next scheduled cycle retries it.",
      );
    }
    throw new Error(
      `Could not obtain a Microsoft access token (${token.error}) — check the app registration has Mail.Read application permission with admin consent granted, then sync again.`,
    );
  }
  return token.token;
}

export interface OutlookMailConnectorDeps {
  /** Injected credential reader for tests; defaults to the real one. */
  readonly reader?: OutlookCredentialReader;
}

/** Build the Outlook mail brain source. `deps` is test-only injection. */
export function createOutlookMailConnector(
  deps: OutlookMailConnectorDeps = {},
): BrainSourceConnector {
  const reader: OutlookCredentialReader = deps.reader ?? {
    readSyncCredential,
    fetchGraphAccessToken,
  };
  return {
    catalogId: OUTLOOK_MAIL_CATALOG_ID,
    source: OUTLOOK_MAIL_SOURCE,
    createClient(ctx: BrainSourceInstallContext): BrainSourceVendorClient {
      const parsed = parseOutlookMailConfig(ctx.config);
      if (!parsed.ok) throw new Error(parsed.error);
      return createOutlookMailClient({
        workspaceId: ctx.workspaceId,
        mailboxes: parsed.mailboxes,
        backfillWindowMs: getEmailBackfillWindowMs(),
        // Deferred, not resolved here: `createClient` runs before the engine's
        // rate-limit backoff wraps the fetch, so a token exchange done at
        // construction time would sit OUTSIDE the retry it needs.
        resolveToken: () =>
          resolveOutlookToken(reader, ctx.workspaceId, ctx.installId, parsed.tenantId),
      });
    },
  };
}

/**
 * Register the Outlook mail source AND its audience re-verifier idempotently —
 * called from the boot seam that also registers install handlers, and from
 * tests.
 *
 * The pair goes through `registerBrainSourceWithAudienceReverifier` rather than
 * as two statements. Both registries throw on a duplicate, and the gate below
 * reads only the connector registry — so registering the connector first and
 * colliding on the re-verifier second would leave this source ingesting mail
 * whose grants nothing refreshes, permanently and silently. That helper checks
 * the re-verifier registry before it commits anything.
 */
export function registerOutlookMailConnector(deps: OutlookMailConnectorDeps = {}): void {
  if (getBrainSourceConnector(OUTLOOK_MAIL_CATALOG_ID) !== undefined) return;
  const reader: OutlookCredentialReader = deps.reader ?? {
    readSyncCredential,
    fetchGraphAccessToken,
  };
  registerBrainSourceWithAudienceReverifier(createOutlookMailConnector({ reader }), () =>
    registerOutlookAudienceReverifier({
      // The install id doubles as the credential's `collection_id`, the same
      // convention every knowledge connector uses.
      resolveToken: async (workspaceId, installId, config) => {
        const parsed = parseOutlookMailConfig(config);
        if (!parsed.ok) throw new Error(parsed.error);
        return resolveOutlookToken(reader, workspaceId, installId, parsed.tenantId);
      },
    }),
  );
  log.info(
    { catalogId: OUTLOOK_MAIL_CATALOG_ID },
    "Registered Outlook mail brain source and its audience re-verifier",
  );
}
