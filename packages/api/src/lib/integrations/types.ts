/**
 * Shared integration installation types.
 *
 * Each platform has a public type (safe for API responses) and a
 * WithSecret variant (for internal store operations). The public type
 * excludes tokens, keys, and credentials. Store `*ByOrg` functions
 * strip secret fields at runtime before returning the public type.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface BaseInstallation {
  org_id: string | null;
  installed_at: string;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export interface SlackInstallation extends BaseInstallation {
  team_id: string;
  workspace_name: string | null;
}

export interface SlackInstallationWithSecret extends SlackInstallation {
  bot_token: string;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamsInstallation extends BaseInstallation {
  tenant_id: string;
  tenant_name: string | null;
}

export interface TeamsInstallationWithSecret extends TeamsInstallation {
  app_password: string | null;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export interface DiscordInstallation extends BaseInstallation {
  guild_id: string;
  guild_name: string | null;
  application_id: string | null;
  public_key: string | null;
}

export interface DiscordInstallationWithSecret extends DiscordInstallation {
  bot_token: string | null;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export interface TelegramInstallation extends BaseInstallation {
  bot_id: string;
  bot_username: string | null;
}

export interface TelegramInstallationWithSecret extends TelegramInstallation {
  bot_token: string;
}

// ---------------------------------------------------------------------------
// Google Chat
// ---------------------------------------------------------------------------

export interface GChatInstallation extends BaseInstallation {
  project_id: string;
  service_account_email: string;
}

export interface GChatInstallationWithSecret extends GChatInstallation {
  credentials_json: string;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GitHubInstallation extends BaseInstallation {
  /** GitHub numeric user ID (stable identifier, unlike login names). */
  user_id: string;
  username: string | null;
}

export interface GitHubInstallationWithSecret extends GitHubInstallation {
  access_token: string;
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

export interface LinearInstallation extends BaseInstallation {
  /** Linear viewer ID (stable identifier from /viewer query). */
  user_id: string;
  user_name: string | null;
  user_email: string | null;
}

export interface LinearInstallationWithSecret extends LinearInstallation {
  api_key: string;
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

export interface WhatsAppInstallation extends BaseInstallation {
  phone_number_id: string;
  display_phone: string | null;
}

export interface WhatsAppInstallationWithSecret extends WhatsAppInstallation {
  access_token: string;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

import { EMAIL_PROVIDERS, type EmailProvider } from "@useatlas/types/email-provider";

export { EMAIL_PROVIDERS, type EmailProvider };

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
}

export interface SendGridConfig {
  apiKey: string;
}

export interface PostmarkConfig {
  serverToken: string;
}

export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ResendConfig {
  apiKey: string;
}

export type ProviderConfig = SmtpConfig | SendGridConfig | PostmarkConfig | SesConfig | ResendConfig;

export interface EmailInstallation extends BaseInstallation {
  config_id: string;
  provider: EmailProvider;
  sender_address: string;
}

export interface EmailInstallationWithSecret extends EmailInstallation {
  config: ProviderConfig;
}
