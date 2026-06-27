/**
 * `atlas entities` (#4043 / ADR-0026) — the minimal command that proves the
 * `atlas login` credential resolves live to its bound workspace.
 *
 * Reads the stored session bearer and lists the semantic entities visible to
 * the bound workspace via `GET /api/v1/semantic/entities` — a workspace-safe,
 * read-only endpoint. Because the bearer is workspace-scoped, this returns data
 * for ONLY the bound workspace; a second `atlas login` (different user/org)
 * sees only its own. A multi-workspace login with no bound workspace surfaces
 * the clear selection handoff rather than leaking another workspace's entities.
 */

import type { SemanticEntitySummary } from "@useatlas/types";
import { resolveApiBaseUrl } from "../lib/api-base";
import { readSession } from "../lib/credentials";

export async function handleEntities(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: atlas entities [--json]\n\n" +
        "List the semantic entities visible to your logged-in workspace.\n" +
        "Requires `atlas login` first.\n",
    );
    return;
  }

  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  if (!session) {
    console.error("Not logged in. Run `atlas login` first.");
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/semantic/entities`, {
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(
      `Failed to reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (res.status === 401) {
    console.error("Your session is no longer valid. Run `atlas login` again.");
    process.exit(1);
  }
  if (res.status === 403) {
    console.error("This workspace is not accessible with your current role.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Request failed (HTTP ${res.status}).`);
    process.exit(1);
  }

  // intentionally ignored: a non-JSON / empty 2xx body degrades to "0 entities"
  // below rather than crashing — res.ok was already checked above.
  const body = (await res.json().catch(() => null)) as
    | { entities?: SemanticEntitySummary[]; warnings?: string[] }
    | null;
  const entities = body?.entities ?? [];

  if (args.includes("--json")) {
    console.log(JSON.stringify({ workspaceId: session.workspaceId, entities }, null, 2));
    return;
  }

  if (session.workspaceId) {
    console.log(`Workspace ${session.workspaceId} — ${entities.length} entit${entities.length === 1 ? "y" : "ies"}:\n`);
  } else {
    console.log(`${entities.length} entit${entities.length === 1 ? "y" : "ies"} visible:\n`);
  }

  if (entities.length === 0) {
    console.log("  (none — this workspace has no published semantic entities)");
    return;
  }
  for (const e of entities) {
    const desc = e.description ? ` — ${e.description}` : "";
    console.log(`  ${e.table}${desc}`);
  }
}
