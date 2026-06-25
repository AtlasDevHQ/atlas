/**
 * Onboarding email engine.
 *
 * Orchestrates the drip campaign: tracks which emails have been sent per user,
 * resolves branding, renders templates, and dispatches via delivery layer.
 * Also handles time-based fallback nudges and unsubscribe.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { resolveOnboardingEmailsEnabled } from "@atlas/api/lib/env-profile";
import type { OnboardingEmailStep, OnboardingMilestone, OnboardingEmailTrigger, OnboardingEmailStatus } from "@useatlas/types";
import { BUILTIN_DATASOURCE_CATALOG_SLUGS } from "@atlas/api/lib/db/datasource-pool-resolver";
import { ONBOARDING_SEQUENCE, MILESTONE_TO_STEP } from "./sequence";
import { renderOnboardingEmail } from "./templates";
import { sendEmail } from "./delivery";
import { signUnsubscribeToken, getUnsubscribeTokenTtlMs } from "./unsubscribe-token";
import { Effect, Duration } from "effect";
import { normalizeError } from "@atlas/api/lib/effect/errors";

const log = createLogger("onboarding-email");

/**
 * Check whether the onboarding email feature is enabled.
 *
 * Per-env default lives in {@link import("@atlas/api/lib/env-profile").EnvProfile}
 * — `production` defaults to enabled, `staging`/`development` default to
 * disabled. The `ATLAS_ONBOARDING_EMAILS_ENABLED` env var still
 * overrides the profile default when set.
 *
 * The `hasInternalDB()` gate is independent of the env-var/profile
 * decision — onboarding scheduler tasks need the internal DB to persist
 * dispatch state, so even an enabled profile is a no-op without it.
 */
export function isOnboardingEmailEnabled(): boolean {
  return resolveOnboardingEmailsEnabled() && hasInternalDB();
}

// ── Branding resolution ─────────────────────────────────────────────

/** Exported for the trial-expiry engine, which renders branded notices too. */
export async function getBrandingForOrg(orgId: string) {
  try {
    const rows = await internalQuery<{
      logo_url: string | null;
      logo_text: string | null;
      primary_color: string | null;
      favicon_url: string | null;
      hide_atlas_branding: boolean;
    }>(
      `SELECT logo_url, logo_text, primary_color, favicon_url, hide_atlas_branding
       FROM workspace_branding WHERE org_id = $1 LIMIT 1`,
      [orgId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      logoUrl: r.logo_url,
      logoText: r.logo_text,
      primaryColor: r.primary_color,
      faviconUrl: r.favicon_url,
      hideAtlasBranding: r.hide_atlas_branding,
    };
  } catch (err) {
    log.warn({ orgId, err: err instanceof Error ? err.message : String(err) }, "Failed to fetch branding — using defaults");
    return null;
  }
}

// ── Sent tracking ───────────────────────────────────────────────────

async function getSentSteps(userId: string): Promise<OnboardingEmailStep[]> {
  const rows = await internalQuery<{ step: string }>(
    `SELECT step FROM onboarding_emails WHERE user_id = $1`,
    [userId],
  );
  // The table is shared with trial-expiry notices (#3434, `trial_*` steps);
  // filter to the onboarding union so trial rows never leak into the
  // OnboardingEmailStep-typed drip/admin views.
  const onboardingSteps = new Set<string>(ONBOARDING_SEQUENCE.map((s) => s.step));
  return rows.map((r) => r.step).filter((s): s is OnboardingEmailStep => onboardingSteps.has(s));
}

/**
 * Triggers under which a recorded `onboarding_emails` row means an email was
 * actually dispatched — the welcome send (`signup_completed`) and time-based
 * fallback nudges (`time_based`). Every *other* trigger is a satisfaction
 * marker: the step is complete for drip-progression purposes but no message
 * went out. See {@link getSuppressedSteps}.
 */
const EMAIL_SENT_TRIGGERS = new Set<OnboardingEmailTrigger>(["signup_completed", "time_based"]);

/**
 * Steps a user completed WITHOUT an email being dispatched — recorded via
 * {@link markStepSatisfied}, not a real send.
 *
 * A row in `onboarding_emails` historically meant "this email was sent", and the
 * admin status view treats {@link getSentSteps} that way. Two paths break that
 * 1:1, and both record a satisfaction marker instead of sending:
 *   - demo activation (#3949) — `connect_database` satisfied by the bundled demo
 *     (trigger `demo_activated`);
 *   - reaching any action milestone (#3962) — e.g. answering a first query
 *     satisfies `first_query`, inviting a teammate satisfies `invite_team`, etc.
 *     {@link onMilestoneReached} suppresses the now-moot "go do X" nudge rather
 *     than mailing it back to a user who just did X (trigger = the milestone).
 *
 * Both are "completed, no email", so the suppressed subset is everything
 * recorded whose trigger is NOT an {@link EMAIL_SENT_TRIGGERS} member. The
 * admin view can then label "satisfied (no email)" distinctly from "sent". The
 * completed-step partition (sent + suppressed → pending) is unchanged, so the
 * drip-progression semantics `getSentSteps` drives are intact.
 *
 * (Rows written before #3962 by the old send-on-milestone behavior carry a
 * milestone trigger yet did dispatch an email; this reclassifies them as
 * suppressed in the admin view. Cosmetic only — no live drip decision reads
 * the suppressed/sent split — and the onboarding-email feature is recent, so
 * the affected history is small. No backfill.)
 */
async function getSuppressedSteps(userId: string): Promise<OnboardingEmailStep[]> {
  const rows = await internalQuery<{ step: string; triggered_by: string }>(
    `SELECT step, triggered_by FROM onboarding_emails WHERE user_id = $1`,
    [userId],
  );
  const onboardingSteps = new Set<string>(ONBOARDING_SEQUENCE.map((s) => s.step));
  return rows
    .filter((r) => !EMAIL_SENT_TRIGGERS.has(r.triggered_by as OnboardingEmailTrigger))
    .map((r) => r.step)
    .filter((s): s is OnboardingEmailStep => onboardingSteps.has(s));
}

/**
 * Whether this workspace is on the bundled demo and has NOT connected its own
 * production SQL database — true when a published `__demo__` datasource install
 * exists and no non-demo *SQL* one does. Drives demo-aware email copy (#3962):
 * a demo-only workspace must never receive the `first_query` nudge asserting
 * "your database is connected" (and "Atlas will translate it to SQL").
 *
 * "Real" is the positive SQL allowlist `BUILTIN_DATASOURCE_CATALOG_SLUGS` (the
 * catalog slugs ConnectionRegistry resolves into a SQL pool — postgres, mysql,
 * snowflake, …, INCLUDING `demo-postgres`, which the `install_id <> '__demo__'`
 * filter then excludes), NOT merely "any non-demo datasource". A REST/OpenAPI
 * datasource (`openapi-generic`) is `pillar = 'datasource'` too but is
 * deliberately OUT of that allowlist — it has no SQL pool — so a demo + REST
 * workspace stays demo-only and keeps demo copy rather than getting the
 * SQL-centric "your database is connected" claim (which would be false: no SQL
 * DB is connected). Any future non-SQL query layer is excluded for free by the
 * same allowlist. `bool_or` over zero rows is NULL → false.
 *
 * This reads the live datasource install state (`workspace_plugins`), NOT the
 * onboarding drip's `demo_activated` marker, deliberately. The marker is a
 * per-user, write-once record: the `(user_id, step)` unique index means a later
 * real `database_connected` can never overwrite it, and the admin-console
 * connect path doesn't fire that milestone at all — so a workspace that
 * *graduates* from the demo to its own DB would keep looking "demo-only" by the
 * marker forever. The install state is org-scoped ground truth that flips
 * correctly however the real datasource was added, and a workspace with no
 * datasource at all reads false (BYO default) rather than a false "demo loaded"
 * claim.
 *
 * Defaults to false (BYO copy) on any read error — the same safe default the
 * BYO drip already assumes.
 */
async function isDemoOnlyWorkspace(orgId: string): Promise<boolean> {
  try {
    const rows = await internalQuery<{ has_demo: boolean | null; has_real_sql: boolean | null }>(
      `SELECT bool_or(wp.install_id = '__demo__') AS has_demo,
              bool_or(wp.install_id <> '__demo__' AND pc.slug = ANY($2)) AS has_real_sql
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.workspace_id = $1 AND wp.pillar = 'datasource' AND wp.status = 'published'`,
      [orgId, BUILTIN_DATASOURCE_CATALOG_SLUGS as readonly string[]],
    );
    const row = rows[0];
    return Boolean(row?.has_demo) && !row?.has_real_sql;
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to resolve demo-only status — defaulting to BYO email copy",
    );
    return false;
  }
}

async function isUnsubscribed(userId: string): Promise<boolean> {
  const rows = await internalQuery<{ onboarding_emails: boolean }>(
    `SELECT onboarding_emails FROM email_preferences WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) return false;
  return !rows[0].onboarding_emails;
}

async function recordSentEmail(
  userId: string,
  orgId: string,
  step: OnboardingEmailStep,
  triggeredBy: OnboardingEmailTrigger,
): Promise<void> {
  await internalQuery(
    `INSERT INTO onboarding_emails (user_id, org_id, step, triggered_by, sent_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, step) DO NOTHING`,
    [userId, orgId, step, triggeredBy],
  );
}

// ── Core send logic ─────────────────────────────────────────────────

/** Exported for the trial-expiry engine. */
export function getBaseUrl(): string {
  return process.env.BETTER_AUTH_URL
    ?? process.env.NEXT_PUBLIC_ATLAS_API_URL
    ?? "http://localhost:3000";
}

function buildUnsubscribeUrl(userId: string): string {
  const base = getBaseUrl();
  const expiresAt = Date.now() + getUnsubscribeTokenTtlMs();
  const token = signUnsubscribeToken(userId, expiresAt);
  const params = new URLSearchParams({ userId });
  if (token) {
    params.set("token", token);
  } else {
    // BETTER_AUTH_SECRET unset — startup.ts should have already rejected boot,
    // so emitting a bare userId here means a misconfigured test or ops env.
    // Log loudly but still emit the URL so the email sends; the routes will
    // reject unsigned tokens, which is the correct fail-closed behavior.
    log.error({ userId }, "Building unsubscribe URL without signature: BETTER_AUTH_SECRET missing");
  }
  return `${base}/api/v1/onboarding-emails/unsubscribe?${params.toString()}`;
}

/**
 * Send a specific onboarding email to a user, if not already sent.
 *
 * @returns true if the email was sent, false if skipped (already sent, unsubscribed, etc.)
 */
export async function sendOnboardingEmail(
  userId: string,
  email: string,
  orgId: string,
  step: OnboardingEmailStep,
  triggeredBy: OnboardingEmailTrigger,
): Promise<boolean> {
  if (!isOnboardingEmailEnabled()) {
    log.debug({ userId, step }, "Onboarding emails disabled — skipping");
    return false;
  }

  try {
    // Check unsubscribe
    if (await isUnsubscribed(userId)) {
      log.debug({ userId, step }, "User unsubscribed — skipping");
      return false;
    }

    // Check already sent
    const sent = await getSentSteps(userId);
    if (sent.includes(step)) {
      log.debug({ userId, step }, "Email already sent — skipping");
      return false;
    }

    // Resolve branding + demo-awareness. A demo-only signup connected the
    // bundled demo, not their own production DB, so the copy must not assert
    // "your database is connected" (#3962). Independent reads — run together.
    const [branding, demoMode] = await Promise.all([
      getBrandingForOrg(orgId),
      isDemoOnlyWorkspace(orgId),
    ]);
    const baseUrl = getBaseUrl();
    const unsubscribeUrl = buildUnsubscribeUrl(userId);

    // Render and send
    const rendered = renderOnboardingEmail(step, baseUrl, unsubscribeUrl, branding, { demoMode });
    const result = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
    }, orgId);

    if (result.success) {
      await recordSentEmail(userId, orgId, step, triggeredBy);
      log.info({ userId, step, provider: result.provider }, "Onboarding email sent");
      return true;
    }

    log.error({ userId, step, error: result.error }, "Onboarding email delivery failed");
    return false;
  } catch (err) {
    log.error(
      { userId, step, err: err instanceof Error ? err.message : String(err) },
      "Error sending onboarding email",
    );
    return false;
  }
}

// ── Milestone trigger ───────────────────────────────────────────────

/**
 * Called when a user hits an action onboarding milestone (connected a DB, ran
 * their first query, invited a teammate, explored a feature).
 *
 * Marks the corresponding step satisfied WITHOUT sending its email — it does
 * NOT dispatch the step's nudge. Every non-welcome step in the sequence is a
 * "go do X" prompt; reaching its milestone means the user already did X, so
 * mailing the nudge in the same breath is backwards (it surfaced live as a
 * demo-only signup getting "ask your first question" the instant they asked —
 * #3962). The nudge therefore exists ONLY as the time-based fallback in
 * {@link checkFallbackEmails}, fired when the milestone is NOT reached in time;
 * recording the step here suppresses that fallback. This generalizes the
 * demo-activation suppression from #3949 to every action milestone.
 *
 * The sole proactive send is `welcome` (the `signup_completed` milestone),
 * which {@link onUserSignup} dispatches directly via {@link sendOnboardingEmail}
 * and never routes through here.
 */
export async function onMilestoneReached(
  milestone: OnboardingMilestone,
  userId: string,
  orgId: string,
): Promise<void> {
  const step = MILESTONE_TO_STEP.get(milestone);
  if (!step) {
    log.warn({ milestone }, "No email step mapped for milestone");
    return;
  }

  await markStepSatisfied(userId, orgId, step, milestone);
}

// ── Step satisfaction (no email) ────────────────────────────────────

/**
 * Mark an onboarding step as satisfied WITHOUT sending its email.
 *
 * Records the step in `onboarding_emails` (idempotent via the
 * `(user_id, step)` unique index) so the drip advances past it and the
 * time-based fallback nudge in {@link checkFallbackEmails} skips it — but
 * never renders or dispatches a template.
 *
 * Used by the demo-activation path (#3949): a demo-only signup never
 * connects their *own* database, so firing the `database_connected`
 * milestone would send the misleading "Connect your database" email. Marking
 * the `connect_database` step satisfied suppresses both that send and the 24h
 * nudge while keeping the rest of the sequence on schedule.
 *
 * @returns true if a row was recorded (or already present), false if skipped
 *   (feature disabled, unsubscribed).
 */
export async function markStepSatisfied(
  userId: string,
  orgId: string,
  step: OnboardingEmailStep,
  triggeredBy: OnboardingEmailTrigger,
): Promise<boolean> {
  if (!isOnboardingEmailEnabled()) {
    log.debug({ userId, step }, "Onboarding emails disabled — skipping step-satisfy");
    return false;
  }

  try {
    // Respect unsubscribe for symmetry with sendOnboardingEmail: an
    // unsubscribed user gets no drip rows written on their behalf.
    if (await isUnsubscribed(userId)) {
      log.debug({ userId, step }, "User unsubscribed — skipping step-satisfy");
      return false;
    }

    await recordSentEmail(userId, orgId, step, triggeredBy);
    log.info({ userId, step, triggeredBy }, "Onboarding step marked satisfied (no email sent)");
    return true;
  } catch (err) {
    log.error(
      { userId, step, err: err instanceof Error ? err.message : String(err) },
      "Error marking onboarding step satisfied",
    );
    return false;
  }
}

// ── Time-based fallback check ───────────────────────────────────────

/**
 * Check all users for time-based fallback emails.
 * Called periodically by the scheduler tick.
 *
 * For each user in the onboarding window, checks if any sequence step
 * is due based on signup time + fallbackHours, and sends it if so.
 */
export async function checkFallbackEmails(): Promise<{ checked: number; sent: number }> {
  if (!isOnboardingEmailEnabled()) {
    return { checked: 0, sent: 0 };
  }

  try {
    // Find users who signed up in the last 14 days and haven't completed all steps.
    // We use the user table's createdAt to determine signup time.
    const users = await internalQuery<{
      id: string;
      email: string;
      created_at: string;
    }>(
      `SELECT u.id, u.email, u."createdAt" as created_at
       FROM "user" u
       WHERE u."createdAt" > now() - interval '14 days'
         AND NOT EXISTS (
           SELECT 1 FROM email_preferences ep
           WHERE ep.user_id = u.id AND ep.onboarding_emails = false
         )
       LIMIT 100`,
    );

    let sent = 0;

    for (const user of users) {
      // Get user's org (first membership)
      const memberships = await internalQuery<{ organizationId: string }>(
        `SELECT "organizationId" FROM member WHERE "userId" = $1 LIMIT 1`,
        [user.id],
      );
      if (memberships.length === 0) continue;

      const orgId = memberships[0].organizationId;
      const sentSteps = await getSentSteps(user.id);
      const signupTime = new Date(user.created_at).getTime();
      const now = Date.now();

      for (const seqStep of ONBOARDING_SEQUENCE) {
        if (sentSteps.includes(seqStep.step)) continue;
        if (seqStep.fallbackHours === 0) continue; // welcome is immediate, not a fallback

        const dueAt = signupTime + seqStep.fallbackHours * 60 * 60 * 1000;
        if (now >= dueAt) {
          const didSend = await sendOnboardingEmail(
            user.id,
            user.email,
            orgId,
            seqStep.step,
            "time_based",
          );
          if (didSend) sent++;
          // Only send one fallback per user per tick to avoid flooding
          break;
        }
      }
    }

    log.info({ checked: users.length, sent }, "Fallback email check complete");
    return { checked: users.length, sent };
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Error checking fallback emails",
    );
    return { checked: 0, sent: 0 };
  }
}

// ── Unsubscribe ─────────────────────────────────────────────────────

export async function unsubscribeUser(userId: string): Promise<void> {
  await internalQuery(
    `INSERT INTO email_preferences (user_id, onboarding_emails, updated_at)
     VALUES ($1, false, now())
     ON CONFLICT (user_id)
     DO UPDATE SET onboarding_emails = false, updated_at = now()`,
    [userId],
  );
  log.info({ userId }, "User unsubscribed from onboarding emails");
}

export async function resubscribeUser(userId: string): Promise<void> {
  await internalQuery(
    `INSERT INTO email_preferences (user_id, onboarding_emails, updated_at)
     VALUES ($1, true, now())
     ON CONFLICT (user_id)
     DO UPDATE SET onboarding_emails = true, updated_at = now()`,
    [userId],
  );
  log.info({ userId }, "User resubscribed to onboarding emails");
}

// ── Admin query ─────────────────────────────────────────────────────

const ALL_STEPS: OnboardingEmailStep[] = ONBOARDING_SEQUENCE.map((s) => s.step);

/**
 * Get onboarding email status for users in an organization.
 * Used by the admin API.
 */
export async function getOnboardingStatuses(
  orgId: string,
  limit = 50,
  offset = 0,
): Promise<{ statuses: OnboardingEmailStatus[]; total: number }> {
  const countRows = await internalQuery<{ count: string }>(
    `SELECT COUNT(DISTINCT m."userId") as count
     FROM member m WHERE m."organizationId" = $1`,
    [orgId],
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const users = await internalQuery<{
    user_id: string;
    email: string;
    created_at: string;
  }>(
    `SELECT m."userId" as user_id, u.email, u."createdAt" as created_at
     FROM member m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1
     ORDER BY u."createdAt" DESC
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset],
  );

  const statuses = await Effect.runPromise(
    Effect.forEach(
      users,
      (user) =>
        Effect.all([
          Effect.tryPromise({
            try: () => getSentSteps(user.user_id),
            catch: normalizeError,
          }),
          Effect.tryPromise({
            try: () => isUnsubscribed(user.user_id),
            catch: normalizeError,
          }),
          Effect.tryPromise({
            try: () => getSuppressedSteps(user.user_id),
            catch: normalizeError,
          }),
        ], { concurrency: "unbounded" }).pipe(
          // `sentSteps` from getSentSteps is every recorded step (the
          // completed-vs-pending partition the drip relies on). `suppressedSteps`
          // is the subset satisfied without a real send; subtract it so
          // `sentSteps` reflects only truly-dispatched emails in the admin view
          // (#3949), while the union of the two still complements `pendingSteps`.
          Effect.map(([recordedSteps, unsub, suppressedSteps]) => {
            const suppressed = new Set<OnboardingEmailStep>(suppressedSteps);
            return {
              userId: user.user_id,
              email: user.email,
              orgId,
              sentSteps: recordedSteps.filter((s) => !suppressed.has(s)),
              suppressedSteps,
              pendingSteps: ALL_STEPS.filter((s) => !recordedSteps.includes(s)),
              unsubscribed: unsub,
              createdAt: user.created_at,
            };
          }),
          Effect.timeoutFail({
            duration: Duration.seconds(10),
            onTimeout: () => new Error("Onboarding status fetch timed out after 10s"),
          }),
          Effect.catchAll((err) => {
            log.warn({ userId: user.user_id, err: err.message }, "Failed to fetch onboarding status for user — returning defaults");
            return Effect.succeed({
              userId: user.user_id,
              email: user.email,
              orgId,
              sentSteps: [] as OnboardingEmailStep[],
              suppressedSteps: [] as OnboardingEmailStep[],
              pendingSteps: ALL_STEPS,
              unsubscribed: false,
              createdAt: user.created_at,
            });
          }),
        ),
      { concurrency: 5 },
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(60),
        onTimeout: () => new Error("Onboarding status batch timed out after 60s"),
      }),
    ),
  );

  return { statuses, total };
}
