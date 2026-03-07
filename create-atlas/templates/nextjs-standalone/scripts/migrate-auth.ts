/**
 * Build-time auth migration for Vercel deployments.
 *
 * On Vercel, there is no persistent server boot — the Hono app runs inside
 * a serverless catch-all route. The standalone server (server.ts) normally
 * calls migrateAuthTables() at boot, but that code path is never hit on
 * Vercel. This script bridges the gap by running the same migration at
 * build time, right after seed-demo.ts.
 *
 * Creates Better Auth tables (user, session, account, etc.), the audit_log
 * table, and seeds a dev admin account when ATLAS_ADMIN_EMAIL is set.
 */

import { migrateAuthTables } from "@atlas/api/lib/auth/migrate";

try {
  await migrateAuthTables();
  console.log("migrate-auth: complete");
} catch (err) {
  console.error(
    "migrate-auth: failed —",
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
}
