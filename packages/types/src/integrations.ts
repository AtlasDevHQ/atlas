/**
 * Integration status types — wire format for the admin integrations surface.
 *
 * The admin integrations page aggregates per-platform connection status for
 * Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp,
 * Email, and webhooks. Each platform owns its own connect/disconnect routes
 * and store, but they share a status shape that the admin page renders
 * uniformly. Consolidating per-platform Zod schemas in `@useatlas/schemas`
 * needs a shared TS target so `satisfies z.ZodType<T>` has something to
 * lock against; that target lives here.
 *
 * `INTEGRATION_PLATFORMS` is the runtime mirror of the `IntegrationStatus`
 * platform keys. Compile-time guards below assert the two stay in lockstep
 * — adding a key on one side without the other is a `tsc` error, not a
 * runtime parse failure.
 */

import type { DeployMode } from "./platform";
import type { DeliveryChannel } from "./scheduled-task";

// ---------------------------------------------------------------------------
// Platform identifiers
// ---------------------------------------------------------------------------

export const INTEGRATION_PLATFORMS = [
  "slack",
  "teams",
  "discord",
  "telegram",
  "gchat",
  "github",
  "linear",
  "whatsapp",
  "email",
  "webhooks",
] as const;
export type IntegrationPlatform = (typeof INTEGRATION_PLATFORMS)[number];

// ---------------------------------------------------------------------------
// Per-platform status shapes
//
// Webhooks is the structural outlier — it tracks `activeCount` instead of a
// single connection, so it does not extend `ConnectedPlatformBase`.
// ---------------------------------------------------------------------------

/** Shared shape for the 9 single-connection platforms. */
interface ConnectedPlatformBase {
  connected: boolean;
  installedAt: string | null;
  /** Whether the workspace admin can connect/disconnect (true) or it's platform-level only (false). */
  configurable: boolean;
}

export interface SlackStatus extends ConnectedPlatformBase {
  teamId: string | null;
  workspaceName: string | null;
  /** Whether Slack OAuth env vars are configured (SLACK_CLIENT_ID etc.). */
  oauthConfigured: boolean;
  /** Whether env-based token is set (single-workspace mode). */
  envConfigured: boolean;
}

export interface TeamsStatus extends ConnectedPlatformBase {
  tenantId: string | null;
  tenantName: string | null;
}

export interface DiscordStatus extends ConnectedPlatformBase {
  guildId: string | null;
  guildName: string | null;
}

export interface TelegramStatus extends ConnectedPlatformBase {
  botId: string | null;
  botUsername: string | null;
}

export interface GChatStatus extends ConnectedPlatformBase {
  projectId: string | null;
  serviceAccountEmail: string | null;
}

export interface GitHubStatus extends ConnectedPlatformBase {
  username: string | null;
}

export interface LinearStatus extends ConnectedPlatformBase {
  userName: string | null;
  userEmail: string | null;
}

export interface WhatsAppStatus extends ConnectedPlatformBase {
  phoneNumberId: string | null;
  displayPhone: string | null;
}

export interface EmailStatus extends ConnectedPlatformBase {
  provider: string | null;
  senderAddress: string | null;
}

export interface WebhookStatus {
  activeCount: number;
  configurable: boolean;
}

// ---------------------------------------------------------------------------
// Aggregated response (GET /api/v1/admin/integrations/status)
// ---------------------------------------------------------------------------

export interface IntegrationStatus {
  slack: SlackStatus;
  teams: TeamsStatus;
  discord: DiscordStatus;
  telegram: TelegramStatus;
  gchat: GChatStatus;
  github: GitHubStatus;
  linear: LinearStatus;
  whatsapp: WhatsAppStatus;
  email: EmailStatus;
  webhooks: WebhookStatus;
  /** Delivery channels available for scheduled-task fan-out. */
  deliveryChannels: DeliveryChannel[];
  /** Resolved deploy mode — lets the frontend branch UI for SaaS vs self-hosted. */
  deployMode: DeployMode;
  /** Whether the internal database is available (enables BYOT credential storage). */
  hasInternalDB: boolean;
}

// ---------------------------------------------------------------------------
// Compile-time tuple/keys lockstep
//
// Bidirectional check: every IntegrationStatus platform key must appear in
// INTEGRATION_PLATFORMS, and every INTEGRATION_PLATFORMS value must appear as
// a key on IntegrationStatus. Drift on either side is a `tsc` error.
// ---------------------------------------------------------------------------

type PlatformKeysOnly = Exclude<
  keyof IntegrationStatus,
  "deliveryChannels" | "deployMode" | "hasInternalDB"
>;

type _PlatformKeysCoveredByTuple = PlatformKeysOnly extends IntegrationPlatform ? true : never;
type _TupleCoveredByPlatformKeys = IntegrationPlatform extends PlatformKeysOnly ? true : never;
