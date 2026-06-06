"use client";

/**
 * Salesforce render path for `/admin/connections` — slice 7 of 1.5.3 (#2745).
 *
 * Salesforce is a `workspace_plugins WHERE pillar = 'datasource'` row post-slice-6
 * cutover, but it's plugin-managed (not native postgres/mysql) so
 * `ConnectionRegistry.describe()` doesn't surface it. The /admin/connections
 * list (`/api/v1/admin/connections`) projects from the registry, so Salesforce
 * installs are invisible there. This component bridges the gap by reading the
 * catalog endpoint directly, finding the `salesforce` row, and rendering the
 * same provider block shape (CompactRow when disconnected, Shell when
 * connected) the SQL provider blocks use.
 *
 * Connect/Disconnect routes:
 *   - Connect    → `<a href=/api/v1/integrations/salesforce/install>` (OAuth dance,
 *                  handled by {@link SalesforceOAuthInstallHandler})
 *   - Disconnect → `DELETE /api/v1/integrations/salesforce` (catalog endpoint,
 *                  routes through `WorkspaceInstaller.uninstall` per
 *                  ADR-0007 — both the workspace_plugins row and the
 *                  integration_credentials entry are removed)
 *   - Reconnect  → same href as Connect (the OAuth callback upserts the
 *                  install row, healing an expired refresh token in place)
 *
 * Detail rows surfaced when connected:
 *   - Instance URL (`installConfig.instance_url`) — the per-tenant Salesforce
 *     host. Differs from the login host (login.salesforce.com vs the
 *     workspace's na139.my.salesforce.com); always rendered as-is so admins
 *     can verify they connected the right tenant.
 *   - Org ID        (`installConfig.org_id`)
 *   - Refresh token freshness — derived from `installStatus`. `'ok'` →
 *     "Refresh token live"; `'reconnect_needed'` → red destructive copy.
 *   - Connected (installedAt · installedBy)
 *
 * The catalog endpoint scrubs secret-marked fields server-side via
 * `maskSecretFields` (`integrations-catalog.ts:projectInstallConfig`), so this
 * component renders `installConfig` directly without re-scrubbing.
 */

import { toast } from "sonner";
import {
  ExternalLink,
  HardDrive,
  Loader2,
  Lock,
  Plus,
  Sparkles,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CompactRow,
  DetailList,
  DetailRow,
  InlineError,
} from "@/ui/components/admin/compact";
import { CollapsibleRow } from "@/ui/components/admin/collapsible-row";
import { countLine, SectionHeader } from "./section-header";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { IntegrationsCatalogResponseSchema } from "@/ui/lib/admin-schemas";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";
import { getApiUrl } from "@/lib/api-url";
import { formatDateTime } from "@/lib/format";

const SALESFORCE_SLUG = "salesforce";

/**
 * Read an `installConfig` field as a non-empty string. The catalog
 * scrubs secret-marked fields to a masked placeholder, but Salesforce's
 * `instance_url` / `org_id` are non-secret operational fields by
 * construction (the access/refresh tokens live in
 * `integration_credentials`). Returns `null` for absent / non-string /
 * empty values so the detail row hides cleanly.
 */
function readStringField(
  installConfig: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!installConfig) return null;
  const value = installConfig[key];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

interface SalesforceProviderBlockProps {
  /**
   * Demo-readonly gate from the parent page. When true, the Connect
   * affordance is rendered as a disabled button (consistent with the
   * SQL-provider blocks). Salesforce doesn't ship a demo install today
   * so this primarily exists for shape parity — flipping it disables
   * the Connect CTA so the user can't initiate a destructive flow in
   * published mode without an active workspace.
   */
  readonly demoReadOnly: boolean;
  /** Fires after a disconnect succeeds so the parent refreshes its lists. */
  readonly onChange: () => void;
}

/**
 * Provider block for the Salesforce row on `/admin/connections`. Parallel
 * to the {@link ProviderBlock} in `page.tsx` — same CompactRow / Shell
 * shape, but the install lookup goes through the catalog endpoint
 * (`/api/v1/integrations/catalog`) instead of the connections endpoint.
 */
export function SalesforceProviderBlock({
  demoReadOnly,
  onChange,
}: SalesforceProviderBlockProps) {
  const catalogQuery = useAdminFetch("/api/v1/integrations/catalog", {
    schema: IntegrationsCatalogResponseSchema,
  });

  const disconnect = useAdminMutation<{ message: string }>({
    path: `/api/v1/integrations/${SALESFORCE_SLUG}`,
    method: "DELETE",
    invalidates: () => {
      catalogQuery.refetch();
      onChange();
    },
  });

  async function handleDisconnect() {
    const result = await disconnect.mutate({});
    if (result.ok) {
      toast.success("Salesforce disconnected");
    } else {
      const message =
        friendlyErrorOrNull(result.error) ?? "Couldn't disconnect Salesforce";
      toast.error(message);
    }
  }

  const entry = catalogQuery.data?.catalog.find((e) => e.slug === SALESFORCE_SLUG);
  const installed = !!entry?.installed;
  const installHref = `${getApiUrl()}/api/v1/integrations/${SALESFORCE_SLUG}/install`;

  const header = (
    <SectionHeader
      title="Apps & CRM"
      count={entry ? countLine(installed ? 1 : 0) : undefined}
    />
  );

  // Loading + error states: render a single disabled CompactRow under the
  // section header so the layout doesn't jump.
  if (catalogQuery.loading) {
    return (
      <section>
        {header}
        <CompactRow
          icon={HardDrive}
          title="Salesforce"
          description="Loading…"
          status="disconnected"
          action={
            <Button size="sm" variant="outline" disabled>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Connect
            </Button>
          }
        />
      </section>
    );
  }

  // Fail-soft on catalog read failure: surface a disconnected row with a
  // retry so the rest of the page renders.
  if (catalogQuery.error) {
    const message =
      friendlyErrorOrNull(catalogQuery.error) ?? "Failed to load catalog.";
    return (
      <section>
        {header}
        <CompactRow
          icon={HardDrive}
          title="Salesforce"
          description={message}
          status="unhealthy"
          action={
            <Button size="sm" variant="outline" onClick={() => catalogQuery.refetch()}>
              Retry
            </Button>
          }
        />
      </section>
    );
  }

  // Salesforce row absent from the catalog → hide the whole section. This
  // happens on deploys where the catalog seeder hasn't run yet or where the
  // row was explicitly disabled via ops. A Connect CTA that would 404
  // against `/api/v1/integrations/salesforce/install` is worse than nothing.
  if (!entry) return null;

  // Coming-soon dominates everything else — render an inert row that signals
  // "Atlas hasn't shipped this yet" without misleading the admin into clicking.
  if (entry.implementationStatus === "coming_soon") {
    return (
      <section>
        {header}
        <CompactRow
          icon={HardDrive}
          title={entry.name}
          description={entry.description ?? "Coming soon"}
          status="unavailable"
          statusLabel="Coming soon"
          action={
            <Button size="sm" variant="outline" disabled>
              Coming soon
            </Button>
          }
        />
      </section>
    );
  }

  const needsReconnect = installed && entry.installStatus === "reconnect_needed";

  // ── Disconnected branch ──────────────────────────────────────────
  if (!installed) {
    // Plan-gate the Connect CTA: when the catalog row reports
    // `access.kind === "upgrade"`, the backend `/install` endpoint refuses
    // with `plan_upgrade_required`. Mirror the lock UI so the user sees the
    // required plan up front instead of bouncing through OAuth to a 403.
    if (entry.access.kind === "upgrade") {
      const requiredPlan = entry.access.requiredPlan ?? entry.minPlan;
      return (
        <section>
          {header}
          <CompactRow
            icon={HardDrive}
            title={entry.name}
            description={entry.description ?? `Premium — requires ${requiredPlan}`}
            status="unavailable"
            statusLabel={`Premium — requires ${requiredPlan}`}
            action={
              <div className="flex items-center gap-1.5">
                <Lock
                  className="size-3.5 text-muted-foreground"
                  aria-label="Premium integration"
                  data-testid="salesforce-lock-icon"
                />
                <Badge
                  variant="outline"
                  className="gap-1 text-[10px]"
                  data-testid="salesforce-plan-badge"
                >
                  <Sparkles className="size-3" />
                  Premium — requires {requiredPlan}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  aria-label={`Available on ${requiredPlan} plans and above`}
                  title={`Available on ${requiredPlan} plans and above`}
                  data-testid="salesforce-locked-cta"
                >
                  <Lock className="mr-1 size-3" />
                  Upgrade
                </Button>
              </div>
            }
          />
        </section>
      );
    }

    return (
      <section>
        {header}
        <CompactRow
          icon={HardDrive}
          title={entry.name}
          description={entry.description ?? "CRM objects via SOQL"}
          status="disconnected"
          action={
            demoReadOnly ? (
              <Button size="sm" variant="outline" disabled>
                <Plus className="mr-1.5 size-3.5" />
                Connect
              </Button>
            ) : (
              <Button
                size="sm"
                asChild
                aria-label={`Connect ${entry.name}`}
                data-testid="salesforce-connect"
              >
                <a href={installHref}>
                  <ExternalLink className="mr-1.5 size-3.5" />
                  Connect
                </a>
              </Button>
            )
          }
        />
      </section>
    );
  }

  // ── Connected branch (collapsible row, matching the database rows) ──
  const instanceUrl = readStringField(entry.installConfig, "instance_url");
  const orgId = readStringField(entry.installConfig, "org_id");

  return (
    <section>
      {header}
      <CollapsibleRow
        icon={HardDrive}
        title="Salesforce"
        titleText="Salesforce"
        meta={instanceUrl ?? "CRM objects via SOQL"}
        status={needsReconnect ? "unhealthy" : "connected"}
        statusLabel={needsReconnect ? "Reconnect needed" : "Live"}
        dataTestId="salesforce-row"
        titleBadge={
          needsReconnect ? (
            <Badge
              variant="destructive"
              className="text-[10px]"
              data-testid="salesforce-reconnect-badge"
            >
              Reconnect needed
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              Connected
            </Badge>
          )
        }
        actions={
          <SalesforceActions
            name={entry.name}
            needsReconnect={needsReconnect}
            installHref={installHref}
            disconnecting={disconnect.saving}
            onDisconnect={handleDisconnect}
          />
        }
      >
        <DetailList>
          {instanceUrl ? (
            <DetailRow label="Instance URL" value={instanceUrl} mono truncate />
          ) : null}
          {orgId ? <DetailRow label="Org ID" value={orgId} mono truncate /> : null}
          <DetailRow
            label="Refresh token"
            value={
              <span className={needsReconnect ? "text-destructive" : "text-primary"}>
                {needsReconnect ? "Reconnect required" : "Live"}
              </span>
            }
          />
          {entry.installedAt ? (
            <DetailRow
              label="Connected"
              value={
                entry.installedBy
                  ? `${formatDateTime(entry.installedAt)} · by ${entry.installedBy}`
                  : formatDateTime(entry.installedAt)
              }
            />
          ) : null}
        </DetailList>

        {disconnect.error ? (
          <InlineError>
            {friendlyErrorOrNull(disconnect.error) ?? "Disconnect failed."}
          </InlineError>
        ) : null}
      </CollapsibleRow>
    </section>
  );
}

interface SalesforceActionsProps {
  readonly name: string;
  readonly needsReconnect: boolean;
  readonly installHref: string;
  readonly disconnecting: boolean;
  readonly onDisconnect: () => void;
}

/**
 * Action footer for the connected Salesforce Shell. Mirrors the
 * `ShellActions` shape in `catalog-card.tsx`: when `needsReconnect`,
 * Reconnect is the primary CTA and Disconnect recedes to ghost;
 * otherwise Disconnect is the only routine action and Reconnect stays
 * ghost so it doesn't compete for attention.
 */
function SalesforceActions({
  name,
  needsReconnect,
  installHref,
  disconnecting,
  onDisconnect,
}: SalesforceActionsProps) {
  if (needsReconnect) {
    return (
      <>
        <Button size="sm" asChild data-testid="salesforce-reconnect">
          <a href={installHref}>
            <ExternalLink className="mr-1.5 size-3.5" />
            Reconnect
          </a>
        </Button>
        <SalesforceDisconnectDialog
          name={name}
          variant="ghost"
          disconnecting={disconnecting}
          onConfirm={onDisconnect}
        />
      </>
    );
  }
  return (
    <>
      <SalesforceDisconnectDialog
        name={name}
        disconnecting={disconnecting}
        onConfirm={onDisconnect}
      />
      <Button variant="ghost" size="sm" asChild>
        <a href={installHref}>
          <ExternalLink className="mr-1.5 size-3.5" />
          Reconnect
        </a>
      </Button>
    </>
  );
}

function SalesforceDisconnectDialog({
  name,
  disconnecting,
  onConfirm,
  variant = "outline",
}: {
  name: string;
  disconnecting: boolean;
  onConfirm: () => void;
  variant?: "outline" | "ghost";
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant={variant}
          size="sm"
          disabled={disconnecting}
          data-testid="salesforce-disconnect"
        >
          {disconnecting ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : null}
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the Salesforce install for this workspace. Atlas will
            stop running SOQL queries through the connected org until you
            reconnect. Both the workspace_plugins row and the stored OAuth
            refresh token are deleted.
          </AlertDialogDescription>
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
