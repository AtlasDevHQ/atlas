/**
 * Catalog of every integration credential table that participates in
 * F-41 at-rest encryption. Single source of truth shared by:
 *
 *   • F-47 rotation script — `packages/api/scripts/rotate-encryption-key.ts`
 *     walks each table to re-encrypt under the active keyset entry.
 *   • F-42 residue audit script — `packages/api/scripts/audit-plugin-config-residue.ts`
 *     uses the encrypted column to assert the post-#1832 invariant
 *     (`<col>_encrypted IS NOT NULL` per row).
 *
 * Adding a new integration credential table is one entry here plus the
 * matching migration; both downstream scripts pick it up automatically.
 *
 * Pre-#1832 (F-41 soak) the same shape carried a `plaintext` column for
 * the now-deleted `backfill-integration-credentials.ts` script. The
 * column dropped along with the script — only the encrypted-column
 * fields survive.
 */

export interface IntegrationTable {
  /** Logical table name (`slack_installations`, `email_installations`, …). */
  readonly table: string;
  /** Primary-key column used by rotation/audit UPDATE/SELECT statements. */
  readonly pk: string;
  /** Encrypted-column name (`bot_token_encrypted`, `config_encrypted`, …). */
  readonly encrypted: string;
  /**
   * Companion column carrying the F-47 keyset version the row's
   * ciphertext was produced under. Named `…Column` (not just
   * `keyVersion`) because every other field is a SQL identifier and
   * this one is too — saves operator confusion on the rotation runbook.
   */
  readonly keyVersionColumn: string;
}

/**
 * Every integration credential table covered by F-41. Order matches
 * the migration history (`0001_…` → `0011_…`) and the runbook in
 * `apps/docs/content/docs/platform-ops/encryption-key-rotation.mdx`.
 *
 * `slack_installations` was dropped in migration `0086_consolidate_slack_installations.sql`
 * (#2634) — Slack bot tokens now live in `chat_cache` under the
 * `slack:installation:` key prefix and use the `@chat-adapter/slack`
 * AES-GCM envelope (keyed off `SLACK_ENCRYPTION_KEY`). That row is
 * deliberately absent from F-41 rotation: the chat-adapter owns its
 * own crypto and isn't a versioned-keyset participant.
 */
export const INTEGRATION_TABLES: ReadonlyArray<IntegrationTable> = [
  // teams/telegram/gchat/whatsapp_installations were dropped by migration 0119
  // (#3161) — those static-bot installs carry no per-workspace credential (the
  // bot is operator-shared) and live in `workspace_plugins`, so they were never
  // real F-41 rotation participants once the unified install path shipped.
  { table: "discord_installations", pk: "guild_id",        encrypted: "bot_token_encrypted",         keyVersionColumn: "bot_token_key_version" },
  { table: "github_installations",  pk: "user_id",         encrypted: "access_token_encrypted",      keyVersionColumn: "access_token_key_version" },
  { table: "linear_installations",  pk: "user_id",         encrypted: "api_key_encrypted",           keyVersionColumn: "api_key_key_version" },
  { table: "email_installations",   pk: "config_id",       encrypted: "config_encrypted",            keyVersionColumn: "config_key_version" },
  { table: "sandbox_credentials",   pk: "id",              encrypted: "credentials_encrypted",       keyVersionColumn: "credentials_key_version" },
  { table: "sub_processor_subscriptions", pk: "id",        encrypted: "token_encrypted",             keyVersionColumn: "token_key_version" },
  // 0089 (#2658) — Salesforce + future lazy OAuth integrations land
  // here. Composite (workspace_id, catalog_id) uniqueness, but the
  // table still keys on a single uuid `id` column so the rotation /
  // audit scripts walk it generically (single-PK assumption preserved).
  { table: "integration_credentials", pk: "id",            encrypted: "credentials_encrypted",       keyVersionColumn: "credentials_key_version" },
  // 0098 — Twenty CRM per-workspace credentials. `workspace_id` is
  // unique on its own (one Twenty install per workspace).
  { table: "twenty_integrations",   pk: "id",              encrypted: "api_key_encrypted",           keyVersionColumn: "api_key_key_version" },
  // 0140 (#3704) — OPERATOR-tier integration app credentials (Atlas's own
  // app registrations, set/rotated via Admin without a redeploy). One row
  // per `platform` slug; the table still keys on a single uuid `id` so the
  // rotation / audit scripts walk it generically (single-PK assumption
  // preserved). The encrypted blob is a JSON `{ <ENV_VAR>: <value> }` map.
  { table: "operator_integration_credentials", pk: "id",   encrypted: "credentials_encrypted",        keyVersionColumn: "credentials_key_version" },
] as const;

/**
 * Tables whose `<encrypted>` column is **always populated** for every
 * row post-#1832 (the migration tightened the column to NOT NULL).
 * Subset of `INTEGRATION_TABLES` — Discord stays nullable because
 * OAuth-only installs legitimately persist no bearer credential. The
 * audit script asserts NOT NULL for every entry here; for the others it
 * asserts only that the per-row column shape is consistent (NULL
 * plaintext-only rows would be a residue, but the 0040 migration
 * eliminated the plaintext column outright).
 *
 * `teams_installations` was the other nullable carve-out (admin-consent
 * installs persisted no password) — it was dropped by migration 0119.
 */
export const NON_NULL_ENCRYPTED_TABLES: ReadonlyArray<IntegrationTable> = INTEGRATION_TABLES.filter(
  (t) => t.table !== "discord_installations",
);
