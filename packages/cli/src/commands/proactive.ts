/**
 * atlas proactive — enable or disable proactive chat for a workspace.
 *
 * Replaces internal/enable-proactive-dogfood.ts and internal/disable-proactive-dogfood.ts.
 * Operates against the tenant Postgres pointed at by ATLAS_TEAM_PG_URL (defaults to
 * DATABASE_URL when ATLAS_TEAM_PG_URL is unset, so dev loops against the local DB
 * Just Work). Workspace can be a slug (resolved via `organization.slug`) or a
 * literal org id starting with `org_`.
 *
 * Usage:
 *   bun run atlas -- proactive enable --workspace <id|slug> --channels <id1,id2,...>
 *   bun run atlas -- proactive disable --workspace <id|slug>
 *
 * Idempotent: re-running enable upserts workspace_proactive_config + every channel row;
 * re-running disable flips workspace_proactive_config.enabled=false (channel rows
 * preserved so a later enable doesn't lose channel configs).
 */
import { getFlag } from "../../lib/cli-utils";
import {
  resolveTenantUrl,
  resolveWorkspaceId,
  type TenantPgClient,
} from "../../lib/tenant-db";

export { resolveWorkspaceId };

// Minimal Postgres client surface the SQL functions depend on. Both `pg.Client`
// and the bun:test mock pool below satisfy this — gives us tests without
// requiring a real database.
export type ProactivePgClient = TenantPgClient;

export interface EnableProactiveOptions {
  workspace: string;
  channels: string[];
}

export interface DisableProactiveOptions {
  workspace: string;
}

/**
 * Run the enable transaction: upsert workspace_proactive_config + one row per
 * channel into channel_proactive_config. Returns the resolved orgId so callers
 * can log it.
 */
export async function enableProactive(
  client: ProactivePgClient,
  opts: EnableProactiveOptions,
): Promise<{ orgId: string; channelCount: number }> {
  if (opts.channels.length === 0) {
    throw new Error("enable requires at least one --channels value");
  }
  await client.query("BEGIN");
  try {
    const orgId = await resolveWorkspaceId(client, opts.workspace);
    await client.query(
      `INSERT INTO workspace_proactive_config (workspace_id, enabled, sensitivity, classifier_mode)
       VALUES ($1, true, 'balanced', 'regex-prefilter')
       ON CONFLICT (workspace_id) DO UPDATE
         SET enabled = true, updated_at = NOW()`,
      [orgId],
    );
    for (const channelId of opts.channels) {
      await client.query(
        `INSERT INTO channel_proactive_config (workspace_id, channel_id, allow)
         VALUES ($1, $2, true)
         ON CONFLICT (workspace_id, channel_id) DO UPDATE
           SET allow = true, updated_at = NOW()`,
        [orgId, channelId],
      );
    }
    await client.query("COMMIT");
    return { orgId, channelCount: opts.channels.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Set workspace_proactive_config.enabled=false for the resolved workspace.
 * Channel rows are deliberately left intact.
 */
export async function disableProactive(
  client: ProactivePgClient,
  opts: DisableProactiveOptions,
): Promise<{ orgId: string; affected: number }> {
  const orgId = await resolveWorkspaceId(client, opts.workspace);
  const r = await client.query(
    `UPDATE workspace_proactive_config SET enabled = false, updated_at = NOW()
     WHERE workspace_id = $1`,
    [orgId],
  );
  return { orgId, affected: r.rowCount ?? 0 };
}

export async function handleProactive(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand !== "enable" && subcommand !== "disable") {
    console.error(
      "Usage: atlas proactive <enable|disable> --workspace <id|slug> [--channels <ids>]\n\n" +
        "Subcommands:\n" +
        "  enable   Turn on proactive chat for a workspace + opt one or more channels in.\n" +
        "  disable  Flip the workspace toggle off (channel rows preserved).\n",
    );
    process.exit(1);
  }

  const workspace = getFlag(args, "--workspace");
  if (!workspace) {
    console.error("Error: --workspace <id|slug> is required.");
    process.exit(1);
  }

  if (subcommand === "enable") {
    const channelsArg = getFlag(args, "--channels");
    if (!channelsArg) {
      console.error("Error: --channels <id1,id2,...> is required for `proactive enable`.");
      process.exit(1);
    }
    const channels = channelsArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (channels.length === 0) {
      console.error("Error: --channels must contain at least one channel id.");
      process.exit(1);
    }

    const url = resolveTenantUrl();
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const result = await enableProactive(client as unknown as ProactivePgClient, {
        workspace,
        channels,
      });
      console.log(
        `[proactive] enabled for workspace=${result.orgId} on ${result.channelCount} channel(s)`,
      );
    } catch (err) {
      console.error(
        `[proactive] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      await client.end();
    }
    return;
  }

  // disable
  const url = resolveTenantUrl();
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await disableProactive(client as unknown as ProactivePgClient, {
      workspace,
    });
    if (result.affected === 0) {
      console.log(`[proactive] no workspace_proactive_config row for workspace=${result.orgId}`);
    } else {
      console.log(`[proactive] disabled for workspace=${result.orgId}`);
    }
  } catch (err) {
    console.error(
      `[proactive] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
