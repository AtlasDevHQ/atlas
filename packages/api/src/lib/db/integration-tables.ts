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
 * ⚠️ The converse is enforced too: `__tests__/integration-tables.test.ts`
 * enumerates the Drizzle schema and fails on any `*_encrypted` column
 * that is classified nowhere in this module — an entry in
 * `INTEGRATION_TABLES`, in `STANDALONE_ROTATION_TABLES`, or an explicit
 * skip in `ENCRYPTED_OUTSIDE_ROTATION`. Until that tripwire landed this
 * was the one table-lifecycle axis (vs purge / bundle / cleanup /
 * residue-sweep) whose registry could silently under-count:
 * `workspace_model_config` was rotated only via a hand-written duplicate
 * entry inside the rotation script, and `email_outbox.payload`'s
 * non-participation was recorded only as a schema comment. Both are
 * declarations below now.
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
 * `apps/docs/content/shared/platform-ops/encryption-key-rotation.mdx`.
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
  // 0164 (#4211) — bundle-sync knowledge collections' endpoint auth secrets,
  // the first Knowledge Base credential. One optional row per synced
  // collection (unique on (workspace_id, collection_id)); the table keys on a
  // single uuid `id` so the rotation / audit scripts walk it generically
  // (single-PK assumption preserved). "No auth" is "no row" — the encrypted
  // column is NOT NULL, so this table participates in NON_NULL_ENCRYPTED_TABLES.
  { table: "knowledge_sync_credentials", pk: "id", encrypted: "auth_secret_encrypted", keyVersionColumn: "auth_secret_key_version" },
  // 0140 (#3704) — OPERATOR-tier integration app credentials (Atlas's own
  // app registrations, set/rotated via Admin without a redeploy). One row
  // per `platform` slug; the table still keys on a single uuid `id` so the
  // rotation / audit scripts walk it generically (single-PK assumption
  // preserved). The encrypted blob is a JSON `{ <ENV_VAR>: <value> }` map.
  { table: "operator_integration_credentials", pk: "id",   encrypted: "credentials_encrypted",        keyVersionColumn: "credentials_key_version" },
  // 0212 (#3766) — WORKSPACE-tier action-target credentials (a tenant's own
  // Jira/Linear/GitHub/Salesforce, set from workspace Admin without operator
  // involvement). One row per `(workspace_id, target)`; the table keys on a
  // single uuid `id` so the rotation / audit scripts walk it generically
  // (single-PK assumption preserved). The encrypted blob is a JSON
  // `{ <ENV_VAR>: <value> }` map, same shape as the operator table above —
  // but a strictly separate tier: no operator rung exists for action targets
  // (ADR-0046), and neither store ever reads the other's table.
  { table: "workspace_action_credentials", pk: "id",       encrypted: "credentials_encrypted",        keyVersionColumn: "credentials_key_version" },
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

/**
 * F-47 column-rotation participants that are NOT integration credential
 * tables, so they stay out of `INTEGRATION_TABLES` (and out of the F-42
 * residue audit that iterates it) while still being re-keyed by the
 * rotation script via `ROTATED_COLUMN_TABLES` below.
 *
 * `workspace_model_config` is the founding member, moved here from a
 * hand-written duplicate inside `rotate-encryption-key.ts` (which the
 * completeness tripwire could never see):
 *   • It is a BYOT model key, not an integration credential, and it is
 *     encrypted by the legacy `db/internal.ts` `encryptSecret`
 *     (`URLSecret` brand) — the post-#2755 carve-out reserved for this
 *     column and `sso_providers.config.clientSecret`. Both helpers emit
 *     the same `enc:v<N>:` wire format, which is what makes the shared
 *     column-walking rotation valid.
 *   • It is deliberately absent from the F-42 residue audit: the legacy
 *     helper passes plaintext through when no keyset is configured
 *     (dev / self-hosted), so a ciphertext-shape assertion would
 *     false-positive on legitimate rows. That absence is a decision,
 *     recorded here rather than implied by omission.
 */
export const STANDALONE_ROTATION_TABLES: ReadonlyArray<IntegrationTable> = [
  // Nullable column: provider='gateway' rows carry no BYOT key at all
  // (chk_model_provider_key), so this could never join
  // NON_NULL_ENCRYPTED_TABLES even if it were an integration table.
  { table: "workspace_model_config", pk: "id", encrypted: "api_key_encrypted", keyVersionColumn: "api_key_key_version" },
] as const;

/**
 * Every column-oriented F-47 rotation target — what the rotation
 * script's `ROTATION_TABLES` derives its column entries from. One list,
 * so a new encrypted column is a single entry in exactly one of the two
 * arrays above and rotation coverage follows automatically.
 */
export const ROTATED_COLUMN_TABLES: ReadonlyArray<IntegrationTable> = [
  ...STANDALONE_ROTATION_TABLES,
  ...INTEGRATION_TABLES,
];

/**
 * An at-rest-encrypted column that deliberately does NOT participate in
 * F-47 column rotation. Absence from the rotation walk must be a
 * declaration, not an omission — the completeness tripwire in
 * `__tests__/integration-tables.test.ts` accepts a column only when it
 * is classified either as a rotation participant or as an entry here.
 */
export interface EncryptedColumnSkip {
  /** Logical table name. Must exist in the Drizzle schema (test-enforced). */
  readonly table: string;
  /** Column carrying `enc:v<N>:` ciphertext. */
  readonly column: string;
  /**
   * How the ciphertext leaves an old key's coverage, since the rotation
   * script never touches it:
   *   • "manual" — an operator/admin action re-encrypts under the
   *     active key (documented per entry).
   *   • "expires" — rows are TTL-bounded; the old key only needs to
   *     outlive the longest TTL in the keyset's decrypt list.
   */
  readonly rotation: "manual" | "expires";
  /** Why the skip is correct. Load-bearing: shown to whoever the tripwire stops. */
  readonly reason: string;
}

/**
 * The declared skips. Keep each reason honest enough that a future
 * reader can decide whether the grounds still hold.
 */
export const ENCRYPTED_OUTSIDE_ROTATION: ReadonlyArray<EncryptedColumnSkip> = [
  {
    table: "email_outbox",
    column: "payload",
    rotation: "expires",
    reason:
      "TTL'd transactional sends (live reset link / OTP for the delivery window). " +
      "No long-lived credential exists to re-key: rows are dead-lettered past " +
      "expires_at, so retiring a key only needs to wait out the longest TTL. " +
      "Re-encrypting undelivered mail mid-flight would race the flusher's claim " +
      "cycle for no security gain. See the email_outbox schema comment.",
  },
  {
    table: "sso_providers",
    column: "config",
    rotation: "manual",
    reason:
      "clientSecret is encrypted inside a hand-rolled JSONB field, not the " +
      "catalog-driven selective-field walker, so the column walker cannot reach " +
      "it. Operators re-save OIDC configs via the admin UI to re-encrypt under " +
      "the active key — the same gap the rotate-encryption-key.ts header " +
      "documents, with an `oidc-jsonb` target kind as the future closure.",
  },
] as const;
