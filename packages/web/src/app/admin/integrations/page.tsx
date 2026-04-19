"use client";

import { useState } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { IntegrationStatusSchema } from "@/ui/lib/admin-schemas";
import type {
  SlackStatus,
  TeamsStatus,
  DiscordStatus,
  TelegramStatus,
  GChatStatus,
  GitHubStatus,
  LinearStatus,
  WhatsAppStatus,
  EmailStatus,
  WebhookStatus,
} from "@useatlas/types";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import {
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
  SectionHeading,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
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
import Link from "next/link";
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
  Plus,
} from "lucide-react";

// -- Component --

export default function IntegrationsPage() {
  const { data, loading, error, refetch } =
    useAdminFetch("/api/v1/admin/integrations/status", { schema: IntegrationStatusSchema });

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
  const emailStatus = data?.email;
  const webhooks = data?.webhooks;
  const deliveryChannels = data?.deliveryChannels ?? [];

  const stats = !data
    ? { live: 0, total: 0 }
    : (() => {
        const rows: Array<{ connected: boolean; usable: boolean }> = [
          { connected: slack?.connected ?? false, usable: (slack?.configurable ?? false) || hasDB },
          { connected: teams?.connected ?? false, usable: (teams?.configurable ?? false) || hasDB },
          { connected: discord?.connected ?? false, usable: (discord?.configurable ?? false) || hasDB },
          { connected: telegram?.connected ?? false, usable: telegram?.configurable ?? false },
          { connected: gchat?.connected ?? false, usable: gchat?.configurable ?? false },
          { connected: whatsapp?.connected ?? false, usable: whatsapp?.configurable ?? false },
          { connected: github?.connected ?? false, usable: github?.configurable ?? false },
          { connected: linear?.connected ?? false, usable: linear?.configurable ?? false },
          { connected: emailStatus?.connected ?? false, usable: emailStatus?.configurable ?? false },
          { connected: (webhooks?.activeCount ?? 0) > 0, usable: webhooks?.configurable ?? false },
        ];
        return {
          live: rows.filter((r) => r.connected).length,
          total: rows.filter((r) => r.connected || r.usable).length,
        };
      })();

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Hero */}
      <header className="mb-10 flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Atlas · Admin
        </p>
        <div className="flex items-baseline justify-between gap-6">
          <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
          <p className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
            <span className={cn(stats.live > 0 ? "text-primary" : "text-muted-foreground")}>
              {String(stats.live).padStart(2, "0")}
            </span>
            <span className="opacity-50">{" / "}</span>
            {String(stats.total).padStart(2, "0")} live
          </p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          External platforms Atlas can read from, write to, or deliver through.
        </p>
      </header>

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
          <div className="space-y-10">
            {/* Messaging */}
            <section>
              <SectionHeading title="Messaging" description="Where Atlas listens and replies" />
              <div className="space-y-2">
                <SlackCard
                  slack={slack!}
                  isSaas={isSaas}
                  hasInternalDB={hasDB}
                  onDisconnect={handleDisconnect}
                  disconnecting={disconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(disconnectMutation.error)}
                  onByotConnect={handleSlackByot}
                  byotConnecting={slackByotMutation.saving}
                  byotError={friendlyErrorOrNull(slackByotMutation.error)}
                  onByotClearError={slackByotMutation.clearError}
                />
                <TeamsCard
                  teams={teams!}
                  isSaas={isSaas}
                  hasInternalDB={hasDB}
                  onDisconnect={handleTeamsDisconnect}
                  disconnecting={teamsDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(teamsDisconnectMutation.error)}
                  onByotConnect={handleTeamsByot}
                  byotConnecting={teamsByotMutation.saving}
                  byotError={friendlyErrorOrNull(teamsByotMutation.error)}
                  onByotClearError={teamsByotMutation.clearError}
                />
                <DiscordCard
                  discord={discord!}
                  isSaas={isSaas}
                  hasInternalDB={hasDB}
                  onDisconnect={handleDiscordDisconnect}
                  disconnecting={discordDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(discordDisconnectMutation.error)}
                  onByotConnect={handleDiscordByot}
                  byotConnecting={discordByotMutation.saving}
                  byotError={friendlyErrorOrNull(discordByotMutation.error)}
                  onByotClearError={discordByotMutation.clearError}
                />
                <TelegramCard
                  telegram={telegram!}
                  isSaas={isSaas}
                  onConnect={handleTelegramConnect}
                  connecting={telegramConnectMutation.saving}
                  connectError={friendlyErrorOrNull(telegramConnectMutation.error)}
                  onConnectClearError={telegramConnectMutation.clearError}
                  onDisconnect={handleTelegramDisconnect}
                  disconnecting={telegramDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(telegramDisconnectMutation.error)}
                />
                <GChatCard
                  gchat={gchat!}
                  onConnect={handleGChatConnect}
                  connecting={gchatConnectMutation.saving}
                  connectError={friendlyErrorOrNull(gchatConnectMutation.error)}
                  onConnectClearError={gchatConnectMutation.clearError}
                  onDisconnect={handleGChatDisconnect}
                  disconnecting={gchatDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(gchatDisconnectMutation.error)}
                />
                <WhatsAppCard
                  whatsapp={whatsapp!}
                  onConnect={handleWhatsAppConnect}
                  connecting={whatsappConnectMutation.saving}
                  connectError={friendlyErrorOrNull(whatsappConnectMutation.error)}
                  onConnectClearError={whatsappConnectMutation.clearError}
                  onDisconnect={handleWhatsAppDisconnect}
                  disconnecting={whatsappDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(whatsappDisconnectMutation.error)}
                />
              </div>
            </section>

            {/* Developer Tools */}
            <section>
              <SectionHeading title="Developer Tools" description="Source control and trackers Atlas can act on" />
              <div className="space-y-2">
                <GitHubCard
                  github={github!}
                  onConnect={handleGitHubConnect}
                  connecting={githubConnectMutation.saving}
                  connectError={friendlyErrorOrNull(githubConnectMutation.error)}
                  onConnectClearError={githubConnectMutation.clearError}
                  onDisconnect={handleGitHubDisconnect}
                  disconnecting={githubDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(githubDisconnectMutation.error)}
                />
                <LinearCard
                  linear={linear!}
                  onConnect={handleLinearConnect}
                  connecting={linearConnectMutation.saving}
                  connectError={friendlyErrorOrNull(linearConnectMutation.error)}
                  onConnectClearError={linearConnectMutation.clearError}
                  onDisconnect={handleLinearDisconnect}
                  disconnecting={linearDisconnectMutation.saving}
                  disconnectError={friendlyErrorOrNull(linearDisconnectMutation.error)}
                />
              </div>
            </section>

            {/* Notifications */}
            <section>
              <SectionHeading title="Notifications" description="Outbound channels for tasks and digests" />
              <div className="space-y-2">
                <EmailCard email={emailStatus!} />
                <WebhookCard webhooks={webhooks} isSaas={isSaas} />
              </div>
            </section>

            {/* Delivery Channels footer — only show if there are channels */}
            {deliveryChannels.length > 0 && (
              <section>
                <SectionHeading title="Delivery Channels" description="Currently available for task delivery" />
                <div className="flex flex-wrap items-center gap-2">
                  {deliveryChannels.map((channel) => (
                    <span
                      key={channel}
                      className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] capitalize text-foreground"
                    >
                      <ChannelIcon channel={channel} />
                      {channel}
                    </span>
                  ))}
                </div>
              </section>
            )}
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
  onByotClearError,
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
  onByotClearError: () => void;
}) {
  const canConnect = slack.configurable;
  const canByot = !canConnect && hasInternalDB;
  const status: StatusKind = slack.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: slack.connected, onCollapseCleanup: onByotClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={MessageSquare}
        title="Slack"
        description={
          status === "unavailable"
            ? isSaas
              ? "Unavailable — ask your administrator"
              : "Requires SLACK_CLIENT_ID or DATABASE_URL"
            : "/atlas commands and thread follow-ups"
        }
        status={status}
        action={
          canConnect ? (
            <Button size="sm" asChild>
              <a href="/api/v1/slack/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect
              </a>
            </Button>
          ) : canByot ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add token
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={MessageSquare}
      title="Slack"
      description="/atlas commands and thread follow-ups"
      status={status}
      onCollapse={!slack.connected ? collapse : undefined}
      actions={
        <>
          {slack.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Slack"
              description="This will remove the Slack connection for this workspace. The /atlas command and thread follow-ups will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
          {slack.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/slack/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </>
      }
    >
      {slack.connected && (
        <DetailList>
          {slack.workspaceName && (
            <DetailRow label="Workspace" value={slack.workspaceName} truncate />
          )}
          {slack.teamId && slack.teamId !== "env" && (
            <DetailRow label="Team ID" value={slack.teamId} mono truncate />
          )}
          {slack.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(slack.installedAt)} />
          )}
          {!isSaas && slack.envConfigured && !slack.oauthConfigured && (
            <div className="pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Using <code className="rounded bg-muted px-1 font-mono">SLACK_BOT_TOKEN</code>.
              Add OAuth credentials for self-serve management.
            </div>
          )}
        </DetailList>
      )}

      {!slack.connected && canByot && (
        <SlackByotForm
          onConnect={onByotConnect}
          connecting={byotConnecting}
          error={byotError}
        />
      )}

      <InlineError>{disconnectError}</InlineError>
    </Shell>
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
  onByotClearError,
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
  onByotClearError: () => void;
}) {
  const canConnect = teams.configurable;
  const canByot = !canConnect && hasInternalDB;
  const status: StatusKind = teams.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: teams.connected, onCollapseCleanup: onByotClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={Users}
        title="Microsoft Teams"
        description={
          status === "unavailable"
            ? isSaas
              ? "Unavailable — ask your administrator"
              : "Requires TEAMS_APP_ID or DATABASE_URL"
            : "@atlas mentions and channel conversations"
        }
        status={status}
        action={
          canConnect ? (
            <Button size="sm" asChild>
              <a href="/api/v1/teams/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect
              </a>
            </Button>
          ) : canByot ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add app
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Users}
      title="Microsoft Teams"
      description="@atlas mentions and channel conversations"
      status={status}
      onCollapse={!teams.connected ? collapse : undefined}
      actions={
        <>
          {teams.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Microsoft Teams"
              description="This will remove the Teams connection for this tenant. The @atlas mentions and channel conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
          {teams.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/teams/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </>
      }
    >
      {teams.connected && (
        <DetailList>
          {teams.tenantName && <DetailRow label="Tenant" value={teams.tenantName} truncate />}
          {teams.tenantId && <DetailRow label="Tenant ID" value={teams.tenantId} mono truncate />}
          {teams.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(teams.installedAt)} />
          )}
        </DetailList>
      )}

      {!teams.connected && canByot && (
        <TeamsByotForm
          onConnect={onByotConnect}
          connecting={byotConnecting}
          error={byotError}
        />
      )}

      <InlineError>{disconnectError}</InlineError>
    </Shell>
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
  onByotClearError,
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
  onByotClearError: () => void;
}) {
  const canConnect = discord.configurable;
  const canByot = !canConnect && hasInternalDB;
  const status: StatusKind = discord.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: discord.connected, onCollapseCleanup: onByotClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={MessageCircle}
        title="Discord"
        description={
          status === "unavailable"
            ? isSaas
              ? "Unavailable — ask your administrator"
              : "Requires DISCORD_CLIENT_ID or DATABASE_URL"
            : "Bot commands and server conversations"
        }
        status={status}
        action={
          canConnect ? (
            <Button size="sm" asChild>
              <a href="/api/v1/discord/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Connect
              </a>
            </Button>
          ) : canByot ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add bot
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={MessageCircle}
      title="Discord"
      description="Bot commands and server conversations"
      status={status}
      onCollapse={!discord.connected ? collapse : undefined}
      actions={
        <>
          {discord.connected && (canConnect || canByot) && (
            <DisconnectDialog
              name="Discord"
              description="This will remove the Discord connection for this server. The bot commands and conversations will stop working until you reconnect."
              onConfirm={onDisconnect}
              disconnecting={disconnecting}
            />
          )}
          {discord.connected && canConnect && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/v1/discord/install">
                <ExternalLink className="mr-1.5 size-3.5" />
                Reconnect
              </a>
            </Button>
          )}
        </>
      }
    >
      {discord.connected && (
        <DetailList>
          {discord.guildName && <DetailRow label="Server" value={discord.guildName} truncate />}
          {discord.guildId && <DetailRow label="Guild ID" value={discord.guildId} mono truncate />}
          {discord.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(discord.installedAt)} />
          )}
        </DetailList>
      )}

      {!discord.connected && canByot && (
        <DiscordByotForm
          onConnect={onByotConnect}
          connecting={byotConnecting}
          error={byotError}
        />
      )}

      <InlineError>{disconnectError}</InlineError>
    </Shell>
  );
}

// -- Telegram Card --

function TelegramCard({
  telegram,
  isSaas,
  onConnect,
  connecting,
  connectError,
  onConnectClearError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  telegram: TelegramStatus;
  isSaas: boolean;
  onConnect: (botToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onConnectClearError: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = telegram.configurable;
  const status: StatusKind = telegram.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: telegram.connected, onCollapseCleanup: onConnectClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={Send}
        title="Telegram"
        description={
          status === "unavailable"
            ? isSaas
              ? "Unavailable — ask your administrator"
              : "Requires DATABASE_URL"
            : "Telegram bot for chat conversations"
        }
        status={status}
        action={
          canConnect ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add bot
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Send}
      title="Telegram"
      description="Telegram bot for chat conversations"
      status={status}
      onCollapse={!telegram.connected ? collapse : undefined}
      actions={
        telegram.connected && canConnect ? (
          <DisconnectDialog
            name="Telegram"
            description="This will remove the Telegram bot connection for this workspace. Bot conversations will stop working until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {telegram.connected && (
        <DetailList>
          {telegram.botUsername && (
            <DetailRow label="Bot" value={`@${telegram.botUsername}`} truncate />
          )}
          {telegram.botId && <DetailRow label="Bot ID" value={telegram.botId} mono truncate />}
          {telegram.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(telegram.installedAt)} />
          )}
        </DetailList>
      )}

      {!telegram.connected && canConnect && (
        <TelegramConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (telegram.connected ? connectError : null)}</InlineError>
    </Shell>
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
  onConnectClearError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  gchat: GChatStatus;
  onConnect: (credentialsJson: string) => void;
  connecting: boolean;
  connectError: string | null;
  onConnectClearError: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = gchat.configurable;
  const status: StatusKind = gchat.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: gchat.connected, onCollapseCleanup: onConnectClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={MessageSquareText}
        title="Google Chat"
        description={
          status === "unavailable"
            ? "Requires DATABASE_URL"
            : "Bot conversations in Google Workspace"
        }
        status={status}
        action={
          canConnect ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add credentials
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={MessageSquareText}
      title="Google Chat"
      description="Bot conversations in Google Workspace"
      status={status}
      onCollapse={!gchat.connected ? collapse : undefined}
      actions={
        gchat.connected && canConnect ? (
          <DisconnectDialog
            name="Google Chat"
            description="This will remove the Google Chat connection for this workspace. Bot conversations will stop working until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {gchat.connected && (
        <DetailList>
          {gchat.serviceAccountEmail && (
            <DetailRow
              label="Service Account"
              value={gchat.serviceAccountEmail}
              mono
              truncate
            />
          )}
          {gchat.projectId && (
            <DetailRow label="Project ID" value={gchat.projectId} mono truncate />
          )}
          {gchat.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(gchat.installedAt)} />
          )}
        </DetailList>
      )}

      {!gchat.connected && canConnect && (
        <GChatConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (gchat.connected ? connectError : null)}</InlineError>
    </Shell>
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
  onConnectClearError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  github: GitHubStatus;
  onConnect: (accessToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onConnectClearError: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = github.configurable;
  const status: StatusKind = github.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: github.connected, onCollapseCleanup: onConnectClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={GitBranch}
        title="GitHub"
        description={
          status === "unavailable"
            ? "Requires DATABASE_URL"
            : "Issue tracking and repository integration"
        }
        status={status}
        action={
          canConnect ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add token
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={GitBranch}
      title="GitHub"
      description="Issue tracking and repository integration"
      status={status}
      onCollapse={!github.connected ? collapse : undefined}
      actions={
        github.connected && canConnect ? (
          <DisconnectDialog
            name="GitHub"
            description="This will remove the GitHub connection for this workspace. GitHub integration functionality will stop working until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {github.connected && (
        <DetailList>
          {github.username && <DetailRow label="User" value={`@${github.username}`} truncate />}
          {github.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(github.installedAt)} />
          )}
        </DetailList>
      )}

      {!github.connected && canConnect && (
        <GitHubConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (github.connected ? connectError : null)}</InlineError>
    </Shell>
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
  onConnectClearError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  linear: LinearStatus;
  onConnect: (apiKey: string) => void;
  connecting: boolean;
  connectError: string | null;
  onConnectClearError: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = linear.configurable;
  const status: StatusKind = linear.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: linear.connected, onCollapseCleanup: onConnectClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={BarChart3}
        title="Linear"
        description={
          status === "unavailable"
            ? "Requires DATABASE_URL"
            : "Issue tracking and project management"
        }
        status={status}
        action={
          canConnect ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add API key
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={BarChart3}
      title="Linear"
      description="Issue tracking and project management"
      status={status}
      onCollapse={!linear.connected ? collapse : undefined}
      actions={
        linear.connected && canConnect ? (
          <DisconnectDialog
            name="Linear"
            description="This will remove the Linear connection for this workspace. Issue tracking integration will stop working until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {linear.connected && (
        <DetailList>
          {linear.userName && <DetailRow label="User" value={linear.userName} truncate />}
          {linear.userEmail && <DetailRow label="Email" value={linear.userEmail} mono truncate />}
          {linear.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(linear.installedAt)} />
          )}
        </DetailList>
      )}

      {!linear.connected && canConnect && (
        <LinearConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (linear.connected ? connectError : null)}</InlineError>
    </Shell>
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
  onConnectClearError,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  whatsapp: WhatsAppStatus;
  onConnect: (phoneNumberId: string, accessToken: string) => void;
  connecting: boolean;
  connectError: string | null;
  onConnectClearError: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = whatsapp.configurable;
  const status: StatusKind = whatsapp.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } =
    useDisclosure({ collapseOn: whatsapp.connected, onCollapseCleanup: onConnectClearError });
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={Phone}
        title="WhatsApp"
        description={
          status === "unavailable"
            ? "Requires DATABASE_URL"
            : "Messaging and notification delivery"
        }
        status={status}
        action={
          canConnect ? (
            <Button
              ref={triggerRef}
              size="sm"
              variant="outline"
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              <Plus className="mr-1.5 size-3.5" />
              Add phone
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <Shell
      id={panelId}
      panelRef={panelRef}
      icon={Phone}
      title="WhatsApp"
      description="Messaging and notification delivery"
      status={status}
      onCollapse={!whatsapp.connected ? collapse : undefined}
      actions={
        whatsapp.connected && canConnect ? (
          <DisconnectDialog
            name="WhatsApp"
            description="This will remove the WhatsApp connection for this workspace. WhatsApp messaging will stop working until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {whatsapp.connected && (
        <DetailList>
          {whatsapp.displayPhone && (
            <DetailRow label="Phone" value={whatsapp.displayPhone} mono truncate />
          )}
          {whatsapp.phoneNumberId && (
            <DetailRow
              label="Phone Number ID"
              value={whatsapp.phoneNumberId}
              mono
              truncate
            />
          )}
          {whatsapp.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(whatsapp.installedAt)} />
          )}
        </DetailList>
      )}

      {!whatsapp.connected && canConnect && (
        <WhatsAppConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (whatsapp.connected ? connectError : null)}</InlineError>
    </Shell>
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


// -- Email Card --

const EMAIL_PROVIDER_LABEL: Record<string, string> = {
  resend: "Resend",
  sendgrid: "SendGrid",
  postmark: "Postmark",
  smtp: "SMTP",
  ses: "Amazon SES",
};

/**
 * Thin email summary card. Email delivery is configured on the dedicated
 * /admin/email-provider page — this tile just exposes connection status and
 * deep-links to the manager so admins don't have to hunt for it.
 */
function EmailCard({ email }: { email: EmailStatus }) {
  const connected = email.connected;
  const providerLabel = email.provider
    ? EMAIL_PROVIDER_LABEL[email.provider] ?? email.provider
    : null;
  return (
    <CompactRow
      icon={Mail}
      title="Email"
      description={
        connected
          ? `${providerLabel ?? "Custom"} · ${email.senderAddress ?? "workspace sender"}`
          : "Using the Atlas shared Resend default"
      }
      status={connected ? "connected" : "disconnected"}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/email-provider">Manage</Link>
        </Button>
      }
    />
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
  const status: StatusKind = count > 0
    ? "connected"
    : webhooks?.configurable
    ? "disconnected"
    : "unavailable";

  // Webhooks are always compact — management lives on the scheduled-tasks page.
  return (
    <CompactRow
      icon={Webhook}
      title="Webhooks"
      description={
        count > 0
          ? `${count} active task${count === 1 ? "" : "s"} delivering to HTTPS endpoints`
          : status === "unavailable"
          ? "Unavailable on this workspace"
          : "Scheduled tasks deliver query results to HTTPS endpoints"
      }
      status={status}
      action={
        isSaas && webhooks?.configurable ? (
          <Button size="sm" variant="outline" asChild>
            <a href="/admin/scheduled-tasks">
              <ExternalLink className="mr-1.5 size-3.5" />
              Manage
            </a>
          </Button>
        ) : null
      }
    />
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
