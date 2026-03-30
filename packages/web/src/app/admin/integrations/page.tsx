"use client";

import { useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { formatDateTime } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Cable,
  MessageSquare,
  MessageSquareText,
  MessageCircle,
  Send,
  Users,
  Webhook,
  Mail,
  Loader2,
  ExternalLink,
  GitBranch,
  BarChart3,
  Phone,
} from "lucide-react";

// -- Types (mirrors IntegrationStatusSchema in packages/api/src/api/routes/admin-integrations.ts) --

type DeliveryChannel = "email" | "slack" | "webhook";

interface SlackStatus {
  connected: boolean;
  teamId: string | null;
  workspaceName: string | null;
  installedAt: string | null;
  oauthConfigured: boolean;
  envConfigured: boolean;
  /** Whether the workspace admin can connect/disconnect Slack */
  configurable: boolean;
}

interface TeamsStatus {
  connected: boolean;
  tenantId: string | null;
  tenantName: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface DiscordStatus {
  connected: boolean;
  guildId: string | null;
  guildName: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface TelegramStatus {
  connected: boolean;
  botId: string | null;
  botUsername: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface GChatStatus {
  connected: boolean;
  projectId: string | null;
  serviceAccountEmail: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface GitHubStatus {
  connected: boolean;
  username: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface LinearStatus {
  connected: boolean;
  userName: string | null;
  userEmail: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface WhatsAppStatus {
  connected: boolean;
  phoneNumberId: string | null;
  displayPhone: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface WebhookStatus {
  activeCount: number;
  /** Whether the workspace admin can create/manage webhooks */
  configurable: boolean;
}

interface IntegrationStatus {
  slack: SlackStatus;
  teams: TeamsStatus;
  discord: DiscordStatus;
  telegram: TelegramStatus;
  gchat: GChatStatus;
  github: GitHubStatus;
  linear: LinearStatus;
  whatsapp: WhatsAppStatus;
  webhooks: WebhookStatus;
  deliveryChannels: DeliveryChannel[];
  deployMode: "saas" | "self-hosted";
  hasInternalDB: boolean;
}

// -- Component --

export default function IntegrationsPage() {
  const { data, loading, error, refetch } =
    useAdminFetch<IntegrationStatus>("/api/v1/admin/integrations/status");

  const disconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/slack",
    method: "DELETE",
    invalidates: refetch,
  });

  const teamsDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/teams",
    method: "DELETE",
    invalidates: refetch,
  });

  const discordDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/discord",
    method: "DELETE",
    invalidates: refetch,
  });

  const slackByotMutation = useAdminMutation<{
    message: string;
    workspaceName: string | null;
    teamId: string | null;
  }>({
    path: "/api/v1/admin/integrations/slack/byot",
    method: "POST",
    invalidates: refetch,
  });

  const teamsByotMutation = useAdminMutation<{
    message: string;
    appId: string;
  }>({
    path: "/api/v1/admin/integrations/teams/byot",
    method: "POST",
    invalidates: refetch,
  });

  const discordByotMutation = useAdminMutation<{
    message: string;
    botUsername: string | null;
  }>({
    path: "/api/v1/admin/integrations/discord/byot",
    method: "POST",
    invalidates: refetch,
  });

  const telegramConnectMutation = useAdminMutation<{
    message: string;
    botUsername: string | null;
  }>({
    path: "/api/v1/admin/integrations/telegram",
    method: "POST",
    invalidates: refetch,
  });

  const telegramDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/telegram",
    method: "DELETE",
    invalidates: refetch,
  });

  const gchatConnectMutation = useAdminMutation<{
    message: string;
    projectId: string | null;
    serviceAccountEmail: string | null;
  }>({
    path: "/api/v1/admin/integrations/gchat",
    method: "POST",
    invalidates: refetch,
  });

  const gchatDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/gchat",
    method: "DELETE",
    invalidates: refetch,
  });

  const githubConnectMutation = useAdminMutation<{
    message: string;
    username: string | null;
  }>({
    path: "/api/v1/admin/integrations/github",
    method: "POST",
    invalidates: refetch,
  });

  const githubDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/github",
    method: "DELETE",
    invalidates: refetch,
  });

  const linearConnectMutation = useAdminMutation<{
    message: string;
    userName: string | null;
    userEmail: string | null;
  }>({
    path: "/api/v1/admin/integrations/linear",
    method: "POST",
    invalidates: refetch,
  });

  const linearDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/linear",
    method: "DELETE",
    invalidates: refetch,
  });

  const whatsappConnectMutation = useAdminMutation<{
    message: string;
    displayPhone: string | null;
  }>({
    path: "/api/v1/admin/integrations/whatsapp",
    method: "POST",
    invalidates: refetch,
  });

  const whatsappDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/whatsapp",
    method: "DELETE",
    invalidates: refetch,
  });

  async function handleDisconnect() {
    await disconnectMutation.mutate({});
  }

  async function handleSlackByot(botToken: string) {
    await slackByotMutation.mutate({ body: { botToken } });
  }

  async function handleTeamsDisconnect() {
    await teamsDisconnectMutation.mutate({});
  }

  async function handleTeamsByot(appId: string, appPassword: string) {
    await teamsByotMutation.mutate({ body: { appId, appPassword } });
  }

  async function handleDiscordDisconnect() {
    await discordDisconnectMutation.mutate({});
  }

  async function handleDiscordByot(botToken: string, applicationId: string, publicKey: string) {
    await discordByotMutation.mutate({ body: { botToken, applicationId, publicKey } });
  }

  async function handleTelegramConnect(botToken: string) {
    await telegramConnectMutation.mutate({ body: { botToken } });
  }

  async function handleTelegramDisconnect() {
    await telegramDisconnectMutation.mutate({});
  }

  async function handleGChatConnect(credentialsJson: string) {
    await gchatConnectMutation.mutate({ body: { credentialsJson } });
  }

  async function handleGChatDisconnect() {
    await gchatDisconnectMutation.mutate({});
  }

  async function handleGitHubConnect(accessToken: string) {
    await githubConnectMutation.mutate({ body: { accessToken } });
  }

  async function handleGitHubDisconnect() {
    await githubDisconnectMutation.mutate({});
  }

  async function handleLinearConnect(apiKey: string) {
    await linearConnectMutation.mutate({ body: { apiKey } });
  }

  async function handleLinearDisconnect() {
    await linearDisconnectMutation.mutate({});
  }

  async function handleWhatsAppConnect(phoneNumberId: string, accessToken: string) {
    await whatsappConnectMutation.mutate({ body: { phoneNumberId, accessToken } });
  }

  async function handleWhatsAppDisconnect() {
    await whatsappDisconnectMutation.mutate({});
  }

  const isSaas = data?.deployMode === "saas";
  const hasDB = data?.hasInternalDB ?? false;
  const slack = data?.slack;
  const teams = data?.teams;
  const discord = data?.discord;
  const telegram = data?.telegram;
  const gchat = data?.gchat;
  const github = data?.github;
  const linear = data?.linear;
  const whatsapp = data?.whatsapp;
  const webhooks = data?.webhooks;
  const deliveryChannels = data?.deliveryChannels ?? [];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Manage connections to external platforms and services
        </p>
      </div>

      <ErrorBoundary>
        <AdminContentWrapper
          loading={loading}
          error={error}
          feature="Integrations"
          onRetry={refetch}
          loadingMessage="Loading integrations..."
          emptyIcon={Cable}
          emptyTitle="No integrations"
          emptyDescription="Integration status could not be loaded."
          isEmpty={!data}
        >
          <div className="grid gap-6 md:grid-cols-2">
            {/* Slack card */}
            <SlackCard
              slack={slack!}
              isSaas={isSaas}
              hasInternalDB={hasDB}
              onDisconnect={handleDisconnect}
              disconnecting={disconnectMutation.saving}
              disconnectError={disconnectMutation.error}
              onByotConnect={handleSlackByot}
              byotConnecting={slackByotMutation.saving}
              byotError={slackByotMutation.error}
            />

            {/* Teams card */}
            <TeamsCard
              teams={teams!}
              isSaas={isSaas}
              hasInternalDB={hasDB}
              onDisconnect={handleTeamsDisconnect}
              disconnecting={teamsDisconnectMutation.saving}
              disconnectError={teamsDisconnectMutation.error}
              onByotConnect={handleTeamsByot}
              byotConnecting={teamsByotMutation.saving}
              byotError={teamsByotMutation.error}
            />

            {/* Discord card */}
            <DiscordCard
              discord={discord!}
              isSaas={isSaas}
              hasInternalDB={hasDB}
              onDisconnect={handleDiscordDisconnect}
              disconnecting={discordDisconnectMutation.saving}
              disconnectError={discordDisconnectMutation.error}
              onByotConnect={handleDiscordByot}
              byotConnecting={discordByotMutation.saving}
              byotError={discordByotMutation.error}
            />

            {/* Telegram card */}
            <TelegramCard
              telegram={telegram!}
              isSaas={isSaas}
              onConnect={handleTelegramConnect}
              connecting={telegramConnectMutation.saving}
              connectError={telegramConnectMutation.error}
              onDisconnect={handleTelegramDisconnect}
              disconnecting={telegramDisconnectMutation.saving}
              disconnectError={telegramDisconnectMutation.error}
            />

            {/* Google Chat card */}
            <GChatCard
              gchat={gchat!}
              onConnect={handleGChatConnect}
              connecting={gchatConnectMutation.saving}
              connectError={gchatConnectMutation.error}
              onDisconnect={handleGChatDisconnect}
              disconnecting={gchatDisconnectMutation.saving}
              disconnectError={gchatDisconnectMutation.error}
            />

            {/* GitHub card */}
            <GitHubCard
              github={github!}
              onConnect={handleGitHubConnect}
              connecting={githubConnectMutation.saving}
              connectError={githubConnectMutation.error}
              onDisconnect={handleGitHubDisconnect}
              disconnecting={githubDisconnectMutation.saving}
              disconnectError={githubDisconnectMutation.error}
            />

            {/* Linear card */}
            <LinearCard
              linear={linear!}
              onConnect={handleLinearConnect}
              connecting={linearConnectMutation.saving}
              connectError={linearConnectMutation.error}
              onDisconnect={handleLinearDisconnect}
              disconnecting={linearDisconnectMutation.saving}
              disconnectError={linearDisconnectMutation.error}
            />

            {/* WhatsApp card */}
            <WhatsAppCard
              whatsapp={whatsapp!}
              onConnect={handleWhatsAppConnect}
              connecting={whatsappConnectMutation.saving}
              connectError={whatsappConnectMutation.error}
              onDisconnect={handleWhatsAppDisconnect}
              disconnecting={whatsappDisconnectMutation.saving}
              disconnectError={whatsappDisconnectMutation.error}
            />

            {/* Webhooks card */}
            <WebhookCard webhooks={webhooks} isSaas={isSaas} />

            {/* Delivery Channels card */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Mail className="size-5 text-muted-foreground" />
                  <CardTitle className="text-base">Delivery Channels</CardTitle>
                </div>
                <CardDescription>
                  Available channels for scheduled task delivery and notifications
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {deliveryChannels.map((channel) => (
                    <Badge
                      key={channel}
                      variant="outline"
                      className="gap-1.5 capitalize"
                    >
                      <ChannelIcon channel={channel} />
                      {channel}
                    </Badge>
                  ))}
                  {deliveryChannels.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No delivery channels configured
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </AdminContentWrapper>
      </ErrorBoundary>
    </div>
  );
}

// -- Slack Card --

function SlackCard({
  slack,
  isSaas,
  hasInternalDB,
  onDisconnect,
  disconnecting,
  disconnectError,
  onByotConnect,
  byotConnecting,
  byotError,
}: {
  slack: SlackStatus;
  isSaas: boolean;
  hasInternalDB: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
  onByotConnect: (botToken: string) => void;
  byotConnecting: boolean;
  byotError: string | null;
}) {
  const canConnect = slack.configurable;
  const canByot = !canConnect && hasInternalDB;

  const statusBadge = slack.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect && !canByot ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Slack</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Slack for /atlas commands and thread follow-ups
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {slack.connected && (
          <div className="space-y-2 text-sm">
            {slack.workspaceName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Workspace</span>
                <span className="font-medium">{slack.workspaceName}</span>
              </div>
            )}
            {slack.teamId && slack.teamId !== "env" && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Team ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {slack.teamId}
                </code>
              </div>
            )}
            {slack.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(slack.installedAt)}</span>
              </div>
            )}
            {!isSaas && slack.envConfigured && !slack.oauthConfigured && (
              <p className="text-xs text-muted-foreground">
                Using environment variable (SLACK_BOT_TOKEN). Configure OAuth
                credentials for self-serve management.
              </p>
            )}
          </div>
        )}

        {/* Not connected + no OAuth + BYOT available: show token form */}
        {!slack.connected && canByot && (
          <SlackByotForm
            onConnect={onByotConnect}
            connecting={byotConnecting}
            error={byotError}
          />
        )}

        {/* Not connected + no OAuth + no BYOT: truly unavailable */}
        {!slack.connected && !canConnect && !canByot && (
          isSaas ? (
            <p className="text-sm text-muted-foreground">
              Slack integration is not available. Contact your administrator.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_ID</code>{" "}
              and <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_SECRET</code>{" "}
              to enable Slack OAuth, or configure{" "}
              <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
              to use a bot token.
            </p>
          )
        )}

        {disconnectError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError}
          </div>
        )}

        <div className="flex gap-2">
          {slack.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Slack"
              description="This will remove the Slack connection for this workspace. The /atlas command and thread follow-ups will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}

          {!slack.connected && canConnect && (
            <Button size="sm" asChild>
              <a href="/api/v1/slack/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect to Slack
              </a>
            </Button>
          )}

          {slack.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/slack/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Teams Card --

function TeamsCard({
  teams,
  isSaas,
  hasInternalDB,
  onDisconnect,
  disconnecting,
  disconnectError,
  onByotConnect,
  byotConnecting,
  byotError,
}: {
  teams: TeamsStatus;
  isSaas: boolean;
  hasInternalDB: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
  onByotConnect: (appId: string, appPassword: string) => void;
  byotConnecting: boolean;
  byotError: string | null;
}) {
  const canConnect = teams.configurable;
  const canByot = !canConnect && hasInternalDB;

  const statusBadge = teams.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect && !canByot ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Microsoft Teams</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Teams for @atlas mentions and channel conversations
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {teams.connected && (
          <div className="space-y-2 text-sm">
            {teams.tenantName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-medium">{teams.tenantName}</span>
              </div>
            )}
            {teams.tenantId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {teams.tenantId}
                </code>
              </div>
            )}
            {teams.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(teams.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {/* Not connected + no OAuth + BYOT available: show credentials form */}
        {!teams.connected && canByot && (
          <TeamsByotForm
            onConnect={onByotConnect}
            connecting={byotConnecting}
            error={byotError}
          />
        )}

        {/* Not connected + no OAuth + no BYOT: truly unavailable */}
        {!teams.connected && !canConnect && !canByot && (
          isSaas ? (
            <p className="text-sm text-muted-foreground">
              Teams integration is not available. Contact your administrator.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set{" "}
              <code className="rounded bg-muted px-1 text-xs">TEAMS_APP_ID</code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 text-xs">TEAMS_APP_PASSWORD</code>{" "}
              to enable Teams, or configure{" "}
              <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
              to use your own app credentials.
            </p>
          )
        )}

        {disconnectError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError}
          </div>
        )}

        <div className="flex gap-2">
          {teams.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Microsoft Teams"
              description="This will remove the Teams connection for this tenant. The @atlas mentions and channel conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}

          {!teams.connected && canConnect && (
            <Button size="sm" asChild>
              <a href="/api/v1/teams/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect to Teams
              </a>
            </Button>
          )}

          {teams.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/teams/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Discord Card --

function DiscordCard({
  discord,
  isSaas,
  hasInternalDB,
  onDisconnect,
  disconnecting,
  disconnectError,
  onByotConnect,
  byotConnecting,
  byotError,
}: {
  discord: DiscordStatus;
  isSaas: boolean;
  hasInternalDB: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
  onByotConnect: (botToken: string, applicationId: string, publicKey: string) => void;
  byotConnecting: boolean;
  byotError: string | null;
}) {
  const canConnect = discord.configurable;
  const canByot = !canConnect && hasInternalDB;

  const statusBadge = discord.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect && !canByot ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageCircle className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Discord</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Discord for bot commands and server conversations
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {discord.connected && (
          <div className="space-y-2 text-sm">
            {discord.guildName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Server</span>
                <span className="font-medium">{discord.guildName}</span>
              </div>
            )}
            {discord.guildId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Guild ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {discord.guildId}
                </code>
              </div>
            )}
            {discord.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(discord.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {/* Not connected + no OAuth + BYOT available: show credentials form */}
        {!discord.connected && canByot && (
          <DiscordByotForm
            onConnect={onByotConnect}
            connecting={byotConnecting}
            error={byotError}
          />
        )}

        {/* Not connected + no OAuth + no BYOT: truly unavailable */}
        {!discord.connected && !canConnect && !canByot && (
          isSaas ? (
            <p className="text-sm text-muted-foreground">
              Discord integration is not available. Contact your administrator.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set{" "}
              <code className="rounded bg-muted px-1 text-xs">DISCORD_CLIENT_ID</code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 text-xs">DISCORD_CLIENT_SECRET</code>{" "}
              to enable Discord OAuth, or configure{" "}
              <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
              to use your own bot credentials.
            </p>
          )
        )}

        {disconnectError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError}
          </div>
        )}

        <div className="flex gap-2">
          {discord.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Discord"
              description="This will remove the Discord connection for this server. The bot commands and conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}

          {!discord.connected && canConnect && (
            <Button size="sm" asChild>
              <a href="/api/v1/discord/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect to Discord
              </a>
            </Button>
          )}

          {discord.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/discord/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Telegram Card --

function TelegramCard({
  telegram,
  isSaas,
  onConnect,
  connecting,
  connectError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  telegram: TelegramStatus;
  isSaas: boolean;
  onConnect: (botToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = telegram.configurable;

  const statusBadge = telegram.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : isSaas && !canConnect ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Send className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Telegram</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect a Telegram bot for chat conversations
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {telegram.connected && (
          <div className="space-y-2 text-sm">
            {telegram.botUsername && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bot</span>
                <span className="font-medium">@{telegram.botUsername}</span>
              </div>
            )}
            {telegram.botId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bot ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {telegram.botId}
                </code>
              </div>
            )}
            {telegram.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(telegram.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {/* Not connected: show form or unavailable message */}
        {!telegram.connected && !canConnect && (
          <p className="text-sm text-muted-foreground">
            Telegram integration requires an internal database. Configure{" "}
            <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
            to enable it.
          </p>
        )}

        {!telegram.connected && canConnect && (
          <TelegramConnectForm
            onConnect={onConnect}
            connecting={connecting}
            error={connectError}
          />
        )}

        {(disconnectError || (telegram.connected && connectError)) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError ?? connectError}
          </div>
        )}

        <div className="flex gap-2">
          {telegram.connected && canConnect && (
            <DisconnectDialog
              name="Telegram"
              description="This will remove the Telegram bot connection for this workspace. Bot conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Telegram Connect Form --

function TelegramConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (botToken: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim()) {
      onConnect(token.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="telegram-token" className="text-sm font-medium">
          Bot Token
        </label>
        <p className="text-xs text-muted-foreground">
          Get a bot token from{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            @BotFather
          </a>{" "}
          on Telegram
        </p>
        <Input
          id="telegram-token"
          type="password"
          placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={connecting || !token.trim()}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Google Chat Card --

function GChatCard({
  gchat,
  onConnect,
  connecting,
  connectError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  gchat: GChatStatus;
  onConnect: (credentialsJson: string) => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = gchat.configurable;

  const statusBadge = gchat.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Google Chat</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Google Chat for bot conversations in Google Workspace
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {gchat.connected && (
          <div className="space-y-2 text-sm">
            {gchat.serviceAccountEmail && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Service Account</span>
                <span className="max-w-48 truncate font-medium" title={gchat.serviceAccountEmail}>
                  {gchat.serviceAccountEmail}
                </span>
              </div>
            )}
            {gchat.projectId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Project ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {gchat.projectId}
                </code>
              </div>
            )}
            {gchat.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(gchat.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {!gchat.connected && !canConnect && (
          <p className="text-sm text-muted-foreground">
            Google Chat integration requires an internal database. Configure{" "}
            <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
            to enable it.
          </p>
        )}

        {!gchat.connected && canConnect && (
          <GChatConnectForm
            onConnect={onConnect}
            connecting={connecting}
            error={connectError}
          />
        )}

        {(disconnectError || (gchat.connected && connectError)) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError ?? connectError}
          </div>
        )}

        <div className="flex gap-2">
          {gchat.connected && canConnect && (
            <DisconnectDialog
              name="Google Chat"
              description="This will remove the Google Chat connection for this workspace. Bot conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Google Chat Connect Form --

function GChatConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (credentialsJson: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [json, setJson] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (json.trim()) {
      onConnect(json.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="gchat-credentials" className="text-sm font-medium">
          Service Account JSON
        </label>
        <p className="text-xs text-muted-foreground">
          Create a{" "}
          <a
            href="https://console.cloud.google.com/iam-admin/serviceaccounts"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            service account
          </a>{" "}
          in Google Cloud Console and paste the JSON key
        </p>
        <Textarea
          id="gchat-credentials"
          placeholder='{"type": "service_account", "project_id": "...", ...}'
          value={json}
          onChange={(e) => setJson(e.target.value)}
          disabled={connecting}
          rows={4}
          className="font-mono text-xs"
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={connecting || !json.trim()}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- GitHub Card --

function GitHubCard({
  github,
  onConnect,
  connecting,
  connectError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  github: GitHubStatus;
  onConnect: (accessToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = github.configurable;

  const statusBadge = github.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">GitHub</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect GitHub for issue tracking and repository integration
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {github.connected && (
          <div className="space-y-2 text-sm">
            {github.username && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">User</span>
                <span className="font-medium">@{github.username}</span>
              </div>
            )}
            {github.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(github.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {!github.connected && !canConnect && (
          <p className="text-sm text-muted-foreground">
            GitHub integration requires an internal database. Configure{" "}
            <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
            to enable it.
          </p>
        )}

        {!github.connected && canConnect && (
          <GitHubConnectForm
            onConnect={onConnect}
            connecting={connecting}
            error={connectError}
          />
        )}

        {(disconnectError || (github.connected && connectError)) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError ?? connectError}
          </div>
        )}

        <div className="flex gap-2">
          {github.connected && canConnect && (
            <DisconnectDialog
              name="GitHub"
              description="This will remove the GitHub connection for this workspace. GitHub integration functionality will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- GitHub Connect Form --

function GitHubConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (accessToken: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim()) {
      onConnect(token.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="github-token" className="text-sm font-medium">
          Personal Access Token
        </label>
        <p className="text-xs text-muted-foreground">
          Create a{" "}
          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            personal access token
          </a>{" "}
          with the permissions you need
        </p>
        <Input
          id="github-token"
          type="password"
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={connecting || !token.trim()}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Linear Card --

function LinearCard({
  linear,
  onConnect,
  connecting,
  connectError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  linear: LinearStatus;
  onConnect: (apiKey: string) => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = linear.configurable;

  const statusBadge = linear.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Linear</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Linear for issue tracking and project management
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {linear.connected && (
          <div className="space-y-2 text-sm">
            {linear.userName && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">User</span>
                <span className="font-medium">{linear.userName}</span>
              </div>
            )}
            {linear.userEmail && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{linear.userEmail}</span>
              </div>
            )}
            {linear.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(linear.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {!linear.connected && !canConnect && (
          <p className="text-sm text-muted-foreground">
            Linear integration requires an internal database. Configure{" "}
            <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
            to enable it.
          </p>
        )}

        {!linear.connected && canConnect && (
          <LinearConnectForm
            onConnect={onConnect}
            connecting={connecting}
            error={connectError}
          />
        )}

        {(disconnectError || (linear.connected && connectError)) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError ?? connectError}
          </div>
        )}

        <div className="flex gap-2">
          {linear.connected && canConnect && (
            <DisconnectDialog
              name="Linear"
              description="This will remove the Linear connection for this workspace. Issue tracking integration will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Linear Connect Form --

function LinearConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (apiKey: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim()) {
      onConnect(token.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="linear-api-key" className="text-sm font-medium">
          API Key
        </label>
        <p className="text-xs text-muted-foreground">
          Create an{" "}
          <a
            href="https://linear.app/settings/api"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            API key
          </a>{" "}
          from your Linear workspace settings
        </p>
        <Input
          id="linear-api-key"
          type="password"
          placeholder="lin_api_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={connecting || !token.trim()}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- WhatsApp Card --

function WhatsAppCard({
  whatsapp,
  onConnect,
  connecting,
  connectError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  whatsapp: WhatsAppStatus;
  onConnect: (phoneNumberId: string, accessToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = whatsapp.configurable;

  const statusBadge = whatsapp.connected ? (
    <Badge variant="default">Connected</Badge>
  ) : !canConnect ? (
    <Badge variant="outline">Not Available</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Phone className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">WhatsApp</CardTitle>
          </div>
          {statusBadge}
        </div>
        <CardDescription>
          Connect WhatsApp for messaging and notification delivery
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {whatsapp.connected && (
          <div className="space-y-2 text-sm">
            {whatsapp.displayPhone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span className="font-medium">{whatsapp.displayPhone}</span>
              </div>
            )}
            {whatsapp.phoneNumberId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone Number ID</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {whatsapp.phoneNumberId}
                </code>
              </div>
            )}
            {whatsapp.installedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connected</span>
                <span>{formatDateTime(whatsapp.installedAt)}</span>
              </div>
            )}
          </div>
        )}

        {!whatsapp.connected && !canConnect && (
          <p className="text-sm text-muted-foreground">
            WhatsApp integration requires an internal database. Configure{" "}
            <code className="rounded bg-muted px-1 text-xs">DATABASE_URL</code>{" "}
            to enable it.
          </p>
        )}

        {!whatsapp.connected && canConnect && (
          <WhatsAppConnectForm
            onConnect={onConnect}
            connecting={connecting}
            error={connectError}
          />
        )}

        {(disconnectError || (whatsapp.connected && connectError)) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError ?? connectError}
          </div>
        )}

        <div className="flex gap-2">
          {whatsapp.connected && canConnect && (
            <DisconnectDialog
              name="WhatsApp"
              description="This will remove the WhatsApp connection for this workspace. WhatsApp messaging will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- WhatsApp Connect Form --

function WhatsAppConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (phoneNumberId: string, accessToken: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phoneNumberId.trim() && accessToken.trim()) {
      onConnect(phoneNumberId.trim(), accessToken.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="whatsapp-phone-id" className="text-sm font-medium">
          Phone Number ID
        </label>
        <p className="text-xs text-muted-foreground">
          From your{" "}
          <a
            href="https://business.facebook.com/settings/whatsapp-business-accounts"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Meta Business Suite
          </a>{" "}
          WhatsApp settings
        </p>
        <Input
          id="whatsapp-phone-id"
          type="text"
          placeholder="Phone number ID"
          value={phoneNumberId}
          onChange={(e) => setPhoneNumberId(e.target.value)}
          disabled={connecting}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="whatsapp-access-token" className="text-sm font-medium">
          Access Token
        </label>
        <Input
          id="whatsapp-access-token"
          type="password"
          placeholder="Permanent access token"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={connecting || !phoneNumberId.trim() || !accessToken.trim()}
      >
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Slack BYOT Form --

function SlackByotForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (botToken: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim()) {
      onConnect(token.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="slack-bot-token" className="text-sm font-medium">
          Bot Token
        </label>
        <p className="text-xs text-muted-foreground">
          Create a{" "}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Slack app
          </a>{" "}
          and copy the Bot User OAuth Token
        </p>
        <Input
          id="slack-bot-token"
          type="password"
          placeholder="xoxb-..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={connecting || !token.trim()}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Teams BYOT Form --

function TeamsByotForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (appId: string, appPassword: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [appId, setAppId] = useState("");
  const [appPassword, setAppPassword] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (appId.trim() && appPassword.trim()) {
      onConnect(appId.trim(), appPassword.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="teams-app-id" className="text-sm font-medium">
          App ID
        </label>
        <p className="text-xs text-muted-foreground">
          Create an{" "}
          <a
            href="https://dev.botframework.com/bots/new"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Azure Bot
          </a>{" "}
          and copy the App ID (client_id)
        </p>
        <Input
          id="teams-app-id"
          type="text"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          disabled={connecting}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="teams-app-password" className="text-sm font-medium">
          App Password
        </label>
        <Input
          id="teams-app-password"
          type="password"
          placeholder="App password (client_secret)"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={connecting || !appId.trim() || !appPassword.trim()}
      >
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Discord BYOT Form --

function DiscordByotForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (botToken: string, applicationId: string, publicKey: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [botToken, setBotToken] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [publicKey, setPublicKey] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (botToken.trim() && applicationId.trim() && publicKey.trim()) {
      onConnect(botToken.trim(), applicationId.trim(), publicKey.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="discord-bot-token" className="text-sm font-medium">
          Bot Token
        </label>
        <p className="text-xs text-muted-foreground">
          Create a{" "}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Discord application
          </a>{" "}
          and copy the bot token
        </p>
        <Input
          id="discord-bot-token"
          type="password"
          placeholder="Bot token"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          disabled={connecting}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="discord-app-id" className="text-sm font-medium">
          Application ID
        </label>
        <Input
          id="discord-app-id"
          type="text"
          placeholder="Application ID"
          value={applicationId}
          onChange={(e) => setApplicationId(e.target.value)}
          disabled={connecting}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="discord-public-key" className="text-sm font-medium">
          Public Key
        </label>
        <Input
          id="discord-public-key"
          type="text"
          placeholder="Public key (for interaction verification)"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          disabled={connecting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="submit"
        size="sm"
        disabled={
          connecting ||
          !botToken.trim() ||
          !applicationId.trim() ||
          !publicKey.trim()
        }
      >
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Disconnect Dialog (shared) --

function DisconnectDialog({
  name,
  description,
  onConfirm,
  disconnecting,
}: {
  name: string;
  description: string;
  onConfirm: () => void;
  disconnecting: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disconnecting}>
          {disconnecting && (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          )}
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// -- Webhook Card --

function WebhookCard({
  webhooks,
  isSaas,
}: {
  webhooks: WebhookStatus | undefined;
  isSaas: boolean;
}) {
  const count = webhooks?.activeCount ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Webhook className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">Webhooks</CardTitle>
          </div>
          <Badge variant={count ? "default" : "secondary"}>
            {count ? "Active" : "None"}
          </Badge>
        </div>
        <CardDescription>
          Outbound webhook delivery via scheduled tasks
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Active webhook tasks</p>
            <p className="text-2xl font-bold tabular-nums">{count}</p>
          </div>
          {isSaas && webhooks?.configurable && (
            <Button size="sm" variant="outline" asChild>
              <a href="/admin/scheduled-tasks">Create Webhook</a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// -- Helpers --

function ChannelIcon({ channel }: { channel: string }) {
  switch (channel) {
    case "slack":
      return <MessageSquare className="size-3" />;
    case "teams":
      return <Users className="size-3" />;
    case "discord":
      return <MessageCircle className="size-3" />;
    case "telegram":
      return <Send className="size-3" />;
    case "gchat":
      return <MessageSquareText className="size-3" />;
    case "github":
      return <GitBranch className="size-3" />;
    case "linear":
      return <BarChart3 className="size-3" />;
    case "whatsapp":
      return <Phone className="size-3" />;
    case "webhook":
      return <Webhook className="size-3" />;
    case "email":
      return <Mail className="size-3" />;
    default:
      return <Cable className="size-3" />;
  }
}
