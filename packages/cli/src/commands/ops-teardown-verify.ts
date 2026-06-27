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
 * `hardDeleteWorkspace` in db/internal.ts — 50+ tables). Re-implementing that
 * cascade here would silently drift the moment a new org-scoped table lands,
 * leaving secrets/rows behind on a "torn-down" account. So this command binds
 * the internal-DB pool to the chosen region's DB and delegates to the same
 * three SSOT functions the platform-admin purge uses:
 *   1. `purgeStripeBillingForWorkspace` — cancel subs + delete the Stripe
 *      customer (a torn-down account must leave no billable Stripe linkage).
 *      The org's `organization."stripeCustomerId"` AND the user's
 *      `user.stripeCustomerId` are both unioned into the delete set: the
 *      @better-auth/stripe plugin's `createCustomerOnSignUp` parks a customer
 *      on the USER row at signup, so a trial verify account's only `cus_…`
 *      lives there while the org column is null — passing only the org id would
 *      tear the workspace down but orphan that customer (#4011).
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

/**
 * Whether this invocation is a DRY RUN (preview, no deletes). True unless the
 * execute double-gate is satisfied — and `--dry-run` always forces preview
 * even when the gate is open, so an operator can belt-and-braces a gated run.
 */
export function isDryRun(args: string[], env: NodeJS.ProcessEnv): boolean {
  return checkTeardownGate(args, env) !== null || args.includes("--dry-run");
}

/**
 * Resolved region DB target. Tagged union so the handler narrows on `ok`
 * rather than probing for an `error` key. `region` is the selected region key
 * when `--region` was used, or `null` for a raw `--database-url` (whose region
 * we can't know — see the note on the region label in `handleTeardownVerifyAccounts`).
 */
export type RegionDbResolution =
  | { ok: true; url: string; source: string; region: TeardownRegion | null }
  | { ok: false; error: string };

/**
 * Resolve which region DB to operate on. Precedence: an explicit
 * `--database-url` wins (escape hatch for a non-standard URL); otherwise
 * `--region <us|eu|apac>` maps to that region's `ATLAS_REGION_*_DB_URL`.
 * Returns `{ ok: false, error }` (never throws) when neither is usable — there
 * is deliberately NO fallback to a bare DATABASE_URL, so an operator can never
 * tear down the wrong DB by forgetting the flag.
 */
export function resolveRegionDbUrl(
  args: string[],
  env: NodeJS.ProcessEnv,
): RegionDbResolution {
  const explicit = getFlag(args, "--database-url");
  if (explicit) return { ok: true, url: explicit, source: "--database-url", region: null };

  const region = getFlag(args, "--region");
  if (region) {
    // Own-key check (not `in`, which walks the prototype chain and would let
    // `--region constructor` slip past) — keeps the runtime whitelist locked
    // to the `TeardownRegion` keyof so the cast below is provably sound.
    if (!Object.hasOwn(REGION_DB_ENV, region)) {
      return {
        ok: false,
        error: `--region must be one of: ${Object.keys(REGION_DB_ENV).join(", ")} (got "${region}")`,
      };
    }
    const regionKey = region as TeardownRegion;
    const envVar = REGION_DB_ENV[regionKey];
    const url = env[envVar];
    if (!url) {
      return { ok: false, error: `--region ${region} requires ${envVar} to be set in the environment.` };
    }
    return { ok: true, url, source: `region ${region} (${envVar})`, region: regionKey };
  }

  return {
    ok: false,
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
  /**
   * The customer id on the USER row (`user.stripeCustomerId`). The
   * @better-auth/stripe plugin's `createCustomerOnSignUp` parks a customer here
   * at signup before any org subscription exists, so for a trial verify account
   * this is populated while every owned org's `stripeCustomerId` is null (#4011).
   * Unioned into each *owned* org's Stripe purge; a user who owns no workspace
   * (zero or only non-owner memberships) is surfaced as a manual-cleanup warning
   * instead, since no purge can reach it.
   */
  userStripeCustomerId: string | null;
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

/**
 * The blast-radius guard: refuse to EXECUTE against more owned workspaces than
 * {@link MAX_TEARDOWN_TARGETS} — a verification run creates one account per
 * region, so a larger set is almost certainly a too-broad `--email` list or a
 * wrong DB where one address matches many orgs. Returns a refusal reason, or
 * null when the run may proceed. Dry-run is always uncapped (preview anything).
 */
export function checkBlastRadius(ownedOrgCount: number, dryRun: boolean): string | null {
  if (!dryRun && ownedOrgCount > MAX_TEARDOWN_TARGETS) {
    return (
      `Refusing to execute: ${ownedOrgCount} owned workspaces resolved (> ${MAX_TEARDOWN_TARGETS}). ` +
      "This looks too broad for a verification cleanup — narrow --email or re-check the target DB."
    );
  }
  return null;
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
  userStripeCustomerId: string | null;
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
         u."stripeCustomerId"  AS "userStripeCustomerId",
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
      targets.push({ email, userId: null, found: false, userStripeCustomerId: null, orgs: [] });
      continue;
    }

    const userId = rows[0]!.userId;
    const userStripeCustomerId = rows[0]!.userStripeCustomerId;
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
    targets.push({ email, userId, found: true, userStripeCustomerId, orgs });
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
  /** The user-row Stripe customer unioned into the org purges (#4011) — surfaced
   *  so a dry-run preview shows it will be deleted, not just the org-level id. */
  userStripeCustomerId: string | null;
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
    /** Orgs whose DB cascade succeeded but whose Stripe teardown left a
     *  warning (e.g. a customer that couldn't be deleted) — a non-clean
     *  outcome the handler exits non-zero on, even though the row purge ran. */
    stripeWarnings: number;
    /** Users carrying a `user.stripeCustomerId` who own no workspace, so no
     *  purge could reach it (#4011) — a live billable customer the run can't
     *  delete. Counted so the handler exits non-zero rather than reporting a
     *  clean teardown while an orphan `cus_…` survives (a scripted/CI cleanup
     *  must fail loudly). The customer id is in the per-target warning. */
    orphanedUserCustomers: number;
  };
}

/** Injected SSOT operations — real in the handler, fakes in unit tests.
 *  `hardDelete` returns the total rows purged; the handler sums the SSOT's
 *  per-table `HardDeleteResult` so the orchestration stays shape-agnostic. */
export interface TeardownDeps {
  purgeStripe: (
    orgId: string,
    stripeCustomerId: string | null,
    extraCustomerIds: readonly string[],
  ) => Promise<StripeTeardownOutcome>;
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
 *
 * The user's `user.stripeCustomerId` is unioned into each owned org's Stripe
 * purge (#4011): the @better-auth/stripe plugin's `createCustomerOnSignUp`
 * parks a customer on the user row at signup, so a trial verify account carries
 * a live `cus_…` there while every org column is null — passing only the org id
 * would tear the workspace down but orphan that customer. The purge de-dupes
 * and treats `resource_missing` as success, so attaching it to each owned org
 * (rather than guessing one) can't double-delete or strand it.
 */
export async function teardownTargets(
  targets: VerifyTarget[],
  deps: TeardownDeps,
  dryRun: boolean,
): Promise<TeardownReport> {
  const results: TargetTeardownResult[] = [];
  const totals = {
    orgsTornDown: 0,
    orgsWouldTearDown: 0,
    rowsPurged: 0,
    errors: 0,
    stripeWarnings: 0,
    orphanedUserCustomers: 0,
  };

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

    // The user-level customer is unioned into the purge of every OWNED org (see
    // the loop below). When the user owns NO workspace — whether they have zero
    // memberships or only non-owner ones — no purge reaches it, so a live `cus_…`
    // would be silently left behind (the exact #4011 orphaning, via a different
    // topology). Warn loudly in that case rather than reporting a clean teardown.
    const ownsAnyWorkspace = target.orgs.some((o) => o.isOwner);
    if (target.found && target.userStripeCustomerId && !ownsAnyWorkspace) {
      targetWarnings.push(
        `User ${target.email} carries a Stripe customer ${target.userStripeCustomerId} but owns no ` +
          "workspace to purge — delete it manually in the Stripe dashboard so it isn't orphaned.",
      );
      // Counted into totals so the handler exits non-zero: a surviving billable
      // customer is a non-clean outcome a scripted/CI cleanup must not pass over.
      totals.orphanedUserCustomers += 1;
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
        const stripe = await deps.purgeStripe(
          org.orgId,
          org.stripeCustomerId,
          target.userStripeCustomerId ? [target.userStripeCustomerId] : [],
        );
        // softDelete returns false when no row matched (e.g. the org was
        // concurrently reactivated/removed between resolve and execute). Surface
        // that as the cause rather than letting hardDelete throw the downstream
        // "not in deleted status" error with a misattributed message.
        const softDeleted = await deps.softDelete(org.orgId);
        const warnings = [...stripe.warnings];
        if (!softDeleted) {
          warnings.push(
            "Soft-delete affected 0 rows (org concurrently reactivated or removed?) — hard-delete may abort.",
          );
        }
        const rowsPurged = await deps.hardDelete(org.orgId);
        orgResults.push({
          orgId: org.orgId,
          orgName: org.orgName,
          region: org.region,
          stripeCustomerId: org.stripeCustomerId,
          status: "torn-down",
          rowsPurged,
          stripeActions: stripe.actions,
          warnings,
        });
        totals.orgsTornDown += 1;
        totals.rowsPurged += rowsPurged;
        if (stripe.warnings.length > 0) totals.stripeWarnings += 1;
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
      userStripeCustomerId: target.userStripeCustomerId,
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
    if (target.userStripeCustomerId) {
      // The customer is unioned into a purge only when the user owns a workspace;
      // an owner-less user gets the manual-cleanup warning below instead, so the
      // parenthetical must reflect which case this is (a "skipped-not-owner" or
      // empty org list means no purge reached it).
      const reached = target.orgs.some((o) => o.status !== "skipped-not-owner");
      const note = reached
        ? "(unioned into owned-org purge)"
        : "(NOT reached by any purge — see warning below)";
      console.log(`  user stripe customer: ${target.userStripeCustomerId} ${note}`);
    }
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
      (t.stripeWarnings > 0 ? `, ${t.stripeWarnings} workspace(s) with Stripe warnings` : "") +
      (t.orphanedUserCustomers > 0
        ? `, ${t.orphanedUserCustomers} orphaned user-level Stripe customer(s) needing manual deletion`
        : "") +
      (t.errors > 0 ? `, ${t.errors} error(s)` : ""),
  );
}

/** Wire the command: resolve gate/region/targets, bind the pool, run, report. */
export async function handleTeardownVerifyAccounts(args: string[]): Promise<void> {
  // DRY RUN unless the execute double-gate is satisfied AND --dry-run wasn't forced.
  const dryRun = isDryRun(args, process.env);
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
  if (!resolved.ok) {
    console.error(`[ops:teardown-verify-accounts] ${resolved.error}`);
    process.exit(1);
  }

  // Bind the internal-DB pool to the chosen region DB. The reused SSOT teardown
  // functions all operate on the pool getInternalDB() lazily initializes from
  // DATABASE_URL. Close any pre-bound pool FIRST so this rebind is authoritative
  // rather than a silent no-op against a previously-bound DB — the wrong-DB
  // footgun would otherwise delete from the wrong region. (In the normal
  // one-shot CLI path no pool exists yet, so this is a cheap no-op.)
  await closeInternalDB().catch(() => {
    // intentionally ignored: best-effort discard of any pre-bound pool before
    // rebinding; a close failure here doesn't change which URL the next
    // getInternalDB() binds to.
  });
  process.env.DATABASE_URL = resolved.url;
  console.log(
    `[ops:teardown-verify-accounts] target DB: ${resolved.source} · ${dryRun ? "DRY RUN" : "EXECUTE"} · ${emails.length} email(s)`,
  );

  try {
    const targets = await resolveVerifyTargets(internalQuery, emails);

    // Deliberately NO "org.region must equal --region" guard: the stamped
    // organization.region label is exactly the untrustworthy #3967 artifact this
    // tool cleans up (an EU/APAC label on a row mislocated in the US DB). The
    // physical DB selected by --region/--database-url is the ground truth; the
    // label is surfaced in the report as mislocation evidence, never gated on.

    // Blast-radius guard — only on EXECUTE. A preview can list any number.
    const blastRefusal = checkBlastRadius(countOwnedOrgs(targets), dryRun);
    if (blastRefusal) {
      console.error(`[ops:teardown-verify-accounts] ${blastRefusal}`);
      process.exitCode = 1;
      return;
    }

    const report = await teardownTargets(targets, {
      purgeStripe: purgeStripeBillingForWorkspace,
      softDelete: (orgId) => updateWorkspaceStatus(orgId, "deleted"),
      hardDelete: async (orgId) => {
        const purged = await hardDeleteWorkspace(orgId);
        // HardDeleteResult is an all-number per-table count map; assert that so
        // the sum can't silently become NaN/string-concat if a non-number field
        // is ever added (Object.values on an index-signature-less type widens to any).
        return (Object.values(purged) as number[]).reduce((sum, n) => sum + n, 0);
      },
    }, dryRun);

    printTeardownReport(report);
    // Exit non-zero on a row-purge error, a left-behind Stripe linkage, OR an
    // orphaned user-level customer that no purge could reach — a scripted
    // cleanup must fail loudly rather than report a clean "success" while a
    // billable Stripe customer survives. A failed customer-delete /
    // subscription-cancel is enqueued in `stripe_teardown_pending` for durable
    // retry; some warnings (a subscription-read or outbox-write failure, or an
    // owner-less user-level customer) are manual-follow-up only — either way the
    // operator/CI should know it didn't fully complete.
    if (
      report.totals.errors > 0 ||
      report.totals.stripeWarnings > 0 ||
      report.totals.orphanedUserCustomers > 0
    ) {
      process.exitCode = 1;
    }
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
