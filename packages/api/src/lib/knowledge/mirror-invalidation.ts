/**
 * Knowledge mirror invalidation — the one call every knowledge write path makes
 * after committing, so the next `explore` call rebuilds the `knowledge/` subtree
 * (and the sandbox backends are evicted) via the semantic layer's mode-root
 * machinery. Previously copy-pasted into `admin-knowledge.ts`,
 * `knowledge/sync.ts`, and `admin-publish.ts`.
 *
 * Lazy-imported (not a top-level import) so callers' static graphs don't
 * require `semantic/sync` at load time; best-effort, since the DB write has
 * already committed and a stale in-process cache self-heals on the next boot.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("knowledge-mirror-invalidation");

/**
 * Bust the per-mode knowledge disk mirror for an org (all modes).
 *
 * Default scope is `"knowledge"`: only the `knowledge/` subtree re-mirrors on
 * the next explore call — the entity mode-root cache stays intact, so a
 * runbook upload doesn't pay an entity-root rebuild (explore backends are
 * still evicted; snapshot sandboxes hold the knowledge files too). Pass
 * `scope: "full"` when the write also changed non-knowledge content — the
 * "upload & publish" convenience is the canonical case, since the workspace
 * publish promotes entity/prompt/connection drafts too.
 */
export async function invalidateKnowledgeMirror(
  orgId: string,
  opts?: { scope?: "knowledge" | "full" },
): Promise<void> {
  try {
    const sync = await import("@atlas/api/lib/semantic/sync");
    if (opts?.scope === "full") sync.invalidateOrgModeRoots(orgId);
    else sync.invalidateOrgKnowledgeSubtree(orgId);
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to invalidate knowledge mirror — the agent may serve a stale knowledge/ subtree until the next rebuild",
    );
  }
}
