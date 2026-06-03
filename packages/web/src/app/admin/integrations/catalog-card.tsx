"use client";

/**
 * Single catalog card for `/admin/integrations`. Slice 8 of 1.5.3 (#2746)
 * consolidated the install / disconnect / manage / reconnect lifecycle here
 * after the legacy per-platform card stack (`<SlackCard>`, `<TeamsCard>`, …)
 * was removed from `page.tsx`.
 *
 * Branch precedence — the dominant gate wins; later branches only consider
 * what survives. This matches `resolveInstallStatus` (#2740 / ADR-0007):
 *
 *   1. coming_soon         → grey "Coming soon" — dominates every other gate
 *   2. upgrade_required    → purple "Premium" — only when not already installed
 *   3. installed-via-catalog (workspace_plugins row exists)
 *        → Shell with detail rows + Manage / Disconnect / Reconnect actions
 *   4. legacy-connected    → status.connected && !catalog.installed (BYOT-only
 *        install lives in chat_cache without a workspace_plugins row)
 *        → Shell with detail + Disconnect through the legacy admin endpoint
 *   5. accessible + not installed
 *        - oauth + configurable → Connect (GET /:slug/install)
 *        - form                 → Install → FormInstallModal
 *        - BYOT-eligible        → "Add token" → inline {@link ByotForm}
 *        - static-bot / no path → inert "Connect" (handler ships in its own slice)
 *
 * Visual idiom: CompactRow when collapsed, Shell when expanded / installed.
 * The shadcn Card primitive used by the pre-#2746 catalog renderer was
 * swapped out so the catalog cards inherit the same density as the legacy
 * per-platform cards they replace — the "merge the polish forward" pass
 * the user called out in the slice-8 prompt.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  Cable,
  Clock,
  ExternalLink,
  GitBranch,
  Loader2,
  Lock,
  Mail,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Phone,
  Plus,
  Send,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import type {
  DiscordStatus,
  EmailStatus,
  GChatStatus,
  GitHubStatus,
  IntegrationStatus,
  LinearStatus,
  SlackStatus,
  TeamsStatus,
  TelegramStatus,
  WebhookStatus,
  WhatsAppStatus,
} from "@useatlas/types";
import type { IntegrationsCatalogEntry } from "@/ui/lib/admin-schemas";
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
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
  Shell,
  type StatusKind,
  useDisclosure,
} from "@/ui/components/admin/compact";
import { formatDateTime } from "@/lib/format";
import { getApiUrl } from "@/lib/api-url";
import { FormInstallModal } from "./form-install-modal";
import { StaticBotInstallModal } from "./static-bot-install-modal";
import { ByotForm, isByotEligibleSlug, type ByotEligibleSlug } from "./byot-form";

// ---------------------------------------------------------------------------
// Icons + display
// ---------------------------------------------------------------------------

/**
 * Slug → icon mapping. Catalog rows ship an `iconUrl` we could render, but
 * the lucide pictograms match the visual weight of the rest of the admin UI
 * (the legacy cards used the same set). Unknown slugs fall back to `Cable`
 * — a generic "wire" pictogram — so a new catalog row renders without a
 * code change here.
 */
const SLUG_ICON: Record<string, LucideIcon> = {
  slack: MessageSquare,
  teams: Users,
  discord: MessageCircle,
  telegram: Send,
  gchat: MessageSquareText,
  whatsapp: Phone,
  github: GitBranch,
  linear: BarChart3,
  email: Mail,
  webhook: Webhook,
};

function iconFor(slug: string): LucideIcon {
  return SLUG_ICON[slug] ?? Cable;
}

// ---------------------------------------------------------------------------
// Per-slug detail-row extraction
//
// Each platform exposes its own connection metadata (workspaceName, tenantId,
// guildId, botUsername, displayPhone, …). The aggregated `/admin/integrations/
// status` endpoint shapes these in `@useatlas/types`. Map them to the shared
// `<DetailList>` shape so the catalog card has one rendering path.
// ---------------------------------------------------------------------------

interface DetailRowSpec {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

function detailRowsForSlug(
  slug: string,
  status: IntegrationStatus | null,
): DetailRowSpec[] {
  if (!status) return [];
  switch (slug) {
    case "slack":
      return slackRows(status.slack);
    case "teams":
      return teamsRows(status.teams);
    case "discord":
      return discordRows(status.discord);
    case "telegram":
      return telegramRows(status.telegram);
    case "gchat":
      return gchatRows(status.gchat);
    case "whatsapp":
      return whatsappRows(status.whatsapp);
    case "github":
      return githubRows(status.github);
    case "linear":
      return linearRows(status.linear);
    case "email":
      return emailRows(status.email);
    case "webhook":
      return webhookRows(status.webhooks);
    default:
      return [];
  }
}

function pushIf(rows: DetailRowSpec[], spec: DetailRowSpec | null): void {
  if (spec) rows.push(spec);
}

function row(label: string, value: string | null | undefined, mono?: boolean): DetailRowSpec | null {
  if (!value) return null;
  return { label, value, mono };
}

function installedAtRow(installedAt: string | null, installedBy?: string | null): DetailRowSpec | null {
  if (!installedAt) return null;
  return {
    label: "Connected",
    value: installedBy
      ? `${formatDateTime(installedAt)} · by ${installedBy}`
      : formatDateTime(installedAt),
  };
}

function slackRows(s: SlackStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Workspace", s.workspaceName));
  pushIf(rows, row("Team ID", s.teamId !== "env" ? s.teamId : null, true));
  pushIf(rows, installedAtRow(s.installedAt, s.installedBy));
  return rows;
}

function teamsRows(s: TeamsStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Tenant", s.tenantName));
  pushIf(rows, row("Tenant ID", s.tenantId, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function discordRows(s: DiscordStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Server", s.guildName));
  pushIf(rows, row("Guild ID", s.guildId, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function telegramRows(s: TelegramStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Bot", s.botUsername ? `@${s.botUsername}` : null));
  pushIf(rows, row("Bot ID", s.botId, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function gchatRows(s: GChatStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Service Account", s.serviceAccountEmail, true));
  pushIf(rows, row("Project ID", s.projectId, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function whatsappRows(s: WhatsAppStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Phone", s.displayPhone, true));
  pushIf(rows, row("Phone Number ID", s.phoneNumberId, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function githubRows(s: GitHubStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("User", s.username ? `@${s.username}` : null));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function linearRows(s: LinearStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("User", s.userName));
  pushIf(rows, row("Email", s.userEmail, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function emailRows(s: EmailStatus | undefined): DetailRowSpec[] {
  if (!s?.connected) return [];
  const rows: DetailRowSpec[] = [];
  pushIf(rows, row("Provider", s.provider));
  pushIf(rows, row("Sender", s.senderAddress, true));
  pushIf(rows, installedAtRow(s.installedAt));
  return rows;
}

function webhookRows(s: WebhookStatus | undefined): DetailRowSpec[] {
  if (!s) return [];
  const count = s.activeCount;
  if (count <= 0) return [];
  return [{ label: "Active tasks", value: String(count) }];
}

// ---------------------------------------------------------------------------
// Card prop shape
// ---------------------------------------------------------------------------

export interface CatalogCardProps {
  readonly entry: IntegrationsCatalogEntry;
  /**
   * Aggregated platform status from `/api/v1/admin/integrations/status`.
   * Optional — when absent (initial load, or unavailable for the slug) the
   * card relies on catalog state alone. Used to fill the detail-row
   * Shell body for connected platforms and to expose the BYOT path on
   * the chat catalog rows whose OAuth env vars aren't configured.
   */
  readonly status: IntegrationStatus | null;
  /** Fires after install / disconnect succeeds so the parent refetches. */
  readonly onChange: () => void;
}

/**
 * Slugs whose pre-#2742 install lives in a per-platform store and is torn
 * down via `DELETE /api/v1/admin/integrations/:slug`. Used by both
 * {@link isLegacyConnected} (detect a chat_cache-only install) and
 * {@link resolveDisconnectRoute} (gate the legacy DELETE so we never POST
 * to a slug whose admin endpoint doesn't exist — e.g. `webhook`, whose
 * "active" state is a count of scheduled tasks, not a connection).
 *
 * Webhook is intentionally NOT here: `webhooks.activeCount > 0` reflects
 * scheduled-task activity managed on `/admin/scheduled-tasks`, not a
 * disconnectable connection. Rendering Disconnect on a webhook card would
 * 404 against `/admin/integrations/webhook` (which doesn't exist).
 */
const LEGACY_DISCONNECT_SLUGS: ReadonlySet<string> = new Set([
  "slack",
  "teams",
  "discord",
  "telegram",
  "gchat",
  "whatsapp",
  "github",
  "linear",
  "email",
]);

/**
 * Whether the per-platform status payload reports a live connection for
 * this slug. Pre-#2742 BYOT installs land here without a corresponding
 * `workspace_plugins` row — the catalog flow surfaces them as connected
 * so admins can disconnect, but the DELETE routes through the legacy
 * endpoint (see {@link resolveDisconnectRoute}).
 *
 * `webhook` is a structural outlier — `activeCount > 0` reports scheduled
 * tasks fanning out to HTTPS endpoints, NOT a disconnectable connection.
 * It's included here so the card surfaces detail rows + the deep link to
 * `/admin/scheduled-tasks`; the disconnect path stays hidden via the
 * {@link LEGACY_DISCONNECT_SLUGS} gate.
 */
function isLegacyConnected(slug: string, status: IntegrationStatus | null): boolean {
  if (!status) return false;
  switch (slug) {
    case "slack":
      return status.slack.connected;
    case "teams":
      return status.teams.connected;
    case "discord":
      return status.discord.connected;
    case "telegram":
      return status.telegram.connected;
    case "gchat":
      return status.gchat.connected;
    case "whatsapp":
      return status.whatsapp.connected;
    case "github":
      return status.github.connected;
    case "linear":
      return status.linear.connected;
    case "email":
      return status.email.connected;
    case "webhook":
      return status.webhooks.activeCount > 0;
    default:
      return false;
  }
}

/**
 * Build the legacy admin DELETE path. All legacy chat slugs share the
 * `/api/v1/admin/integrations/:slug` convention; the catalog endpoint at
 * `/api/v1/integrations/:slug` is the post-#2740 unified path. The gate
 * for "is this slug actually serviced by a legacy endpoint?" lives in
 * {@link LEGACY_DISCONNECT_SLUGS}.
 */
function legacyDisconnectPath(slug: string): string {
  return `/api/v1/admin/integrations/${encodeURIComponent(slug)}`;
}

/** Where the unified catalog DELETE lives. */
function catalogDisconnectPath(slug: string): string {
  return `/api/v1/integrations/${encodeURIComponent(slug)}`;
}

/**
 * Disconnect-route resolution for the card lifecycle. Three terminal
 * states; the caller branches on the tag.
 *
 *   - `catalog` — a `workspace_plugins` row exists (or, for Slack
 *     specifically, the chat_cache row was minted by an OAuth install
 *     and `hasOAuthInstall` is true). The catalog DELETE runs the
 *     ADR-0003 two-store teardown.
 *   - `legacy`  — only the per-platform store has the credential row
 *     (pre-#2742 BYOT). DELETE drops it via the admin endpoint. Gated
 *     by {@link LEGACY_DISCONNECT_SLUGS} so unknown / not-disconnectable
 *     slugs (e.g. `webhook`) resolve to `none` instead.
 *   - `none`    — no disconnect path is wired for this slug + state
 *     pair. The card hides the Disconnect affordance entirely.
 */
type DisconnectRoute =
  | { readonly kind: "catalog"; readonly path: string }
  | { readonly kind: "legacy"; readonly path: string }
  | { readonly kind: "none" };

function resolveDisconnectRoute(
  entry: IntegrationsCatalogEntry,
  status: IntegrationStatus | null,
): DisconnectRoute {
  const slackHasOAuthInstall =
    entry.slug === "slack" && (status?.slack.hasOAuthInstall ?? false);
  if (entry.installed || slackHasOAuthInstall) {
    return { kind: "catalog", path: catalogDisconnectPath(entry.slug) };
  }
  if (LEGACY_DISCONNECT_SLUGS.has(entry.slug) && isLegacyConnected(entry.slug, status)) {
    return { kind: "legacy", path: legacyDisconnectPath(entry.slug) };
  }
  return { kind: "none" };
}

/**
 * Static-bot slugs whose routing identifier the admin types into a form
 * (#3140). These mirror the API's form-shaped static-bot contract: the bot is
 * operator-shared and the admin supplies a routing identifier (Telegram
 * `chat_id`, Teams `tenant_id`, Google Chat `workspace_id`, WhatsApp
 * `phone_number_id`) that the install route forwards to `confirmInstall`.
 *
 * Discord is deliberately excluded: it is also `install_model: "static-bot"`
 * but captures its routing identifier through an OAuth bot-install redirect
 * (the API rejects a directly-typed `guild_id` on the form route), so its card
 * keeps the non-form affordance rather than rendering a routing-id form.
 */
const STATIC_BOT_FORM_SLUGS: ReadonlySet<string> = new Set([
  "telegram",
  "teams",
  "gchat",
  "whatsapp",
]);

// ---------------------------------------------------------------------------
// CatalogCard
// ---------------------------------------------------------------------------

export function CatalogCard({ entry, status, onChange }: CatalogCardProps) {
  // ── Derived state ────────────────────────────────────────────────
  const isComingSoon = entry.implementationStatus === "coming_soon";
  const isUpsell = entry.access.kind === "upgrade";
  const requiredPlan = entry.access.kind === "upgrade" ? entry.access.requiredPlan : null;
  const catalogInstalled = entry.installed;
  const legacyConnected = isLegacyConnected(entry.slug, status);
  const isConnected = catalogInstalled || legacyConnected;
  const isDowngraded = catalogInstalled && isUpsell;
  const needsReconnect = catalogInstalled && entry.installStatus === "reconnect_needed";

  // Slack carries two extra signals the catalog endpoint doesn't expose:
  // `envConfigured` (SLACK_BOT_TOKEN is set on this deploy) and
  // `oauthConfigured` (SLACK_CLIENT_ID/SECRET are set). Used below for
  // the BYOT-eligibility branch and the env-only hint copy.
  const slackEnvConfigured = entry.slug === "slack" && (status?.slack.envConfigured ?? false);
  const slackOAuthConfigured = entry.slug === "slack" && (status?.slack.oauthConfigured ?? false);

  // Disconnect-route resolution — see {@link resolveDisconnectRoute} for
  // the three-state contract (catalog / legacy / none). `disconnectRoute`
  // drives both the click handler and whether `<DisconnectDialog>` renders
  // at all. The previous bare `catalogInstalled || slackHasOAuth` boolean
  // could not express the third case (active webhook with no DELETE
  // endpoint), shipping a 404 toast — see #2746 review comments.
  const disconnectRoute = resolveDisconnectRoute(entry, status);

  // BYOT eligibility — chat slugs (slack/teams/discord) where the OAuth env
  // vars aren't configured but the internal DB is. The catalog row's
  // `installModel` doesn't carry this — it's a self-host fallback that
  // pre-dates the unified catalog.
  // TODO(#2742): drop this special case once `/api/v1/integrations/:slug/install-form`
  // covers the BYOT field shapes; FormInstallModal then owns rendering.
  const hasInternalDB = status?.hasInternalDB ?? false;
  const byotSlug: ByotEligibleSlug | null = isByotEligibleSlug(entry.slug) ? entry.slug : null;
  const canByot =
    byotSlug !== null &&
    hasInternalDB &&
    // Slack: BYOT path is only relevant when OAuth env vars are missing OR
    // the workspace explicitly chose token-only. Showing the form alongside
    // a working Connect button would be visual clutter.
    (entry.slug === "slack" ? !slackOAuthConfigured : !catalogInstalled);

  // Form modal open state (form install_model only).
  const [formModalOpen, setFormModalOpen] = useState(false);
  // Static-bot routing-identifier modal open state (#3140). Only the
  // form-shaped static-bot slugs (not Discord) capture their routing id here.
  const [staticBotModalOpen, setStaticBotModalOpen] = useState(false);
  const isStaticBotForm =
    entry.installModel === "static-bot" && STATIC_BOT_FORM_SLUGS.has(entry.slug);
  // Driven by whichever disconnect mutation last fired so the inline
  // destructive strip inside the Shell body stays in lockstep with the
  // toast — admin sees the error in two places (toast + persisted strip)
  // and can dismiss the panel without losing the failure.
  const [inlineError, setInlineError] = useState<string | null>(null);

  // ── Mutations ────────────────────────────────────────────────────
  //
  // Both endpoints are wired ahead of time (rather than branching at click
  // time) because `useAdminMutation` must be called unconditionally to
  // satisfy the Rules of Hooks. {@link disconnectRoute} picks at run-time.
  const catalogDisconnect = useAdminMutation<{ message: string }>({
    path: catalogDisconnectPath(entry.slug),
    method: "DELETE",
    invalidates: onChange,
  });
  const legacyDisconnect = useAdminMutation<{ message: string }>({
    path: legacyDisconnectPath(entry.slug),
    method: "DELETE",
    invalidates: onChange,
  });

  // ── useDisclosure for the expand / collapse panel ────────────────
  //
  // `collapseOn` flips to true when the entry transitions to connected —
  // the BYOT form auto-collapses after a successful submit, matching the
  // legacy SlackCard / TeamsCard UX.
  const { expanded, setExpanded, collapse, triggerRef, panelRef, panelId } = useDisclosure({
    collapseOn: isConnected,
    onCollapseCleanup: () => setInlineError(null),
  });

  // ── Render-state derivation ──────────────────────────────────────
  const Icon = iconFor(entry.slug);
  const status_: StatusKind = isComingSoon
    ? "unavailable"
    : isUpsell && !isConnected
    ? "unavailable"
    : isConnected
    ? "connected"
    : "disconnected";

  // Whether to render the expanded Shell (vs the collapsed CompactRow).
  // Connected always expands; otherwise the user must click the trigger.
  const showShell = isConnected || expanded;

  // ── Handlers ─────────────────────────────────────────────────────
  async function handleDisconnect() {
    setInlineError(null);
    // `disconnectRoute.kind === "none"` is unreachable here — the Shell
    // hides `<DisconnectDialog>` when the route is none, so this handler
    // never fires. Guard defensively anyway so a future caller can't
    // silently POST to a non-existent endpoint.
    if (disconnectRoute.kind === "none") {
      setInlineError(`Disconnecting ${entry.name} from this surface isn't supported.`);
      return;
    }
    const mutation = disconnectRoute.kind === "catalog" ? catalogDisconnect : legacyDisconnect;
    const result = await mutation.mutate({});
    if (result.ok) {
      toast.success(`${entry.name} disconnected`);
    } else {
      const message = friendlyErrorOrNull(result.error) ?? `Couldn't disconnect ${entry.name}`;
      setInlineError(message);
      toast.error(message);
    }
  }

  // ── Coming-soon branch dominates everything ──────────────────────
  if (isComingSoon) {
    return (
      <div data-testid={`catalog-card-${entry.slug}`} data-card-state="coming-soon">
        <CompactRow
          icon={Icon}
          title={entry.name}
          description={entry.description ?? "Coming soon"}
          status="unavailable"
          statusLabel="Coming soon"
          action={
            <div className="flex items-center gap-1.5">
              <Badge
                variant="secondary"
                className="gap-1 text-[10px]"
                data-testid={`catalog-card-${entry.slug}-coming-soon-badge`}
              >
                <Clock
                  className="size-3"
                  data-testid={`catalog-card-${entry.slug}-coming-soon-icon`}
                />
                Coming soon
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled
                aria-label={`${entry.name} is coming soon`}
                title="Atlas hasn't shipped this integration yet"
                data-testid={`catalog-card-${entry.slug}-coming-soon-cta`}
              >
                <Clock className="mr-1 size-3" />
                Coming soon
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // ── Upsell branch — non-installed + plan does not admit ──────────
  if (isUpsell && !isConnected) {
    return (
      <div data-testid={`catalog-card-${entry.slug}`} data-card-state="upgrade-required">
        <CompactRow
          icon={Icon}
          title={entry.name}
          description={entry.description ?? `Premium — requires ${requiredPlan ?? entry.minPlan}`}
          status="unavailable"
          statusLabel={`Premium — requires ${requiredPlan ?? entry.minPlan}`}
          action={
            <div className="flex items-center gap-1.5">
              {/* The lock-icon `data-testid` is the test hook for the
                  upgrade-required state — see catalog-section.test.tsx. It
                  rides in the action slot rather than next to the title
                  because CompactRow's `title` only accepts plain strings. */}
              <Lock
                className="size-3.5 text-muted-foreground"
                aria-label="Premium integration"
                data-testid={`catalog-card-${entry.slug}-lock-icon`}
              />
              <Badge
                variant="outline"
                className="gap-1 text-[10px]"
                data-testid={`catalog-card-${entry.slug}-plan-badge`}
              >
                <Sparkles className="size-3" />
                Premium — requires {requiredPlan ?? entry.minPlan}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled
                aria-label={`Available on ${requiredPlan ?? entry.minPlan} plans and above`}
                title={`Available on ${requiredPlan ?? entry.minPlan} plans and above`}
                data-testid={`catalog-card-${entry.slug}-locked-cta`}
              >
                <Lock className="mr-1 size-3" />
                Upgrade
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // ── Collapsed CompactRow for not-installed cards ─────────────────
  if (!showShell) {
    return (
      <div data-testid={`catalog-card-${entry.slug}`} data-card-state="accessible">
        <CompactRow
          icon={Icon}
          title={entry.name}
          description={entry.description ?? installModelDescription(entry.installModel)}
          status={status_}
          action={collapsedAction(entry, {
            canByot,
            isStaticBotForm,
            triggerRef,
            onByotToggle: () => setExpanded(true),
            onFormOpen: () => setFormModalOpen(true),
            onStaticBotOpen: () => setStaticBotModalOpen(true),
          })}
        />
        {entry.installModel === "form" && (
          <FormInstallModal
            open={formModalOpen}
            onOpenChange={setFormModalOpen}
            slug={entry.slug}
            name={entry.name}
            description={entry.description}
            configSchema={entry.configSchema}
            onInstalled={() => {
              toast.success(`${entry.name} installed`);
              onChange();
            }}
          />
        )}
        {isStaticBotForm && (
          <StaticBotInstallModal
            open={staticBotModalOpen}
            onOpenChange={setStaticBotModalOpen}
            slug={entry.slug}
            name={entry.name}
            description={entry.description}
            configSchema={entry.configSchema}
            onInstalled={() => {
              toast.success(`${entry.name} installed`);
              onChange();
            }}
          />
        )}
      </div>
    );
  }

  // ── Expanded Shell ───────────────────────────────────────────────
  const detailRows = detailRowsForSlug(entry.slug, status);

  return (
    <div data-testid={`catalog-card-${entry.slug}`} data-card-state="accessible">
      <Shell
        id={panelId}
        panelRef={panelRef}
        icon={Icon}
        title={entry.name}
        description={entry.description ?? installModelDescription(entry.installModel)}
        status={status_}
        titleBadge={
          <CardBadges
            slug={entry.slug}
            isDowngraded={isDowngraded}
            needsReconnect={needsReconnect}
            isInstalled={catalogInstalled}
            isUpsell={isUpsell}
            requiredPlan={requiredPlan ?? entry.minPlan}
          />
        }
        onCollapse={!isConnected ? collapse : undefined}
        actions={
          <ShellActions
            entry={entry}
            isConnected={isConnected}
            disconnectRoute={disconnectRoute}
            catalogInstalled={catalogInstalled}
            needsReconnect={needsReconnect}
            disconnecting={catalogDisconnect.saving || legacyDisconnect.saving}
            onDisconnect={handleDisconnect}
          />
        }
      >
        {detailRows.length > 0 && (
          <DetailList>
            {detailRows.map((r) => (
              <DetailRow key={r.label} label={r.label} value={r.value} mono={r.mono} truncate />
            ))}
          </DetailList>
        )}

        {isDowngraded && (
          <p
            className="text-xs text-destructive"
            data-testid={`catalog-card-${entry.slug}-downgrade-banner`}
          >
            Configured but inactive — your plan was downgraded below{" "}
            <span className="font-medium">{requiredPlan ?? entry.minPlan}</span>. Upgrade to
            re-enable, or disconnect to clean up.
          </p>
        )}

        {/* BYOT inline form (slack/teams/discord with internal DB but no OAuth env). */}
        {!isConnected && byotSlug && canByot && (
          <ByotForm
            slug={byotSlug}
            onSuccess={() => {
              setInlineError(null);
              onChange();
            }}
            onError={setInlineError}
          />
        )}

        {/* Slack-only env-only hint, matching the pre-#2746 SlackCard copy. */}
        {entry.slug === "slack" &&
          isConnected &&
          slackEnvConfigured &&
          !slackOAuthConfigured && (
            <div className="pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Using <code className="rounded bg-muted px-1 font-mono">SLACK_BOT_TOKEN</code>. Add OAuth
              credentials for self-serve management.
            </div>
          )}

        {/* Email manage link — the deep configuration lives on its own page. */}
        {entry.slug === "email" && isConnected && (
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href="/admin/email-provider">Manage provider settings</Link>
          </Button>
        )}

        {/* Webhook tasks live on the scheduled-tasks page. */}
        {entry.slug === "webhook" && isConnected && (
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href="/admin/scheduled-tasks">
              <ExternalLink className="mr-1.5 size-3.5" />
              Manage scheduled tasks
            </Link>
          </Button>
        )}

        <InlineError>{inlineError}</InlineError>
      </Shell>

      {entry.installModel === "form" && (
        <FormInstallModal
          open={formModalOpen}
          onOpenChange={setFormModalOpen}
          slug={entry.slug}
          name={entry.name}
          description={entry.description}
          configSchema={entry.configSchema}
          onInstalled={() => {
            toast.success(`${entry.name} installed`);
            onChange();
          }}
        />
      )}
      {isStaticBotForm && (
        <StaticBotInstallModal
          open={staticBotModalOpen}
          onOpenChange={setStaticBotModalOpen}
          slug={entry.slug}
          name={entry.name}
          description={entry.description}
          configSchema={entry.configSchema}
          onInstalled={() => {
            toast.success(`${entry.name} installed`);
            onChange();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small render helpers — kept colocated so the branching logic is readable
// from CatalogCard without jumping files.
// ---------------------------------------------------------------------------

function installModelDescription(installModel: IntegrationsCatalogEntry["installModel"]): string {
  switch (installModel) {
    case "oauth":
      return "One-click OAuth install";
    case "form":
      return "Submit credentials to install";
    case "static-bot":
      return "Static bot install";
  }
}

interface CollapsedActionOptions {
  readonly canByot: boolean;
  /**
   * Whether this is a form-shaped static-bot slug (#3140) — the admin types a
   * routing identifier into {@link StaticBotInstallModal} rather than running
   * an OAuth dance. Excludes Discord (OAuth-shaped static-bot).
   */
  readonly isStaticBotForm: boolean;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly onByotToggle: () => void;
  readonly onFormOpen: () => void;
  readonly onStaticBotOpen: () => void;
}

/**
 * The CTA rendered in CompactRow's `action` slot when the card is collapsed
 * and not installed. Branches on `installModel`, with the BYOT escape hatch
 * applied for chat slugs that have an internal DB but no OAuth env vars.
 *
 * The BYOT escape hatch fires AHEAD of the OAuth Connect branch when both
 * are available because `canByot` already encodes "OAuth env vars are
 * missing" — without this short-circuit a self-hoster who hasn't wired
 * SLACK_CLIENT_ID would see a Connect button that 503s on click.
 */
function collapsedAction(
  entry: IntegrationsCatalogEntry,
  { canByot, isStaticBotForm, triggerRef, onByotToggle, onFormOpen, onStaticBotOpen }: CollapsedActionOptions,
): React.ReactNode {
  // BYOT wins over OAuth Connect for chat slugs where the env vars are
  // missing — see canByot derivation in CatalogCard.
  if (canByot) {
    return (
      <Button
        ref={triggerRef}
        size="sm"
        variant="outline"
        aria-expanded={false}
        onClick={onByotToggle}
        data-testid={`catalog-card-${entry.slug}-byot-toggle`}
      >
        <Plus className="mr-1.5 size-3.5" />
        Add token
      </Button>
    );
  }
  if (entry.installModel === "oauth") {
    return (
      <Button
        size="sm"
        asChild
        aria-label={`Connect ${entry.name}`}
        data-testid={`catalog-card-${entry.slug}-connect`}
      >
        <a href={`${getApiUrl()}/api/v1/integrations/${encodeURIComponent(entry.slug)}/install`}>
          <ExternalLink className="mr-1.5 size-3.5" />
          Connect
        </a>
      </Button>
    );
  }
  if (entry.installModel === "form") {
    return (
      <Button
        size="sm"
        onClick={onFormOpen}
        aria-label={`Install ${entry.name}`}
        data-testid={`catalog-card-${entry.slug}-install`}
      >
        Install
      </Button>
    );
  }
  // Form-shaped static-bot (#3140 — Telegram / Teams / Google Chat / WhatsApp):
  // the admin types a routing identifier into StaticBotInstallModal, which
  // POSTs to the cap-gated /install-form route. Replaces the inert "not yet
  // shipped" Connect for these slugs.
  if (isStaticBotForm) {
    return (
      <Button
        size="sm"
        onClick={onStaticBotOpen}
        aria-label={`Install ${entry.name}`}
        data-testid={`catalog-card-${entry.slug}-install`}
      >
        Install
      </Button>
    );
  }
  // Other static-bot (Discord — OAuth-shaped) without `canByot`: its routing
  // id is captured via an OAuth bot-install redirect, not a typed form, so the
  // inert disabled button keeps the card visible without a misleading click
  // target here (Discord installs via its own OAuth endpoint).
  return (
    <Button size="sm" disabled aria-label={`Connect ${entry.name}`}>
      Connect
    </Button>
  );
}

interface CardBadgesProps {
  readonly slug: string;
  readonly isDowngraded: boolean;
  readonly needsReconnect: boolean;
  readonly isInstalled: boolean;
  readonly isUpsell: boolean;
  readonly requiredPlan: string;
}

function CardBadges({
  slug,
  isDowngraded,
  needsReconnect,
  isInstalled,
  isUpsell,
  requiredPlan,
}: CardBadgesProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {isDowngraded ? (
        <Badge
          variant="destructive"
          className="text-[10px]"
          data-testid={`catalog-card-${slug}-downgrade-badge`}
        >
          Plan downgrade
        </Badge>
      ) : needsReconnect ? (
        <Badge
          variant="destructive"
          className="text-[10px]"
          data-testid={`catalog-card-${slug}-reconnect-badge`}
        >
          Reconnect needed
        </Badge>
      ) : isInstalled ? (
        <Badge variant="secondary" className="text-[10px]">
          Installed
        </Badge>
      ) : null}
      {isUpsell && (
        <Badge
          variant="outline"
          className="gap-1 text-[10px]"
          data-testid={`catalog-card-${slug}-plan-badge`}
        >
          <Sparkles className="size-3" />
          Premium — requires {requiredPlan}
        </Badge>
      )}
    </div>
  );
}

interface ShellActionsProps {
  readonly entry: IntegrationsCatalogEntry;
  readonly isConnected: boolean;
  /**
   * Resolved disconnect route. When `kind === "none"` the Disconnect
   * button is hidden entirely — used today for webhook cards where
   * `activeCount > 0` reads as "connected" for detail-row purposes but
   * doesn't admit a workspace-level disconnect (tasks live on the
   * scheduled-tasks page).
   */
  readonly disconnectRoute: DisconnectRoute;
  readonly catalogInstalled: boolean;
  readonly needsReconnect: boolean;
  readonly disconnecting: boolean;
  readonly onDisconnect: () => void;
}

function ShellActions({
  entry,
  isConnected,
  disconnectRoute,
  catalogInstalled,
  needsReconnect,
  disconnecting,
  onDisconnect,
}: ShellActionsProps) {
  if (!isConnected) return null;
  // Reconnect is only meaningful for OAuth installs through the catalog —
  // BYOT and form installs heal by re-submitting the form, not by redoing
  // an OAuth dance. The same URL serves both initial Connect and Reconnect;
  // the OAuth callback upserts the install row, healing an expired install
  // in place.
  const reconnectAvailable = catalogInstalled && entry.installModel === "oauth";
  // Hide Disconnect when no route is wired (webhook today). Without this
  // gate the dialog would POST to a 404 endpoint and surface a confusing
  // "Couldn't disconnect" toast.
  const disconnectAvailable = disconnectRoute.kind !== "none";

  // Button hierarchy depends on whether the install needs urgent attention.
  // needsReconnect → Reconnect leads as the default-variant primary CTA so
  //   the admin's eye lands on the action that restores service first.
  // Healthy install → Disconnect is the only routine action; Reconnect
  //   stays ghost so it doesn't compete with day-to-day chrome.
  if (reconnectAvailable && needsReconnect) {
    return (
      <>
        <Button size="sm" asChild>
          <a href={`${getApiUrl()}/api/v1/integrations/${encodeURIComponent(entry.slug)}/install`}>
            <ExternalLink className="mr-1.5 size-3.5" />
            Reconnect
          </a>
        </Button>
        {disconnectAvailable && (
          <DisconnectDialog
            name={entry.name}
            variant="ghost"
            description={`This will remove the ${entry.name} connection for this workspace. Atlas will stop using the integration until you reconnect.`}
            onConfirm={onDisconnect}
            disconnecting={disconnecting}
          />
        )}
      </>
    );
  }

  return (
    <>
      {disconnectAvailable && (
        <DisconnectDialog
          name={entry.name}
          description={`This will remove the ${entry.name} connection for this workspace. Atlas will stop using the integration until you reconnect.`}
          onConfirm={onDisconnect}
          disconnecting={disconnecting}
        />
      )}
      {reconnectAvailable && (
        <Button variant="ghost" size="sm" asChild>
          <a href={`${getApiUrl()}/api/v1/integrations/${encodeURIComponent(entry.slug)}/install`}>
            <ExternalLink className="mr-1.5 size-3.5" />
            Reconnect
          </a>
        </Button>
      )}
    </>
  );
}

function DisconnectDialog({
  name,
  description,
  onConfirm,
  disconnecting,
  variant = "outline",
}: {
  name: string;
  description: string;
  onConfirm: () => void;
  disconnecting: boolean;
  /**
   * Trigger button variant. Defaults to outline (the routine "Disconnect"
   * affordance in a healthy connection). Pass "ghost" when another action
   * (e.g. Reconnect) carries the primary CTA so Disconnect recedes.
   */
  variant?: "outline" | "ghost";
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size="sm" disabled={disconnecting}>
          {disconnecting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
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
