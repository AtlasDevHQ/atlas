/**
 * Better Auth table migration — runs once at server boot.
 *
 * Extracted from validateEnvironment() so the startup diagnostics
 * function stays pure (diagnose-only, never mutate). The Hono server
 * entry point (server.ts) calls migrateAuthTables() once on startup.
 */

import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth-migrate");

let _migrated = false;
let _migrationError: string | null = null;

/** Return the last migration error message, or null if migrations succeeded (or haven't run). */
export function getMigrationError(): string | null {
  return _migrationError;
}

/**
 * Run Better Auth table migrations (user, session, account, etc.)
 * if managed auth mode is active and DATABASE_URL is configured.
 *
 * Safe to call multiple times — only runs once (idempotent guard).
 * Also runs the internal DB migration (audit_log table).
 */
export async function migrateAuthTables(): Promise<void> {
  if (_migrated) return;

  // Internal DB migration (audit_log) — runs regardless of auth mode
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

  // Better Auth migration — only in managed mode
  const authMode = detectAuthMode();
  if (authMode !== "managed") {
    _migrated = true;
    return;
  }

  if (!hasInternalDB()) {
    log.error(
      "Managed auth mode requires DATABASE_URL for session storage. Skipping auth migration.",
    );
    _migrated = true;
    return;
  }

  try {
    const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
    const auth = getAuthInstance();
    const ctx = await auth.$context;
    await ctx.runMigrations();
    log.info("Better Auth migration complete");

    // Add password_change_required column to Better Auth's user table.
    // Must run AFTER Better Auth migrations (which create the "user" table).
    try {
      await internalQuery(
        `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT false`,
      );
    } catch {
      log.warn("Could not add password_change_required column — password change enforcement will be skipped");
    }

    await bootstrapAdminUser();
    await seedDevUser(auth);
    await backfillPasswordChangeFlag();
  } catch (err) {
    log.error({ err }, "Better Auth migration failed — managed auth may not work");
    _migrationError = "Connected to the internal database but Better Auth migration failed. Managed auth may not work. Check database permissions (CREATE TABLE).";
  }

  _migrated = true;
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
      `SELECT COUNT(*) as count FROM "user" WHERE role = 'admin'`,
    );
    if (parseInt(String(existing[0]?.count ?? "0"), 10) > 0) {
      log.debug("Bootstrap: admin user already exists — skipping promotion");
      return;
    }

    const result = await internalQuery<{ id: string; email: string }>(
      `UPDATE "user" SET role = 'admin' WHERE LOWER(email) = $1 RETURNING id, email`,
      [adminEmail],
    );
    if (result.length > 0) {
      log.info({ email: result[0].email, id: result[0].id }, "Bootstrap: existing user promoted to admin via ATLAS_ADMIN_EMAIL");
    } else {
      log.warn({ adminEmail }, "Bootstrap: ATLAS_ADMIN_EMAIL is set but no user with that email exists yet — role will be assigned on first signup");
    }
  } catch (err) {
    log.error({ err }, "Bootstrap admin promotion failed — admin console may be inaccessible");
  }
}

/**
 * Seed a default dev admin account when no users exist.
 * Only runs when ATLAS_ADMIN_EMAIL is set — uses that email with a
 * well-known password ("atlas-dev"). The databaseHook in server.ts
 * promotes this user to admin on creation.
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

    // Use Better Auth's createUser API (from the admin plugin)
    const createUser = auth.api.createUser as (opts: {
      body: { email: string; password: string; name: string; role: string };
    }) => Promise<unknown>;

    await createUser({
      body: {
        email: adminEmail,
        password: "atlas-dev",
        name: "Atlas Admin",
        role: "admin",
      },
    });

    // Mark the seeded user as requiring a password change
    await internalQuery(
      `UPDATE "user" SET password_change_required = true WHERE LOWER(email) = $1`,
      [adminEmail],
    );

    log.info({ email: adminEmail }, "Dev admin account seeded (password: atlas-dev)");
  } catch (err) {
    // User might already exist from a previous partial boot — not fatal
    log.debug({ err }, "Dev user seed skipped or failed");
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
  _migrationError = null;
}
