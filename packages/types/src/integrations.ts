/**
 * Integration status types — wire format for the admin integrations surface.
 *
 * The admin integrations page aggregates per-platform connection status for
 * Slack, Teams, Discord, Telegram, Google Chat, GitHub, Linear, WhatsApp,
 * Email, and webhooks. Each platform has its own connect/disconnect routes
 * and store, but they share a status shape that the admin page renders
 * uniformly. Before #1648, the route layer + web layer kept their own Zod
 * copies of every per-platform schema; consolidating them in
 * `@useatlas/schemas` requires a shared TS type here so `satisfies
 * z.ZodType<T>` has a target to lock against.
 *
 * `INTEGRATION_PLATFORMS` is the runtime tuple — keep in lockstep with the
 * `IntegrationStatus` keys (the schema's structural-rejection test enforces
 * this at parse time). `DELIVERY_CHANNELS` is the runtime tuple for the
 * scheduled-tasks delivery surface, which lives on the same response.
 */

import type { DeployMode } from "./platform";
import type { DeliveryChannel } from "./scheduled-task";

// ---------------------------------------------------------------------------
// Platform identifiers (object keys on IntegrationStatus + drift discriminator)
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
// Most platforms share `connected` / `installedAt` / `configurable`; identity
// columns vary per platform. Webhooks is the structural outlier — it tracks
// `activeCount` instead of a single connection.
// ---------------------------------------------------------------------------

export interface SlackStatus {
  connected: boolean;
  teamId: string | null;
  workspaceName: string | null;
  installedAt: string | null;
  /** Whether Slack OAuth env vars are configured (SLACK_CLIENT_ID etc.). */
  oauthConfigured: boolean;
  /** Whether env-based token is set (single-workspace mode). */
  envConfigured: boolean;
  /** Whether the workspace admin can connect/disconnect (true) or it's platform-level only (false). */
  configurable: boolean;
}

export interface TeamsStatus {
  connected: boolean;
  tenantId: string | null;
  tenantName: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface DiscordStatus {
  connected: boolean;
  guildId: string | null;
  guildName: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface TelegramStatus {
  connected: boolean;
  botId: string | null;
  botUsername: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface GChatStatus {
  connected: boolean;
  projectId: string | null;
  serviceAccountEmail: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface GitHubStatus {
  connected: boolean;
  username: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface LinearStatus {
  connected: boolean;
  userName: string | null;
  userEmail: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface WhatsAppStatus {
  connected: boolean;
  phoneNumberId: string | null;
  displayPhone: string | null;
  installedAt: string | null;
  configurable: boolean;
}

export interface EmailStatus {
  connected: boolean;
  provider: string | null;
  senderAddress: string | null;
  installedAt: string | null;
  configurable: boolean;
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
