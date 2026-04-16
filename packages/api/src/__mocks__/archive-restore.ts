/**
 * Shared test stubs for `archiveSingleConnection` / `restoreSingleConnection`
 * from `packages/api/src/lib/semantic/entities.ts`.
 *
 * These are NOT no-op mocks — they are full-fidelity stubs that issue the
 * same SQL ordering as the real helpers against a caller-supplied
 * transactional client. Tests that exercise the archive/restore flow
 * (directly via the standalone endpoints or indirectly via publish) use
 * these so they can assert on BEGIN / lock-before-mutate / cascade-order /
 * COMMIT without spinning up a real pg pool.
 *
 * When the real helper's SQL shape or tagged-result contract changes, update
 * this file — both `admin-archive-restore.test.ts` and `admin-publish.test.ts`
 * import from here, so a single edit keeps them in lockstep.
 *
 * Usage:
 *   import { makeArchiveRestoreStubs } from "@atlas/api/testing/archive-restore";
 *
 *   mock.module("@atlas/api/lib/semantic/entities", () => ({
 *     ...otherExports,
 *     ...makeArchiveRestoreStubs(),
 *   }));
 */

/** Minimal pg-client shape the stubs need — matches `TransactionalClient`. */
interface StubClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const DEMO_CONNECTION_ID = "__demo__";

/**
 * Build the tagged-result stubs. Returns an object you can spread into a
 * `mock.module` replacement for `@atlas/api/lib/semantic/entities`.
 */
export function makeArchiveRestoreStubs() {
  return {
    DEMO_CONNECTION_ID,

    archiveSingleConnection: async (
      client: StubClient,
      orgId: string,
      connectionId: string,
      opts?: { demoIndustry?: string | null },
    ) => {
      const current = await client.query(
        `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, connectionId],
      );
      if (current.rows.length === 0) return { status: "not_found" as const };
      const row = current.rows[0] as { status: string };
      const wasAlreadyArchived = row.status === "archived";
      if (!wasAlreadyArchived) {
        await client.query(
          `UPDATE connections SET status = 'archived', updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [orgId, connectionId],
        );
      }
      const archivedEntities = await client.query(
        `UPDATE semantic_entities SET status = 'archived', updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status = 'published'
         RETURNING id`,
        [orgId, connectionId],
      );
      let prompts = 0;
      if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
        const archivedPrompts = await client.query(
          `UPDATE prompt_collections SET status = 'archived', updated_at = now()
           WHERE org_id = $1 AND is_builtin = true AND status = 'published' AND industry = $2
           RETURNING id`,
          [orgId, opts.demoIndustry],
        );
        prompts = archivedPrompts.rows.length;
      }
      return {
        status: wasAlreadyArchived
          ? ("already_archived" as const)
          : ("archived" as const),
        entities: archivedEntities.rows.length,
        prompts,
      };
    },

    restoreSingleConnection: async (
      client: StubClient,
      orgId: string,
      connectionId: string,
      opts?: { demoIndustry?: string | null },
    ) => {
      const current = await client.query(
        `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, connectionId],
      );
      if (current.rows.length === 0) return { status: "not_found" as const };
      const row = current.rows[0] as { status: string };
      if (row.status !== "archived") {
        return { status: "not_archived" as const };
      }
      await client.query(
        `UPDATE connections SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = 'archived'`,
        [orgId, connectionId],
      );
      const restoredEntities = await client.query(
        `UPDATE semantic_entities SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status = 'archived'
         RETURNING id`,
        [orgId, connectionId],
      );
      let prompts = 0;
      if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
        const restoredPrompts = await client.query(
          `UPDATE prompt_collections SET status = 'published', updated_at = now()
           WHERE org_id = $1 AND is_builtin = true AND status = 'archived' AND industry = $2
           RETURNING id`,
          [orgId, opts.demoIndustry],
        );
        prompts = restoredPrompts.rows.length;
      }
      return {
        status: "restored" as const,
        entities: restoredEntities.rows.length,
        prompts,
      };
    },
  };
}
