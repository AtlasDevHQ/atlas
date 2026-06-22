"use client";

import Link from "next/link";
import { Database, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AtlasMode, MeConnectionGroupsEmptyReason } from "@/ui/lib/types";

/**
 * Inputs to {@link shouldShowDevChatEmpty}. The connection fields are named to
 * match `UseChatEnvGroupsResult` (env-picker) so the caller can forward its
 * already-loaded env-groups query verbatim (`{ mode, ...envGroupsQuery }`) —
 * the gate keys off the *same* connection list the env picker renders, with no
 * hand-assembled remap to drift. Mirrors `ShouldRenderEnvPickerArgs`'s
 * structural-slice convention (arrays typed as `ReadonlyArray<unknown>` — only
 * their length matters here).
 */
export interface ShouldShowDevChatEmptyArgs {
  /** Current content mode. The dev-chat empty state is developer-mode only. */
  readonly mode: AtlasMode;
  /** True once the env-groups fetch has settled at least once (#3078). */
  readonly hasLoaded: boolean;
  /** Transport error from the env-groups fetch, if any. */
  readonly error: string | null;
  /**
   * Server-reported reason the env-groups list is empty (`no_internal_db` /
   * `no_active_org`), or `null` when the list is genuinely (un)populated.
   */
  readonly reason: MeConnectionGroupsEmptyReason | null;
  /** SQL connection groups visible to the user. */
  readonly groups: ReadonlyArray<unknown>;
  /** REST/OpenAPI datasources visible to the user. */
  readonly restDatasources: ReadonlyArray<unknown>;
}

/**
 * Whether the chat should show the "no connections" empty state.
 *
 * #3883 — gate on **zero connections visible in developer mode** (SQL groups +
 * REST datasources), NOT draft-count. Developer mode resolves published + draft
 * connections (`isConnectionVisibleInMode` → published + draft), and
 * `/api/v1/me/connection-groups` already lists exactly that superset
 * (`status != 'archived'`), so an empty list is the true "nothing to query"
 * signal. The previous gate — `useDevModeNoDrafts(["connections"])` — fired on
 * zero *drafts*, which wrongly blocked a workspace whose connections are all
 * published-and-live (the soak-found bug). `useDevModeNoDrafts` stays correct
 * for the admin *editing* surfaces (semantic / prompts), which preview drafts.
 *
 * Guards, in order:
 * - Developer mode only (published mode is out of scope for this gate).
 * - Wait for `hasLoaded` so the empty state never flashes before the list
 *   settles.
 * - Never on a transport error — a flaky `/me/connection-groups` fetch must not
 *   hard-block chat; let the user try rather than stranding them.
 * - Never on a degraded `reason` (`no_internal_db` / `no_active_org`) — a legacy
 *   single-connection (no internal DB) deploy is still queryable and an
 *   org-switch race resolves shortly; neither is "zero connections".
 */
export function shouldShowDevChatEmpty(args: ShouldShowDevChatEmptyArgs): boolean {
  if (args.mode !== "developer") return false;
  if (!args.hasLoaded) return false;
  if (args.error) return false;
  if (args.reason !== null) return false;
  return args.groups.length === 0 && args.restDatasources.length === 0;
}

/**
 * Shown in the chat surface when an admin is in developer mode and the
 * workspace has *no connections at all* (neither published nor draft — see
 * {@link shouldShowDevChatEmpty}). Without this, sending a message would let the
 * agent run against nothing and surface a confusing error — instead we redirect
 * them to the admin connections page where they can connect one.
 */
export function DeveloperChatEmptyState() {
  return (
    <div
      role="status"
      data-testid="developer-chat-empty-state"
      className="flex h-full flex-col items-center justify-center gap-4"
    >
      <div className="max-w-md rounded-lg border border-amber-300/60 bg-amber-50/40 px-6 py-8 text-center dark:border-amber-700/40 dark:bg-amber-950/10">
        <Database
          className="mx-auto size-10 text-amber-600 opacity-80 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm font-medium text-foreground">
          No connections configured.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect a database in the admin panel to start querying.
        </p>
        <div className="mt-4">
          <Button asChild size="sm" variant="default">
            <Link href="/admin/connections">
              Go to connections
              <ArrowRight className="ml-1.5 size-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
