"use client";

import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { IntegrationStatusSchema } from "@/ui/lib/admin-schemas";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { ErrorBoundary } from "@/ui/components/error-boundary";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  X,
} from "lucide-react";

// -- Types (used by child components for props) --

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

interface EmailStatus {
  connected: boolean;
  provider: string | null;
  senderAddress: string | null;
  installedAt: string | null;
  configurable: boolean;
}

interface WebhookStatus {
  activeCount: number;
  /** Whether the workspace admin can create/manage webhooks */
  configurable: boolean;
}

// -- Shared Design Primitives --

type StatusKind = "connected" | "disconnected" | "unavailable";

function StatusDot({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" && "bg-primary shadow-[0_0_0_3px_var(--primary)]/15",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" && "bg-muted-foreground/20 outline outline-1 outline-dashed outline-muted-foreground/30",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

/**
 * Unified integration card — used when connected or when the user has
 * chosen to expand a disconnected integration to configure it. The visual
 * treatment comes from status: connected rows get a subtle teal left-edge
 * and a "Live" label; the disconnected-expanded state shows a close button.
 */
function IntegrationShell({
  icon: Icon,
  title,
  description,
  status,
  statusText,
  children,
  actions,
  onCollapse,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  statusText?: string;
  children?: ReactNode;
  actions?: ReactNode;
  onCollapse?: () => void;
}) {
  return (
    <section
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 backdrop-blur-[1px] transition-colors",
        "hover:border-border/80",
        status === "connected" && "border-primary/20",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}

      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status !== "connected" && "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {/* Only show status text when connected — reduces noise in the
                disconnected-expanded state while user is mid-setup. */}
            {status === "connected" && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                <StatusDot kind="connected" />
                {statusText ?? "Live"}
              </span>
            )}
            {status !== "connected" && onCollapse && (
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCollapse}
                className="ml-auto -m-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
      </header>

      {children != null && (
        <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>
      )}

      {actions && (
        <footer className="flex items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

/**
 * Compact row for disconnected / unavailable integrations. Thin single-line
 * presentation with a trailing action slot. Dramatically reduces visual
 * weight when many integrations are not yet configured.
 */
function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: StatusKind;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "unavailable" && "opacity-60",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </h3>
          <StatusDot kind={status} className="shrink-0" />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Key-value row used inside IntegrationShell for "spec sheet" details.
 * Value is monospaced when `mono` is true (for IDs, hashes, etc).
 */
function DetailRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate",
          !mono && "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DetailList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-1.5 divide-y divide-border/50">
      {children}
    </div>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

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

  const emailConnectMutation = useAdminMutation<{
    message: string;
    provider: string;
    senderAddress: string;
  }>({
    path: "/api/v1/admin/integrations/email",
    method: "POST",
    invalidates: refetch,
  });

  const emailTestMutation = useAdminMutation<{
    message: string;
    success: boolean;
  }>({
    path: "/api/v1/admin/integrations/email/test",
    method: "POST",
    invalidates: refetch,
  });

  const emailDisconnectMutation = useAdminMutation<{ message: string }>({
    path: "/api/v1/admin/integrations/email",
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

  async function handleEmailConnect(provider: string, senderAddress: string, config: Record<string, unknown>) {
    await emailConnectMutation.mutate({ body: { provider, senderAddress, config } });
  }

  async function handleEmailTest(recipientEmail: string) {
    await emailTestMutation.mutate({ body: { recipientEmail } });
  }

  async function handleEmailDisconnect() {
    await emailDisconnectMutation.mutate({});
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

  const stats = useMemo(() => {
    if (!data) return { live: 0, total: 0 };
    const entries: Array<{ connected: boolean; configurable: boolean; byotOk?: boolean }> = [
      { connected: slack?.connected ?? false, configurable: slack?.configurable ?? false, byotOk: hasDB },
      { connected: teams?.connected ?? false, configurable: teams?.configurable ?? false, byotOk: hasDB },
      { connected: discord?.connected ?? false, configurable: discord?.configurable ?? false, byotOk: hasDB },
      { connected: telegram?.connected ?? false, configurable: telegram?.configurable ?? false },
      { connected: gchat?.connected ?? false, configurable: gchat?.configurable ?? false },
      { connected: whatsapp?.connected ?? false, configurable: whatsapp?.configurable ?? false },
      { connected: github?.connected ?? false, configurable: github?.configurable ?? false },
      { connected: linear?.connected ?? false, configurable: linear?.configurable ?? false },
      { connected: emailStatus?.connected ?? false, configurable: emailStatus?.configurable ?? false },
      { connected: (webhooks?.activeCount ?? 0) > 0, configurable: webhooks?.configurable ?? false },
    ];
    const live = entries.filter((e) => e.connected).length;
    const total = entries.filter((e) => e.configurable || e.byotOk || e.connected).length;
    return { live, total };
  }, [data, slack, teams, discord, telegram, gchat, github, linear, whatsapp, emailStatus, webhooks, hasDB]);

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
                  disconnectError={disconnectMutation.error}
                  onByotConnect={handleSlackByot}
                  byotConnecting={slackByotMutation.saving}
                  byotError={slackByotMutation.error}
                />
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
                <GChatCard
                  gchat={gchat!}
                  onConnect={handleGChatConnect}
                  connecting={gchatConnectMutation.saving}
                  connectError={gchatConnectMutation.error}
                  onDisconnect={handleGChatDisconnect}
                  disconnecting={gchatDisconnectMutation.saving}
                  disconnectError={gchatDisconnectMutation.error}
                />
                <WhatsAppCard
                  whatsapp={whatsapp!}
                  onConnect={handleWhatsAppConnect}
                  connecting={whatsappConnectMutation.saving}
                  connectError={whatsappConnectMutation.error}
                  onDisconnect={handleWhatsAppDisconnect}
                  disconnecting={whatsappDisconnectMutation.saving}
                  disconnectError={whatsappDisconnectMutation.error}
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
                  connectError={githubConnectMutation.error}
                  onDisconnect={handleGitHubDisconnect}
                  disconnecting={githubDisconnectMutation.saving}
                  disconnectError={githubDisconnectMutation.error}
                />
                <LinearCard
                  linear={linear!}
                  onConnect={handleLinearConnect}
                  connecting={linearConnectMutation.saving}
                  connectError={linearConnectMutation.error}
                  onDisconnect={handleLinearDisconnect}
                  disconnecting={linearDisconnectMutation.saving}
                  disconnectError={linearDisconnectMutation.error}
                />
              </div>
            </section>

            {/* Notifications */}
            <section>
              <SectionHeading title="Notifications" description="Outbound channels for tasks and digests" />
              <div className="space-y-2">
                <EmailCard
                  email={emailStatus!}
                  onConnect={handleEmailConnect}
                  connecting={emailConnectMutation.saving}
                  connectError={emailConnectMutation.error}
                  onTest={handleEmailTest}
                  testing={emailTestMutation.saving}
                  testResult={emailTestMutation.error}
                  onDisconnect={handleEmailDisconnect}
                  disconnecting={emailDisconnectMutation.saving}
                  disconnectError={emailDisconnectMutation.error}
                />
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
  const status: StatusKind = slack.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add token
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={MessageSquare}
      title="Slack"
      description="/atlas commands and thread follow-ups"
      status={status}
      onCollapse={!slack.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = teams.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add app
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={Users}
      title="Microsoft Teams"
      description="@atlas mentions and channel conversations"
      status={status}
      onCollapse={!teams.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = discord.connected
    ? "connected"
    : !canConnect && !canByot
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add bot
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={MessageCircle}
      title="Discord"
      description="Bot commands and server conversations"
      status={status}
      onCollapse={!discord.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = telegram.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add bot
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={Send}
      title="Telegram"
      description="Telegram bot for chat conversations"
      status={status}
      onCollapse={!telegram.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = gchat.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add credentials
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={MessageSquareText}
      title="Google Chat"
      description="Bot conversations in Google Workspace"
      status={status}
      onCollapse={!gchat.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = github.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add token
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={GitBranch}
      title="GitHub"
      description="Issue tracking and repository integration"
      status={status}
      onCollapse={!github.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = linear.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add API key
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={BarChart3}
      title="Linear"
      description="Issue tracking and project management"
      status={status}
      onCollapse={!linear.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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
  const status: StatusKind = whatsapp.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const [expanded, setExpanded] = useState(false);
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
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add phone
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={Phone}
      title="WhatsApp"
      description="Messaging and notification delivery"
      status={status}
      onCollapse={!whatsapp.connected ? () => setExpanded(false) : undefined}
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
    </IntegrationShell>
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

// -- Email Card --

function EmailCard({
  email,
  onConnect,
  connecting,
  connectError,
  onTest,
  testing,
  testResult,
  onDisconnect,
  disconnecting,
  disconnectError,
}: {
  email: EmailStatus;
  onConnect: (provider: string, senderAddress: string, config: Record<string, unknown>) => void;
  connecting: boolean;
  connectError: string | null;
  onTest: (recipientEmail: string) => void;
  testing: boolean;
  testResult: string | null;
  onDisconnect: () => void;
  disconnecting: boolean;
  disconnectError: string | null;
}) {
  const canConnect = email.configurable;
  const status: StatusKind = email.connected
    ? "connected"
    : !canConnect
    ? "unavailable"
    : "disconnected";

  const providerLabel: Record<string, string> = {
    smtp: "SMTP",
    sendgrid: "SendGrid",
    postmark: "Postmark",
    ses: "Amazon SES",
    resend: "Resend",
  };

  const [expanded, setExpanded] = useState(false);
  const showFull = status === "connected" || expanded;

  if (!showFull) {
    return (
      <CompactRow
        icon={Mail}
        title="Email"
        description={
          status === "unavailable"
            ? "Requires DATABASE_URL"
            : "Delivery for digests and notifications"
        }
        status={status}
        action={
          canConnect ? (
            <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add provider
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <IntegrationShell
      icon={Mail}
      title="Email"
      description="Delivery for digests and notifications"
      status={status}
      onCollapse={!email.connected ? () => setExpanded(false) : undefined}
      actions={
        email.connected && canConnect ? (
          <DisconnectDialog
            name="Email"
            description="This will remove the email configuration for this workspace. Email delivery will fall back to environment variables or be disabled until you reconnect."
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        ) : null
      }
    >
      {email.connected && (
        <DetailList>
          {email.provider && (
            <DetailRow
              label="Provider"
              value={providerLabel[email.provider] ?? email.provider}
            />
          )}
          {email.senderAddress && (
            <DetailRow label="Sender" value={email.senderAddress} mono truncate />
          )}
          {email.installedAt && (
            <DetailRow label="Connected" value={formatDateTime(email.installedAt)} />
          )}
        </DetailList>
      )}

      {email.connected && canConnect && (
        <EmailTestForm onTest={onTest} testing={testing} testResult={testResult} />
      )}

      {!email.connected && canConnect && (
        <EmailConnectForm
          onConnect={onConnect}
          connecting={connecting}
          error={connectError}
        />
      )}

      <InlineError>{disconnectError ?? (email.connected ? connectError : null)}</InlineError>
    </IntegrationShell>
  );
}

// -- Email Connect Form --

type EmailProviderKey = "smtp" | "sendgrid" | "postmark" | "ses" | "resend";

function EmailConnectForm({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (provider: string, senderAddress: string, config: Record<string, unknown>) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [provider, setProvider] = useState<EmailProviderKey | "">("");
  const [senderAddress, setSenderAddress] = useState("");

  // SMTP fields
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpTls, setSmtpTls] = useState(true);

  // SendGrid fields
  const [sgApiKey, setSgApiKey] = useState("");

  // Postmark fields
  const [pmServerToken, setPmServerToken] = useState("");

  // SES fields
  const [sesRegion, setSesRegion] = useState("");
  const [sesAccessKeyId, setSesAccessKeyId] = useState("");
  const [sesSecretAccessKey, setSesSecretAccessKey] = useState("");

  // Resend fields
  const [resendApiKey, setResendApiKey] = useState("");

  function buildConfig(): Record<string, unknown> | null {
    switch (provider) {
      case "smtp":
        if (!smtpHost || !smtpUsername || !smtpPassword) return null;
        return { host: smtpHost, port: parseInt(smtpPort, 10) || 587, username: smtpUsername, password: smtpPassword, tls: smtpTls };
      case "sendgrid":
        if (!sgApiKey) return null;
        return { apiKey: sgApiKey };
      case "postmark":
        if (!pmServerToken) return null;
        return { serverToken: pmServerToken };
      case "ses":
        if (!sesRegion || !sesAccessKeyId || !sesSecretAccessKey) return null;
        return { region: sesRegion, accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey };
      case "resend":
        if (!resendApiKey) return null;
        return { apiKey: resendApiKey };
      default:
        return null;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const config = buildConfig();
    if (provider && senderAddress.trim() && config) {
      onConnect(provider, senderAddress.trim(), config);
    }
  }

  const config = buildConfig();
  const canSubmit = !!provider && !!senderAddress.trim() && !!config && !connecting;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="email-provider" className="text-sm font-medium">
          Provider
        </label>
        <Select value={provider} onValueChange={(v) => setProvider(v as EmailProviderKey)}>
          <SelectTrigger id="email-provider">
            <SelectValue placeholder="Select email provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="smtp">SMTP</SelectItem>
            <SelectItem value="sendgrid">SendGrid</SelectItem>
            <SelectItem value="postmark">Postmark</SelectItem>
            <SelectItem value="ses">Amazon SES</SelectItem>
            <SelectItem value="resend">Resend</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="email-sender" className="text-sm font-medium">
          Sender Address
        </label>
        <Input
          id="email-sender"
          type="email"
          placeholder="noreply@example.com"
          value={senderAddress}
          onChange={(e) => setSenderAddress(e.target.value)}
          disabled={connecting}
        />
      </div>

      {provider === "smtp" && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="smtp-host" className="text-sm font-medium">Host</label>
            <Input id="smtp-host" placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="smtp-port" className="text-sm font-medium">Port</label>
            <Input id="smtp-port" type="number" placeholder="587" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="smtp-username" className="text-sm font-medium">Username</label>
            <Input id="smtp-username" placeholder="username" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="smtp-password" className="text-sm font-medium">Password</label>
            <Input id="smtp-password" type="password" placeholder="Password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} disabled={connecting} />
          </div>
          <div className="flex items-center gap-2">
            <input id="smtp-tls" type="checkbox" checked={smtpTls} onChange={(e) => setSmtpTls(e.target.checked)} disabled={connecting} className="size-4 rounded border-input" />
            <label htmlFor="smtp-tls" className="text-sm">Use TLS</label>
          </div>
        </>
      )}

      {provider === "sendgrid" && (
        <div className="space-y-1.5">
          <label htmlFor="sg-api-key" className="text-sm font-medium">API Key</label>
          <p className="text-xs text-muted-foreground">
            From your{" "}
            <a href="https://app.sendgrid.com/settings/api_keys" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              SendGrid dashboard
            </a>
          </p>
          <Input id="sg-api-key" type="password" placeholder="SG...." value={sgApiKey} onChange={(e) => setSgApiKey(e.target.value)} disabled={connecting} />
        </div>
      )}

      {provider === "postmark" && (
        <div className="space-y-1.5">
          <label htmlFor="pm-server-token" className="text-sm font-medium">Server Token</label>
          <p className="text-xs text-muted-foreground">
            From your{" "}
            <a href="https://account.postmarkapp.com/servers" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Postmark server settings
            </a>
          </p>
          <Input id="pm-server-token" type="password" placeholder="Server token" value={pmServerToken} onChange={(e) => setPmServerToken(e.target.value)} disabled={connecting} />
        </div>
      )}

      {provider === "ses" && (
        <>
          <div className="space-y-1.5">
            <label htmlFor="ses-region" className="text-sm font-medium">AWS Region</label>
            <Input id="ses-region" placeholder="us-east-1" value={sesRegion} onChange={(e) => setSesRegion(e.target.value)} disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ses-access-key" className="text-sm font-medium">Access Key ID</label>
            <Input id="ses-access-key" placeholder="AKIA..." value={sesAccessKeyId} onChange={(e) => setSesAccessKeyId(e.target.value)} disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ses-secret-key" className="text-sm font-medium">Secret Access Key</label>
            <Input id="ses-secret-key" type="password" placeholder="Secret key" value={sesSecretAccessKey} onChange={(e) => setSesSecretAccessKey(e.target.value)} disabled={connecting} />
          </div>
        </>
      )}

      {provider === "resend" && (
        <div className="space-y-1.5">
          <label htmlFor="resend-api-key" className="text-sm font-medium">API Key</label>
          <p className="text-xs text-muted-foreground">
            From your{" "}
            <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Resend dashboard
            </a>
          </p>
          <Input id="resend-api-key" type="password" placeholder="re_..." value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} disabled={connecting} />
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" size="sm" disabled={!canSubmit}>
        {connecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}

// -- Email Test Form --

function EmailTestForm({
  onTest,
  testing,
  testResult,
}: {
  onTest: (recipientEmail: string) => void;
  testing: boolean;
  testResult: string | null;
}) {
  const [recipientEmail, setRecipientEmail] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (recipientEmail.trim()) {
      onTest(recipientEmail.trim());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="email"
          placeholder="test@example.com"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          disabled={testing}
          className="h-8 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={testing || !recipientEmail.trim()}>
          {testing && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Send Test
        </Button>
      </div>
      {testResult && (
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {testResult}
        </div>
      )}
    </form>
  );
}

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
