/**
 * Better Auth table migration — runs once at server boot.
 *
 * Extracted from validateEnvironment() so the startup diagnostics
 * function stays pure (diagnose-only, never mutate). The Hono server
 * entry point (server.ts) calls migrateAuthTables() once on startup.
 */

import { randomBytes } from "crypto";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { getConfig } from "@atlas/api/lib/config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createPlatformAdminUser } from "@atlas/api/lib/auth/admin-user-ops";
import { createLogger } from "@atlas/api/lib/logger";
import { connections, detectDBType, resolveDatasourceUrl } from "@atlas/api/lib/db/connection";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { importFromDisk } from "@atlas/api/lib/semantic/sync";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { encryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";

const log = createLogger("auth-migrate");

let _migrated = false;
let _bootMigrated = false;
let _migrationError: string | null = null;

/** Return the last migration error message, or null if migrations succeeded (or haven't run). */
export function getMigrationError(): string | null {
  return _migrationError;
}

/**
 * Schema-only boot migrations: Better Auth tables, THEN Atlas internal
 * migrations (#1472 ordering). Separately idempotent (`_bootMigrated`) and
 * exported so the server entry point can run it BEFORE plugin `initialize()`
 * (#3741).
 *
 * Why early: a plugin's `initialize()` can read a core table created by these
 * migrations — e.g. the chat adapter's operator-credential resolver reads
 * `operator_integration_credentials` (migration 0140) via #3704's
 * `resolveAdapterEnv`. The Effect Layer DAG's `MigrationLive` runs migrations
 * LATER, so without an early call a first-deploy boot races: plugin init hits a
 * not-yet-created table and aborts (one-shot, no retry). `MigrationLive` (via
 * `migrateAuthTables`) remains the idempotent backstop that still provides the
 * `Migration` Tag for the boot guards.
 *
 * Scope is deliberately schema-only — plugin-settings load, abuse-state
 * restore, and admin bootstrap/seed stay in `migrateAuthTables` so their
 * ordering relative to plugin wiring is unchanged.
 */
export async function runBootMigrations(): Promise<void> {
  if (_bootMigrated) return;
  _bootMigrated = true;

  const authMode = detectAuthMode();

  // 1. Better Auth migrations — must run BEFORE Atlas internal migrations so
  //    that Atlas's organization-table ALTERs (e.g. 0027) find the table.
  if (authMode === "managed" && hasInternalDB()) {
    try {
      const auth = await getAuthInstanceLazy();
      const ctx = await auth.$context;
      await ctx.runMigrations();
      log.info("Better Auth migration complete");

      // Add password_change_required column to Better Auth's user table.
      // Must run AFTER Better Auth migrations (which create the "user" table).
      // If this fails, Better Auth's migration likely misreported success and
      // managed auth itself may be broken — log loudly.
      try {
        await internalQuery(
          `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT false`,
        );
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Could not add password_change_required column — Better Auth user table may be missing or unwritable; password change enforcement will be skipped",
        );
      }
    } catch (err) {
      log.error({ err }, "Better Auth migration failed — managed auth may not work");
      _migrationError = "Connected to the internal database but Better Auth migration failed. Managed auth may not work. Check database permissions (CREATE TABLE).";
    }
  } else if (authMode === "managed" && !hasInternalDB()) {
    log.error(
      "Managed auth mode requires DATABASE_URL for session storage. Skipping auth migration.",
    );
  }

  // 2. Internal DB migration (audit_log, etc.) — runs regardless of auth mode.
  //    In non-managed modes the runner skips org-dependent migrations (#1472).
  if (hasInternalDB()) {
    try {
      const { migrateInternalDB } = await import("@atlas/api/lib/db/internal");
      await migrateInternalDB();
    } catch (err) {
      log.error({ err }, "Internal DB migration failed");
      _migrationError = "Connected to the internal database but migration failed. Check database permissions (CREATE TABLE, CREATE INDEX).";
      // Don't block server start — audit will fall back to pino-only
    }
  }
}

/**
 * Full boot migration + bootstrap sequence — runs once at server boot.
 *
 * Safe to call multiple times — only runs once (idempotent guard). Delegates
 * schema migration to `runBootMigrations()`; when the server entry point has
 * already run that before plugin init (#3741), the delegated call is a no-op.
 *
 * Boot ordering (managed auth, with internal DB):
 *   1. Better Auth migrations — create `organization`, `user`, `session`, etc.
 *   2. Atlas internal DB migrations — can ALTER `organization` (e.g. 0027) now
 *      that Better Auth has created it.   (1 + 2 via `runBootMigrations`)
 *   3. Load plugin settings, abuse state.
 *   4. Bootstrap admin, seed dev user, backfill password-change flag.
 *
 * Step 1 must precede step 2 — see #1472. In non-managed mode step 1 is
 * skipped; the Atlas migration runner independently skips org-dependent
 * files based on `detectAuthMode()`, so 0027 is not attempted without
 * Better Auth having created the table.
 */
export async function migrateAuthTables(): Promise<void> {
  if (_migrated) return;

  // 1 + 2 — schema migrations. Idempotent: a no-op if the server entry point
  // already ran them before plugin init (#3741).
  await runBootMigrations();

  // 3. Load post-migration DB state. Kept here (not in `runBootMigrations`) so
  //    its ordering relative to plugin wiring is unchanged.
  if (hasInternalDB()) {

    // Load plugin settings (enabled/disabled state from DB)
    try {
      const { loadPluginSettings } = await import("@atlas/api/lib/plugins/settings");
      const { plugins } = await import("@atlas/api/lib/plugins/registry");
      await loadPluginSettings(plugins);
    } catch (err) {
      log.error({ err }, "Failed to load plugin settings at startup — all plugins default to enabled");
    }

    // Restore abuse prevention state from DB
    try {
      const { restoreAbuseState } = await import("@atlas/api/lib/security/abuse");
      await restoreAbuseState();
    } catch (err) {
      log.error({ err }, "Failed to restore abuse state at startup — starting with empty state");
    }
  }

  // 4. Bootstrap + seed (managed mode only — needs the Better Auth `user`
  //    table, created in step 1 by `runBootMigrations`). Re-acquire the auth
  //    instance here since the schema-migration step now owns it;
  //    `getAuthInstance` returns the same cached singleton, so this is cheap and
  //    does NOT re-run migrations. Each phase has its own internal try/catch;
  //    the wrappers here catch unexpected programming errors (e.g. API surface
  //    drift) so a failure in one phase doesn't skip the next.
  const auth =
    detectAuthMode() === "managed" && hasInternalDB()
      ? await getAuthInstanceLazy().catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Could not acquire auth instance for bootstrap/seed — admin bootstrap and dev seed skipped",
          );
          return null;
        })
      : null;
  if (auth) {
    try {
      await bootstrapAdminUser();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Bootstrap admin promotion failed unexpectedly — admin console may be inaccessible",
      );
    }
    try {
      await seedDevUser(auth);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Dev user seed failed unexpectedly — first-run admin/org/demo data may be missing",
      );
    }
    try {
      await backfillPasswordChangeFlag();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Backfill password-change flag failed unexpectedly",
      );
    }
  }

  _migrated = true;
}

async function getAuthInstanceLazy() {
  const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
  return getAuthInstance();
}

/**
 * Promote an existing user to admin on upgrade if ATLAS_ADMIN_EMAIL is set
 * and no admin exists yet. Handles the case where users were created before
 * the admin plugin added the `role` column.
 */
async function bootstrapAdminUser(): Promise<void> {
  const adminEmail = process.env.ATLAS_ADMIN_EMAIL?.toLowerCase().trim();
  if (!adminEmail) return;

  try {
    const existing = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM "user" WHERE role IN ('admin', 'platform_admin')`,
    );
    if (parseInt(String(existing[0]?.count ?? "0"), 10) > 0) {
      log.debug("Bootstrap: admin user already exists — skipping promotion");
      return;
    }

    const result = await internalQuery<{ id: string; email: string }>(
      `UPDATE "user" SET role = 'platform_admin' WHERE LOWER(email) = $1 RETURNING id, email`,
      [adminEmail],
    );
    if (result.length > 0) {
      log.info({ email: result[0].email, id: result[0].id }, "Bootstrap: existing user promoted to platform_admin via ATLAS_ADMIN_EMAIL");
    } else {
      log.warn({ adminEmail }, "Bootstrap: ATLAS_ADMIN_EMAIL is set but no user with that email exists yet — role will be assigned on first signup");
    }
  } catch (err) {
    log.error({ err }, "Bootstrap admin promotion failed — admin console may be inaccessible");
  }
}

/**
 * Resolve the password for the first-boot seeded admin account.
 *
 * The published constant `atlas-dev` is a dev-loop convenience only: in
 * anything production-shaped (`NODE_ENV=production`, `ATLAS_DEPLOY_MODE=saas`,
 * or a config-file `deployMode: "saas"`) a fresh instance must never boot a
 * platform admin with public credentials, so a random one-time password is
 * generated instead and logged once by the caller. `password_change_required`
 * is stamped in both cases.
 *
 * The config check matters because the SaaS deploy sets `deployMode` in
 * `deploy/api/atlas.config.ts` rather than the env var — env-only sniffing
 * would miss it whenever NODE_ENV isn't also set.
 */
export function resolveSeedAdminPassword(): { password: string; generated: boolean } {
  const isProductionLike =
    process.env.NODE_ENV === "production" ||
    process.env.ATLAS_DEPLOY_MODE === "saas" ||
    getConfig()?.deployMode === "saas";
  if (isProductionLike) {
    return { password: randomBytes(24).toString("base64url"), generated: true };
  }
  return { password: "atlas-dev", generated: false };
}

/**
 * Seed a complete dev environment when no users exist:
 *   1. Platform admin user (ATLAS_ADMIN_EMAIL / atlas-dev)
 *   2. "Atlas" organization with the admin as owner
 *   3. Demo datasource connection + semantic layer import
 *
 * After `db:reset && dev`, the admin can sign in and see a fully
 * working admin console with data — no manual onboarding steps.
 *
 * Skips silently if any users already exist (idempotent).
 */
async function seedDevUser(auth: { api: Record<string, unknown> }): Promise<void> {
  const adminEmail = process.env.ATLAS_ADMIN_EMAIL?.toLowerCase().trim();
  if (!adminEmail) return;

  try {
    const userCount = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM "user"`,
    );
    if (parseInt(String(userCount[0]?.count ?? "0"), 10) > 0) return;

    // ── 1. Create user ──────────────────────────────────────────────
    // #3159 — the admin plugin's `createUser` (which accepted a `role`) was
    // removed; create via core signUpEmail + promote to platform_admin directly
    // (`role` is an input:false additionalField). The dev seed only runs when no
    // users exist (idempotency check above).
    const { password, generated } = resolveSeedAdminPassword();
    let userId: string;
    try {
      userId = await createPlatformAdminUser(auth.api as Record<string, unknown>, {
        email: adminEmail,
        password,
        name: "Atlas Admin",
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Dev seed: failed to create the dev admin user");
      return;
    }

    // Log the credential IMMEDIATELY after creation, before the flag UPDATE
    // below: the user row already exists at this point, so if a later step
    // throws, reseeding is skipped on the next boot (userCount > 0) and a
    // not-yet-logged generated password would be lost — an admin account
    // nobody can sign in to.
    if (generated) {
      // Deliberately logged in the message text (not a redactable field): this
      // is the operator's only chance to read the bootstrap credential, and a
      // password change is forced at first login.
      log.warn(
        { email: adminEmail },
        `Admin account seeded with a generated one-time password: ${password} — sign in and change it now (password change is required at first login)`,
      );
    } else {
      log.info({ email: adminEmail }, "Dev admin account seeded (password: atlas-dev)");
    }

    // Mark as requiring password change AND verify the email so the seeded
    // admin can sign in without a manual SQL update on a fresh DB. The dev
    // seed only runs when no users exist (idempotency check above), so this
    // never auto-verifies a real signup.
    await internalQuery(
      `UPDATE "user" SET password_change_required = true, "emailVerified" = true WHERE id = $1`,
      [userId],
    );

    // ── 2. Create organization ──────────────────────────────────────
    const createOrg = auth.api.createOrganization as ((opts: {
      body: { name: string; slug: string; userId: string };
    }) => Promise<{ id?: string } | undefined>) | undefined;

    if (!createOrg) {
      log.warn("Dev seed: organization API not available — skipping org creation");
      return;
    }

    const org = await createOrg({
      body: { name: "Atlas", slug: "atlas", userId },
    });
    const orgId = org?.id;
    if (!orgId) {
      log.warn("Dev seed: createOrganization returned no org id");
      return;
    }

    // Set org as active for the user's sessions
    const setActive = auth.api.setActiveOrganization as ((opts: {
      body: { organizationId: string };
      headers: Headers;
    }) => Promise<unknown>) | undefined;

    if (setActive) {
      // We don't have a session yet, so directly update the session table
      // once a session exists. For now, set it via DB — the user's first
      // session will pick it up.
    }

    log.info({ orgId, orgName: "Atlas" }, "Dev organization created");

    // ── 3. Connect demo datasource + import semantic layer ──────────
    await seedDemoData(orgId);

  } catch (err) {
    // User might already exist from a previous partial boot — not fatal
    log.debug({ err }, "Dev user seed skipped or failed");
  }
}

/**
 * Connect the demo datasource and import the semantic layer for an org.
 * Extracted so it can be called from seedDevUser. Non-fatal — logs
 * warnings on failure so the server still boots.
 */
async function seedDemoData(orgId: string): Promise<void> {
  const url = resolveDatasourceUrl();
  if (!url) {
    log.debug("Dev seed: no ATLAS_DATASOURCE_URL — skipping demo data");
    return;
  }

  let dbType: string;
  try {
    dbType = detectDBType(url);
  } catch {
    log.warn("Dev seed: unsupported datasource URL scheme — skipping demo data");
    return;
  }

  // Encrypt and persist as a workspace_plugins datasource install
  // (#2744 cutover — `connections` + `connection_groups` are gone).
  try {
    const catalogRows = await internalQuery<{ id: string; config_schema: unknown }>(
      `SELECT id, config_schema FROM plugin_catalog
        WHERE slug = $1 AND pillar = 'datasource' LIMIT 1`,
      [dbType],
    );
    if (catalogRows.length === 0) {
      log.warn({ dbType }, "Dev seed: no built-in datasource catalog row for dbType — skipping persist");
      return;
    }
    const catalog = catalogRows[0];
    const schema = parseConfigSchema(catalog.config_schema);
    const config = encryptSecretFields(
      { url, description: `Demo ${dbType} datasource`, db_type: dbType },
      schema,
    );
    await internalQuery(
      `INSERT INTO workspace_plugins
         (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at, status)
       VALUES ($1, $2, $3, 'default', 'datasource', $4::jsonb, true, NOW(), 'published')
       ON CONFLICT (workspace_id, catalog_id, install_id)
         DO UPDATE SET config = EXCLUDED.config, status = 'published', updated_at = NOW()`,
      [`cn_${orgId}_default`, orgId, catalog.id, JSON.stringify(config)],
    );

    // Register in runtime
    if (connections.has("default")) connections.unregister("default");
    connections.register("default", { url, description: `Demo ${dbType} datasource` });

    log.info({ orgId, dbType }, "Dev seed: demo datasource connected");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Dev seed: failed to persist demo connection");
    return;
  }

  // Import semantic layer from disk
  try {
    const result = await importFromDisk(orgId, { sourceDir: getSemanticRoot() });
    _resetWhitelists();
    log.info({ orgId, imported: result.imported, skipped: result.skipped }, "Dev seed: semantic layer imported");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Dev seed: semantic layer import failed");
  }
}

/**
 * Backfill: if the dev admin user exists with the default password and
 * password_change_required is false, set the flag. Handles upgrades where
 * the column was added after the user was already seeded.
 */
async function backfillPasswordChangeFlag(): Promise<void> {
  const adminEmail = process.env.ATLAS_ADMIN_EMAIL?.toLowerCase().trim();
  if (!adminEmail) return;

  try {
    // Only backfill if the user exists and doesn't already have the flag set
    const rows = await internalQuery<{ id: string; password_change_required: boolean }>(
      `SELECT u.id, u.password_change_required FROM "user" u
       JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'credential'
       WHERE LOWER(u.email) = $1`,
      [adminEmail],
    );
    if (rows.length === 0 || rows[0].password_change_required) return;

    // Check if the password is still the default "atlas-dev"
    const account = await internalQuery<{ password: string }>(
      `SELECT password FROM "account" WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [rows[0].id],
    );
    if (account.length === 0 || !account[0].password) return;

    const isDefault = await Bun.password.verify("atlas-dev", account[0].password);
    if (!isDefault) return;

    await internalQuery(
      `UPDATE "user" SET password_change_required = true WHERE id = $1`,
      [rows[0].id],
    );
    log.info({ email: adminEmail }, "Backfill: flagged dev admin for password change");
  } catch (err) {
    log.debug({ err }, "Backfill password change flag skipped");
  }
}

/** Reset migration state. For testing only. */
export function resetMigrationState(): void {
  _migrated = false;
  _bootMigrated = false;
  _migrationError = null;
}
