"use client";

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
import {
  Cable,
  MessageSquare,
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

interface WebhookStatus {
  activeCount: number;
  /** Whether the workspace admin can create/manage webhooks */
  configurable: boolean;
}

interface IntegrationStatus {
  slack: SlackStatus;
  teams?: TeamsStatus;
  webhooks: WebhookStatus;
  deliveryChannels: DeliveryChannel[];
  deployMode: "saas" | "self-hosted";
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

  async function handleDisconnect() {
    await disconnectMutation.mutate({});
  }

  async function handleTeamsDisconnect() {
    await teamsDisconnectMutation.mutate({});
  }

  const isSaas = data?.deployMode === "saas";
  const slack = data?.slack;
  const teams = data?.teams;
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
              onDisconnect={handleDisconnect}
              disconnecting={disconnectMutation.saving}
              disconnectError={disconnectMutation.error}
            />

            {/* Teams card — only render when API includes teams data */}
            {teams && (
              <TeamsCard
                teams={teams}
                isSaas={isSaas}
                onDisconnect={handleTeamsDisconnect}
                disconnecting={teamsDisconnectMutation.saving}
                disconnectError={teamsDisconnectMutation.error}
              />
            )}

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
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  slack: SlackStatus;
  isSaas: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = slack.configurable;

  // Status badge: Connected / Not Available (SaaS only) / Disconnected
  const statusBadge = slack.connected ? (
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
            {/* Only show env var hint in self-hosted mode */}
            {!isSaas && slack.envConfigured && !slack.oauthConfigured && (
              <p className="text-xs text-muted-foreground">
                Using environment variable (SLACK_BOT_TOKEN). Configure OAuth
                credentials for self-serve management.
              </p>
            )}
          </div>
        )}

        {/* Not connected: SaaS vs self-hosted messaging */}
        {!slack.connected && !canConnect && (
          isSaas ? (
            <p className="text-sm text-muted-foreground">
              Slack integration is not available. Contact your administrator.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_ID</code>{" "}
              and <code className="rounded bg-muted px-1 text-xs">SLACK_CLIENT_SECRET</code>{" "}
              to enable Slack OAuth.
            </p>
          )
        )}

        {disconnectError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError}
          </div>
        )}

        <div className="flex gap-2">
          {slack.connected && canConnect && (
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
                  <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the Slack connection for this workspace.
                    The /atlas command and thread follow-ups will stop working
                    until you reconnect.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDisconnect}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  teams: TeamsStatus;
  isSaas: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = teams.configurable;

  // Status badge: Connected / Not Available (SaaS only) / Disconnected
  const statusBadge = teams.connected ? (
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
            {/* Only show env var hint in self-hosted mode */}
            {!isSaas && (
              <p className="text-xs text-muted-foreground">
                Using environment variables (TEAMS_APP_ID, TEAMS_APP_PASSWORD).
              </p>
            )}
          </div>
        )}

        {/* Not connected: SaaS vs self-hosted messaging */}
        {!teams.connected && !canConnect && (
          isSaas ? (
            <p className="text-sm text-muted-foreground">
              Teams integration is not available. Contact your administrator.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set{" "}
              <code className="rounded bg-muted px-1 text-xs">TEAMS_APP_ID</code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 text-xs">
                TEAMS_APP_PASSWORD
              </code>{" "}
              to enable Microsoft Teams integration.
            </p>
          )
        )}

        {disconnectError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {disconnectError}
          </div>
        )}

        <div className="flex gap-2">
          {teams.connected && canConnect && (
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
                  <AlertDialogTitle>Disconnect Microsoft Teams?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the Teams connection for this tenant. The
                    @atlas mentions and channel conversations will stop working
                    until you reconnect.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDisconnect}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!teams.connected && canConnect && isSaas && (
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
    case "webhook":
      return <Webhook className="size-3" />;
    case "email":
      return <Mail className="size-3" />;
    default:
      return <Cable className="size-3" />;
  }
}
