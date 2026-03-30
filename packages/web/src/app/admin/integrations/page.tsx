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
import {
  Cable,
  MessageSquare,
  MessageCircle,
  Send,
  Users,
  Webhook,
  Mail,
  Loader2,
  ExternalLink,
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

  const isSaas = data?.deployMode === "saas";
  const hasDB = data?.hasInternalDB ?? false;
  const slack = data?.slack;
  const teams = data?.teams;
  const discord = data?.discord;
  const telegram = data?.telegram;
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
    case "webhook":
      return <Webhook className="size-3" />;
    case "email":
      return <Mail className="size-3" />;
    default:
      return <Cable className="size-3" />;
  }
}
