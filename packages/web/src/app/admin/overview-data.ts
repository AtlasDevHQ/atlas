/**
 * Parse helper for `/api/v1/admin/overview`. Extracted so the page can stay
 * focused on render logic and the contract can be pinned by a unit test —
 * the API side already covers org-scoping, this side guards the
 * wire-shape → tile-data projection.
 *
 * Wire-shape comes from `packages/api/src/api/routes/admin.ts:overviewRoute`.
 * Keep the two in lockstep when adding tiles.
 */

export interface WorkspaceBlock {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  planDisplayName: string;
  trialEndsAt: string | null;
  region: string | null;
}

export interface OverviewData {
  connections: number;
  entities: number;
  plugins: number;
  /**
   * `null` when no internal DB / no org context — the tile renders "—" in
   * that case. `0` is a valid org-scoped value (no audited queries in 24h).
   */
  queriesLast24h: number | null;
  workspace: WorkspaceBlock | null;
}

export const FALLBACK_OVERVIEW: OverviewData = {
  connections: 0,
  entities: 0,
  plugins: 0,
  queriesLast24h: null,
  workspace: null,
};

export function parseOverview(json: Record<string, unknown>): OverviewData {
  const ws = json.workspace as Record<string, unknown> | null | undefined;
  return {
    connections: typeof json.connections === "number" ? json.connections : 0,
    entities: typeof json.entities === "number" ? json.entities : 0,
    plugins: typeof json.plugins === "number" ? json.plugins : 0,
    queriesLast24h:
      typeof json.queriesLast24h === "number" ? json.queriesLast24h : null,
    workspace: ws
      ? {
          id: String(ws.id ?? ""),
          name: String(ws.name ?? ""),
          slug: String(ws.slug ?? ""),
          planTier: String(ws.planTier ?? "free"),
          planDisplayName: String(ws.planDisplayName ?? ws.planTier ?? ""),
          trialEndsAt:
            typeof ws.trialEndsAt === "string" ? ws.trialEndsAt : null,
          region: typeof ws.region === "string" ? ws.region : null,
        }
      : null,
  };
}
