/**
 * Integration-status wire-format schemas.
 *
 * Single source of truth for the admin integrations surface
 * (`/api/v1/admin/integrations/status`) — used by both route-layer OpenAPI
 * validation and web-layer response parsing.
 *
 * The enum tuples (`INTEGRATION_PLATFORMS`, `DELIVERY_CHANNELS`) and the
 * `DeployMode` literal union all come from `@useatlas/types` so adding a
 * new platform / channel / deploy mode propagates here without manual
 * duplication.
 *
 * Every schema uses `satisfies z.ZodType<T>` (not `as z.ZodType<T>`) — the
 * `as` cast silently green-lights any shape, while `satisfies` forces the
 * object's inferred schema to be assignable to `ZodType<T>`. A field
 * rename in `@useatlas/types` then breaks this file at compile time
 * instead of passing through to runtime.
 *
 * Strict `z.enum(TUPLE)` matches the `@hono/zod-openapi` extractor's
 * expectations — it cannot serialize `ZodCatch` wrappers — and keeps the
 * generated OpenAPI spec describing the genuine output shape.
 */
import { z } from "zod";
import {
  DELIVERY_CHANNELS,
  type DeployMode,
  type SlackStatus,
  type TeamsStatus,
  type DiscordStatus,
  type TelegramStatus,
  type GChatStatus,
  type GitHubStatus,
  type LinearStatus,
  type WhatsAppStatus,
  type EmailStatus,
  type WebhookStatus,
  type IntegrationStatus,
} from "@useatlas/types";

const DeliveryChannelEnum = z.enum(DELIVERY_CHANNELS);
const DeployModeEnum = z.enum(["saas", "self-hosted"]) satisfies z.ZodType<DeployMode>;

export const SlackStatusSchema = z.object({
  connected: z.boolean(),
  teamId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  oauthConfigured: z.boolean(),
  envConfigured: z.boolean(),
  configurable: z.boolean(),
}) satisfies z.ZodType<SlackStatus>;

export const TeamsStatusSchema = z.object({
  connected: z.boolean(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<TeamsStatus>;

export const DiscordStatusSchema = z.object({
  connected: z.boolean(),
  guildId: z.string().nullable(),
  guildName: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<DiscordStatus>;

export const TelegramStatusSchema = z.object({
  connected: z.boolean(),
  botId: z.string().nullable(),
  botUsername: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<TelegramStatus>;

export const GChatStatusSchema = z.object({
  connected: z.boolean(),
  projectId: z.string().nullable(),
  serviceAccountEmail: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<GChatStatus>;

export const GitHubStatusSchema = z.object({
  connected: z.boolean(),
  username: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<GitHubStatus>;

export const LinearStatusSchema = z.object({
  connected: z.boolean(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<LinearStatus>;

export const WhatsAppStatusSchema = z.object({
  connected: z.boolean(),
  phoneNumberId: z.string().nullable(),
  displayPhone: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<WhatsAppStatus>;

export const EmailStatusSchema = z.object({
  connected: z.boolean(),
  provider: z.string().nullable(),
  senderAddress: z.string().nullable(),
  installedAt: z.string().datetime().nullable(),
  configurable: z.boolean(),
}) satisfies z.ZodType<EmailStatus>;

export const WebhookStatusSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  configurable: z.boolean(),
}) satisfies z.ZodType<WebhookStatus>;

export const IntegrationStatusSchema = z.object({
  slack: SlackStatusSchema,
  teams: TeamsStatusSchema,
  discord: DiscordStatusSchema,
  telegram: TelegramStatusSchema,
  gchat: GChatStatusSchema,
  github: GitHubStatusSchema,
  linear: LinearStatusSchema,
  whatsapp: WhatsAppStatusSchema,
  email: EmailStatusSchema,
  webhooks: WebhookStatusSchema,
  deliveryChannels: z.array(DeliveryChannelEnum),
  deployMode: DeployModeEnum,
  hasInternalDB: z.boolean(),
}) satisfies z.ZodType<IntegrationStatus>;
