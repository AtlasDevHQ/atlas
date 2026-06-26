/**
 * `atlas ops teardown-verify-accounts` — surgically tear down the throwaway
 * `/verify-prod-signup` test accounts (user + org + Stripe customer) left in a
 * region's internal DB after a 3-region residency verification (ADR-0024,
 * #3974). This is the operator-side cleanup half of the residency regression
 * gate: the verifier creates real prod accounts (`matt+<region>@useatlas.dev`,
 * workspace "Atlas <REGION> Verify") to exercise the signup funnel, and they
 * must be removed afterwards — including the EU/APAC accounts that the #3967
 * defect mislocated into the US DB.
 *
 * Why reuse, not re-implement: the per-org row set is large and grows (see
 * `hardDeleteWorkspace` in db/internal.ts — ~40 tables). Re-implementing that
 * cascade here would silently drift the moment a new org-scoped table lands,
 * leaving secrets/rows behind on a "torn-down" account. So this command binds
 * the internal-DB pool to the chosen region's DB and delegates to the same
 * three SSOT functions the platform-admin purge uses:
 *   1. `purgeStripeBillingForWorkspace` — cancel subs + delete the Stripe
 *      customer (a torn-down account must leave no billable Stripe linkage).
 *   2. `updateWorkspaceStatus(orgId, "deleted")` — the soft-delete precondition
 *      `hardDeleteWorkspace` enforces (it aborts unless the org is "deleted").
 *   3. `hardDeleteWorkspace` — the exhaustive GDPR-grade row purge, which also
 *      deletes the org's members and any now-orphaned user rows.
 *
 * Safety (this targets a PROD region DB):
 *   - One region DB per invocation (`--region` or `--database-url`); no silent
 *     DATABASE_URL fallback (the wrong-DB footgun the skill warns about).
 *   - DRY RUN by default. Executing requires BOTH `ATLAS_TEARDOWN_OK=1` and
 *     `--confirm` (the same double-gate as `ops wipe`).
 *   - Targets are explicit `--email` addresses — never a blind "delete every
 *     test-looking account". On execute, each must look like a throwaway
 *     plus-addressed verify account unless `--force` is passed, and the run
 *     refuses to execute against more than MAX_TEARDOWN_TARGETS orgs.
 *   - Non-owner memberships and orphan users are surfaced as warnings for
 *     manual follow-up, never silently mutated.
 */
import {
  internalQuery,
  closeInternalDB,
  updateWorkspaceStatus,
  hardDeleteWorkspace,
} from "@atlas/api/lib/db/internal";
import {
  purgeStripeBillingForWorkspace,
  type StripeTeardownOutcome,
} from "@atlas/api/lib/billing/workspace-teardown";
import { getFlag } from "../../lib/cli-utils";

/** Env var that, set to exactly "1", is one half of the execute double-gate. */
export const TEARDOWN_OK_ENV = "ATLAS_TEARDOWN_OK";

/**
 * Blast-radius cap. A throwaway verification run creates one account per
 * region (3), so a target set larger than this on EXECUTE is almost certainly
 * an operator mistake (a too-broad `--email` list) and is refused. Dry-run is
 * uncapped so an operator can preview any set.
 */
export const MAX_TEARDOWN_TARGETS = 12;

/** The real prod residency regions whose DB URL `--region` can resolve. */
export const REGION_DB_ENV = {
  us: "ATLAS_REGION_US_DB_URL",
  eu: "ATLAS_REGION_EU_DB_URL",
  apac: "ATLAS_REGION_APAC_DB_URL",
} as const;

export type TeardownRegion = keyof typeof REGION_DB_ENV;

/**
 * The execute double-gate, mirroring `checkWipeGate`. Returns null when the
 * run is cleared to EXECUTE (both gates present), or a human-readable reason
 * when it is not — in which case the caller falls back to a DRY RUN rather
 * than erroring, so a gate-less invocation safely previews instead of deleting.
 */
export function checkTeardownGate(args: string[], env: NodeJS.ProcessEnv): string | null {
  if (env[TEARDOWN_OK_ENV] !== "1") {
    return `${TEARDOWN_OK_ENV} is not set to 1`;
  }
  if (!args.includes("--confirm")) {
    return "--confirm was not passed";
  }
  return null;
}

/** Resolved region DB target — the URL plus a label for log lines. */
export interface ResolvedRegionDb {
  url: string;
  /** e.g. "--database-url" or "region eu (ATLAS_REGION_EU_DB_URL)". */
  source: string;
}

/**
 * Resolve which region DB to operate on. Precedence: an explicit
 * `--database-url` wins (escape hatch for a non-standard URL); otherwise
 * `--region <us|eu|apac>` maps to that region's `ATLAS_REGION_*_DB_URL`.
 * Returns an error string (never throws) when neither is usable — there is
 * deliberately NO fallback to a bare DATABASE_URL, so an operator can never
 * tear down the wrong DB by forgetting the flag.
 */
export function resolveRegionDbUrl(
  args: string[],
  env: NodeJS.ProcessEnv,
): ResolvedRegionDb | { error: string } {
  const explicit = getFlag(args, "--database-url");
  if (explicit) return { url: explicit, source: "--database-url" };

  const region = getFlag(args, "--region");
  if (region) {
    if (!(region in REGION_DB_ENV)) {
      return {
        error: `--region must be one of: ${Object.keys(REGION_DB_ENV).join(", ")} (got "${region}")`,
      };
    }
    const envVar = REGION_DB_ENV[region as TeardownRegion];
    const url = env[envVar];
    if (!url) {
      return { error: `--region ${region} requires ${envVar} to be set in the environment.` };
    }
    return { url, source: `region ${region} (${envVar})` };
  }

  return {
    error:
      "No region DB selected. Pass --region <us|eu|apac> (resolves ATLAS_REGION_<R>_DB_URL) " +
      "or --database-url <url>. There is no DATABASE_URL fallback — pick the region explicitly.",
  };
}

/**
 * Parse `--email` targets. Accepts the flag repeated and/or comma-separated
 * (`--email a@x.com,b@x.com --email c@x.com`), lower-cases and de-dupes.
 * Throws when no address is given — a teardown with no explicit target is
 * always operator error, never "delete everything".
 */
export function parseTargetEmails(args: string[]): string[] {
  const collected: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--email") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--email requires a value (e.g. --email matt+us@useatlas.dev)");
    }
    for (const part of value.split(",")) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) collected.push(trimmed);
    }
  }
  const deduped = [...new Set(collected)];
  if (deduped.length === 0) {
    throw new Error("At least one --email <addr> is required (the account(s) to tear down).");
  }
  return deduped;
}

/**
 * Whether an email looks like a throwaway `/verify-prod-signup` account. The
 * verifier always uses plus-addressing on a business domain
 * (`matt+us@useatlas.dev`), so a plus-tag is the cheap signature that
 * distinguishes a verification account from a real customer's primary address.
 * Used only to gate EXECUTE (overridable with `--force`); previews are
 * unrestricted.
 */
export function isThrowawayVerifyEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at);
  return local.includes("+");
}

/**
 * Throw when EXECUTE is requested against an address that doesn't look like a
 * throwaway verify account and `--force` was not passed — the guard against
 * fat-fingering a real customer's email into a prod teardown.
 */
export function assertTargetsAllowed(emails: string[], force: boolean): void {
  if (force) return;
  const suspicious = emails.filter((e) => !isThrowawayVerifyEmail(e));
  if (suspicious.length > 0) {
    throw new Error(
      `Refusing to tear down non-throwaway-looking address(es): ${suspicious.join(", ")}. ` +
        "Verification accounts are plus-addressed (e.g. matt+us@useatlas.dev). " +
        "Pass --force to override if you are certain.",
    );
  }
}

/** One org a target user belongs to, with the fields teardown needs. */
export interface VerifyOrg {
  orgId: string;
  orgName: string | null;
  orgSlug: string | null;
  region: string | null;
  workspaceStatus: string | null;
  stripeCustomerId: string | null;
  isOwner: boolean;
}

/** A resolved target: the user row (if any) for an email plus its orgs. */
export interface VerifyTarget {
  email: string;
  userId: string | null;
  found: boolean;
  orgs: VerifyOrg[];
}

/**
 * Total owned workspaces across resolved targets — the blast radius the
 * execute guard caps at {@link MAX_TEARDOWN_TARGETS}. Non-owner memberships
 * don't count (they're never torn down).
 */
export function countOwnedOrgs(targets: VerifyTarget[]): number {
  return targets.reduce((n, t) => n + t.orgs.filter((o) => o.isOwner).length, 0);
}

/** Minimal row-returning query surface — `internalQuery` or a test fake. */
export type RowQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

interface TargetRow extends Record<string, unknown> {
  userId: string;
  email: string;
  userName: string | null;
  memberRole: string | null;
  orgId: string | null;
  orgName: string | null;
  orgSlug: string | null;
  region: string | null;
  workspaceStatus: string | null;
  stripeCustomerId: string | null;
}

/**
 * Resolve each email to its user row and the orgs that user is a member of, in
 * the bound region DB. A LEFT JOIN so a user with no membership still resolves
 * (surfaced as `found: true, orgs: []`). `isOwner` is recorded so the
 * orchestration only purges workspaces the verify user owns — a shared
 * membership is reported, never deleted.
 */
export async function resolveVerifyTargets(
  query: RowQuery,
  emails: string[],
): Promise<VerifyTarget[]> {
  const targets: VerifyTarget[] = [];
  for (const email of emails) {
    const rows = await query<TargetRow>(
      `SELECT
         u.id                  AS "userId",
         u.email               AS "email",
         u.name                AS "userName",
         m.role                AS "memberRole",
         o.id                  AS "orgId",
         o.name                AS "orgName",
         o.slug                AS "orgSlug",
         o.region              AS "region",
         o.workspace_status    AS "workspaceStatus",
         o."stripeCustomerId"  AS "stripeCustomerId"
       FROM "user" u
       LEFT JOIN member m       ON m."userId" = u.id
       LEFT JOIN organization o ON o.id = m."organizationId"
       WHERE lower(u.email) = $1`,
      [email],
    );

    if (rows.length === 0) {
      targets.push({ email, userId: null, found: false, orgs: [] });
      continue;
    }

    const userId = rows[0]!.userId;
    const orgs: VerifyOrg[] = [];
    for (const r of rows) {
      if (!r.orgId) continue; // user with no membership (LEFT JOIN null row)
      orgs.push({
        orgId: r.orgId,
        orgName: r.orgName,
        orgSlug: r.orgSlug,
        region: r.region,
        workspaceStatus: r.workspaceStatus,
        stripeCustomerId: r.stripeCustomerId,
        isOwner: r.memberRole === "owner",
      });
    }
    targets.push({ email, userId, found: true, orgs });
  }
  return targets;
}

/** Per-org teardown outcome (one entry per owned org, plus reported skips). */
export interface OrgTeardownResult {
  orgId: string;
  orgName: string | null;
  region: string | null;
  stripeCustomerId: string | null;
  status: "torn-down" | "would-tear-down" | "skipped-not-owner" | "error";
  rowsPurged: number;
  stripeActions: string[];
  warnings: string[];
}

/** Per-email rollup. `warnings` covers the user-level cases (not found, no org). */
export interface TargetTeardownResult {
  email: string;
  userId: string | null;
  found: boolean;
  orgs: OrgTeardownResult[];
  warnings: string[];
}

export interface TeardownReport {
  dryRun: boolean;
  targets: TargetTeardownResult[];
  totals: {
    orgsTornDown: number;
    orgsWouldTearDown: number;
    rowsPurged: number;
    errors: number;
  };
}

/** Injected SSOT operations — real in the handler, fakes in unit tests.
 *  `hardDelete` returns the total rows purged; the handler sums the SSOT's
 *  per-table `HardDeleteResult` so the orchestration stays shape-agnostic. */
export interface TeardownDeps {
  purgeStripe: (orgId: string, stripeCustomerId: string | null) => Promise<StripeTeardownOutcome>;
  softDelete: (orgId: string) => Promise<boolean>;
  hardDelete: (orgId: string) => Promise<number>;
}

/**
 * Orchestrate the teardown across resolved targets. Pure of I/O wiring — every
 * side effect is an injected `deps` call, so unit tests drive it with fakes.
 *
 * For each owned org: cancel/delete Stripe FIRST (before the cascade destroys
 * the org row carrying `stripeCustomerId`), then soft-delete (the precondition
 * `hardDelete` enforces), then hard-delete the rows. A single org's failure is
 * recorded and the run continues — one stuck account never strands the rest.
 * Non-owner memberships and orphan users become warnings, never deletions.
 */
export async function teardownTargets(
  targets: VerifyTarget[],
  deps: TeardownDeps,
  dryRun: boolean,
): Promise<TeardownReport> {
  const results: TargetTeardownResult[] = [];
  const totals = { orgsTornDown: 0, orgsWouldTearDown: 0, rowsPurged: 0, errors: 0 };

  for (const target of targets) {
    const targetWarnings: string[] = [];
    const orgResults: OrgTeardownResult[] = [];

    if (!target.found) {
      targetWarnings.push(`No user row found for ${target.email} — nothing to tear down.`);
    } else if (target.orgs.length === 0) {
      targetWarnings.push(
        `User ${target.email} (${target.userId}) has no workspace membership — ` +
          "orphan user row left untouched; remove it manually if it is a verification artifact.",
      );
    }

    for (const org of target.orgs) {
      if (!org.isOwner) {
        orgResults.push({
          orgId: org.orgId,
          orgName: org.orgName,
          region: org.region,
          stripeCustomerId: org.stripeCustomerId,
          status: "skipped-not-owner",
          rowsPurged: 0,
          stripeActions: [],
          warnings: [
            `${target.email} is a non-owner member of workspace ${org.orgName ?? org.orgId} — left untouched.`,
          ],
        });
        continue;
      }

      if (dryRun) {
        orgResults.push({
          orgId: org.orgId,
          orgName: org.orgName,
          region: org.region,
          stripeCustomerId: org.stripeCustomerId,
          status: "would-tear-down",
          rowsPurged: 0,
          stripeActions: [],
          warnings: [],
        });
        totals.orgsWouldTearDown += 1;
        continue;
      }

      try {
        const stripe = await deps.purgeStripe(org.orgId, org.stripeCustomerId);
        await deps.softDelete(org.orgId);
        const rowsPurged = await deps.hardDelete(org.orgId);
        orgResults.push({
          orgId: org.orgId,
          orgName: org.orgName,
          region: org.region,
          stripeCustomerId: org.stripeCustomerId,
          status: "torn-down",
          rowsPurged,
          stripeActions: stripe.actions,
          warnings: stripe.warnings,
        });
        totals.orgsTornDown += 1;
        totals.rowsPurged += rowsPurged;
      } catch (err) {
        totals.errors += 1;
        orgResults.push({
          orgId: org.orgId,
          orgName: org.orgName,
          region: org.region,
          stripeCustomerId: org.stripeCustomerId,
          status: "error",
          rowsPurged: 0,
          stripeActions: [],
          warnings: [
            `Teardown failed for workspace ${org.orgName ?? org.orgId}: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
      }
    }

    results.push({
      email: target.email,
      userId: target.userId,
      found: target.found,
      orgs: orgResults,
      warnings: targetWarnings,
    });
  }

  return { dryRun, targets: results, totals };
}

/** Render the report as operator-facing console lines. */
export function printTeardownReport(report: TeardownReport): void {
  const banner = report.dryRun
    ? `DRY RUN — set ${TEARDOWN_OK_ENV}=1 and pass --confirm to execute`
    : "EXECUTE";
  console.log(`[ops:teardown-verify-accounts] ${banner}`);

  for (const target of report.targets) {
    console.log(`\n• ${target.email}${target.userId ? ` (user ${target.userId})` : ""}`);
    for (const w of target.warnings) console.log(`  ⚠ ${w}`);
    for (const org of target.orgs) {
      const tag = {
        "torn-down": "✓ torn down",
        "would-tear-down": "→ would tear down",
        "skipped-not-owner": "– skipped (not owner)",
        error: "✗ error",
      }[org.status];
      const region = org.region ? ` region=${org.region}` : "";
      const rows = org.status === "torn-down" ? ` (${org.rowsPurged} rows)` : "";
      console.log(`  ${tag}: ${org.orgName ?? org.orgId} [${org.orgId}]${region}${rows}`);
      if (org.stripeCustomerId) console.log(`     stripe customer: ${org.stripeCustomerId}`);
      for (const a of org.stripeActions) console.log(`     stripe: ${a}`);
      for (const w of org.warnings) console.log(`     ⚠ ${w}`);
    }
  }

  const t = report.totals;
  console.log(
    `\n[ops:teardown-verify-accounts] ${report.dryRun ? "would tear down" : "tore down"} ` +
      `${report.dryRun ? t.orgsWouldTearDown : t.orgsTornDown} workspace(s)` +
      (report.dryRun ? "" : `, ${t.rowsPurged} rows purged`) +
      (t.errors > 0 ? `, ${t.errors} error(s)` : ""),
  );
}

/** Wire the command: resolve gate/region/targets, bind the pool, run, report. */
export async function handleTeardownVerifyAccounts(args: string[]): Promise<void> {
  // DRY RUN unless the double-gate is satisfied AND --dry-run was not forced.
  const gateReason = checkTeardownGate(args, process.env);
  const dryRun = gateReason !== null || args.includes("--dry-run");
  const force = args.includes("--force");

  let emails: string[];
  try {
    emails = parseTargetEmails(args);
    if (!dryRun) assertTargetsAllowed(emails, force);
  } catch (err) {
    console.error(
      `[ops:teardown-verify-accounts] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const resolved = resolveRegionDbUrl(args, process.env);
  if ("error" in resolved) {
    console.error(`[ops:teardown-verify-accounts] ${resolved.error}`);
    process.exit(1);
  }

  // Bind the internal-DB pool to the chosen region DB. The reused SSOT
  // teardown functions all operate on the pool that getInternalDB() lazily
  // initializes from DATABASE_URL; nothing in this code path touches the pool
  // before this assignment, so it binds to the region we resolved (one-shot
  // CLI process). Set after resolution so a bad target never rebinds it.
  process.env.DATABASE_URL = resolved.url;
  console.log(
    `[ops:teardown-verify-accounts] target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"} · ${emails.length} email(s)`,
  );

  try {
    const targets = await resolveVerifyTargets(internalQuery, emails);

    // Blast-radius guard — only on EXECUTE. A preview can list any number.
    const ownedOrgCount = countOwnedOrgs(targets);
    if (!dryRun && ownedOrgCount > MAX_TEARDOWN_TARGETS) {
      console.error(
        `[ops:teardown-verify-accounts] Refusing to execute: ${ownedOrgCount} owned workspaces resolved ` +
          `(> ${MAX_TEARDOWN_TARGETS}). This looks too broad for a verification cleanup — narrow --email or re-check the target DB.`,
      );
      process.exitCode = 1;
      return;
    }

    const report = await teardownTargets(targets, {
      purgeStripe: purgeStripeBillingForWorkspace,
      softDelete: (orgId) => updateWorkspaceStatus(orgId, "deleted"),
      hardDelete: async (orgId) => {
        const purged = await hardDeleteWorkspace(orgId);
        return Object.values(purged).reduce((sum, n) => sum + n, 0);
      },
    }, dryRun);

    printTeardownReport(report);
    if (report.totals.errors > 0) process.exitCode = 1;
  } catch (err) {
    console.error(
      `[ops:teardown-verify-accounts] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await closeInternalDB().catch((closeErr) => {
      console.warn(
        `[ops:teardown-verify-accounts] connection close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
      );
    });
  }
}
