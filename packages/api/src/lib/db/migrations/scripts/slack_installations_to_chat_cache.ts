/**
 * One-shot bridge — copies Atlas's `slack_installations` rows into `chat_cache`
 * under `slack:installation:<team_id>` keys so the `@useatlas/chat` plugin's
 * `@chat-adapter/slack` finds each workspace's bot_token when it needs to call
 * the Slack API (post messages, add reactions).
 *
 * Does NOT accompany a numbered SQL migration: `chat_cache` is created at
 * runtime by the chat plugin's `pg-adapter.ts` via `CREATE TABLE IF NOT EXISTS`
 * on first connect. Naming the script after the source table (slack_installations
 * → chat_cache) is the clearest signal of intent.
 *
 * Promoted from internal/backfill-chat-installations.ts (#2635). The script
 * was run on prod as part of the proactive-listener wiring trail
 * (#2607 → #2625 → #2626) before promotion.
 *
 * Invocation:
 *   ATLAS_TEAM_PG_URL=... bun run packages/api/src/lib/db/migrations/scripts/slack_installations_to_chat_cache.ts
 */
import { Client } from "pg";
import { decryptSecret } from "../../secret-encryption";

async function main(): Promise<void> {
  const url = process.env.ATLAS_TEAM_PG_URL;
  if (!url) {
    throw new Error("Missing required env var: ATLAS_TEAM_PG_URL");
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const rows = await client.query<{
      team_id: string;
      bot_token_encrypted: string;
      workspace_name: string | null;
      org_id: string | null;
    }>(
      "SELECT team_id, bot_token_encrypted, workspace_name, org_id FROM slack_installations",
    );
    console.log(`[backfill] found ${rows.rowCount} slack_installations rows`);

    let written = 0;
    let decryptFailures = 0;
    let tokenFormatRejected = 0;
    for (const row of rows.rows) {
      let botToken: string;
      try {
        botToken = decryptSecret(row.bot_token_encrypted);
      } catch (err) {
        decryptFailures++;
        console.error(
          `[backfill] decrypt failed for ${row.team_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!botToken.startsWith("xoxb-") && !botToken.startsWith("xoxe.xoxb-")) {
        tokenFormatRejected++;
        console.warn(
          `[backfill] team ${row.team_id} token doesn't look like a bot token (starts with ${botToken.slice(0, 10)}); skipping`,
        );
        continue;
      }

      const key = `slack:installation:${row.team_id}`;
      const value: { botToken: string; teamName?: string } = { botToken };
      if (row.workspace_name) value.teamName = row.workspace_name;

      await client.query(
        `INSERT INTO chat_cache (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, expires_at = NULL`,
        [key, JSON.stringify(value)],
      );
      written++;
      console.log(
        `[backfill] ✓ wrote ${key} (workspace=${row.workspace_name ?? "?"}, org=${row.org_id ?? "?"})`,
      );
    }

    const verify = await client.query<{ key: string; team_name: string | null }>(
      `SELECT key, (value->>'teamName') AS team_name
       FROM chat_cache WHERE key LIKE 'slack:installation:%'`,
    );
    console.log(
      `[backfill] summary: read=${rows.rowCount} wrote=${written} decryptFailed=${decryptFailures} badTokenFormat=${tokenFormatRejected}`,
    );
    console.log(`[backfill] chat_cache now has ${verify.rowCount} slack installations`);
    // Decrypt failure is an operator-config bug (missing/wrong ATLAS_ENCRYPTION_KEYS).
    // Fail loudly rather than letting the operator believe a partial backfill is complete.
    if (decryptFailures > 0) {
      throw new Error(
        `[backfill] ${decryptFailures} rows failed to decrypt — fix ATLAS_ENCRYPTION_KEYS and re-run`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[backfill] ✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
