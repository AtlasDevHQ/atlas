/**
 * Tenant Postgres helpers shared by atlas-cli operator subcommands
 * (`proactive`, `seed`, `ops`). These subcommands replaced the gitignored
 * `internal/*.ts` scripts that all manually constructed a `pg.Client` from
 * `ATLAS_TEAM_PG_URL`. Centralizing the URL resolution + the minimal
 * client shape lets the SQL-issuing helpers be unit-tested against a
 * mocked pool without dragging `pg` into the test layer.
 */

/**
 * Minimal Postgres client surface every operator subcommand depends on.
 * `pg.Client` and the bun:test mock pools both satisfy this shape, so
 * tests stay decoupled from the real driver.
 */
export interface TenantPgClient {
  connect?(): Promise<void>;
  end?(): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * Resolve the tenant Postgres URL — ATLAS_TEAM_PG_URL takes precedence over
 * DATABASE_URL so the Atlas-team dogfood flow keeps working without rebinding
 * the local dev DB. Exits 1 with a clear message when neither is set rather
 * than letting `new Client({ connectionString: undefined })` throw cryptically.
 */
export function resolveTenantUrl(): string {
  const url = process.env.ATLAS_TEAM_PG_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Error: neither ATLAS_TEAM_PG_URL nor DATABASE_URL is set. Set one to the tenant Postgres URL.",
    );
    process.exit(1);
  }
  return url;
}

/**
 * Resolve `--workspace <id|slug>` to an `organization.id`. Values starting with
 * `org_` are treated as ids and returned without a slug lookup; everything else
 * is treated as a slug and looked up via `WHERE slug = $1 AND deleted_at IS NULL`.
 * Throws when the slug has no match or when multiple rows match (corruption guard).
 */
export async function resolveWorkspaceId(
  client: TenantPgClient,
  workspace: string,
): Promise<string> {
  if (workspace.startsWith("org_")) return workspace;
  const r = await client.query<{ id: string }>(
    `SELECT id FROM organization WHERE slug = $1 AND deleted_at IS NULL`,
    [workspace],
  );
  if (r.rows.length === 0) {
    throw new Error(`No organization with slug='${workspace}' found.`);
  }
  if (r.rows.length > 1) {
    throw new Error(
      `Expected one organization for slug='${workspace}', found ${r.rows.length}.`,
    );
  }
  return r.rows[0]!.id;
}
