/**
 * Source principal → Atlas user (#4801, ADR-0036 §Access control & residency).
 *
 * This module is where a chat vendor's notion of a person becomes a Better Auth
 * user id, and it is the whole reason #4801 needed a design decision before it
 * needed code: nothing in Atlas linked a Slack identity to an account. The one
 * pre-existing `externalUserId` (`lib/chat-plugin/*`) feeds `botActorUser`,
 * which mints a SYNTHETIC actor (`slack-bot:<team>:<user>`) — deliberately not
 * a real user, and useless as a join key.
 *
 * ## The resolver: email-keyed, SSO-narrowed
 *
 * Two halves that do different jobs:
 *
 *   1. **The email join is the KEY.** It is the only join Slack's Web API can
 *      support: `users.list` returns an id, a display name, and a profile
 *      email, and nothing else identifies a person across both systems. In
 *      particular there is NO IdP subject — Slack exposes that only through
 *      SCIM `externalId` (Enterprise Grid, separate token), which is why
 *      "match on the OIDC subject" is a follow-up rather than this module.
 *
 *   2. **A DNS-verified SSO domain is the NARROWING.** Where the workspace has
 *      one, only emails inside it resolve. This is not a gate on the feature —
 *      a workspace with no verified domain resolves normally — it is a bound on
 *      what an email match is allowed to mean. Without it, a Slack guest on a
 *      personal address resolves to whichever Atlas user happens to share that
 *      address; with it, they resolve to nobody and are logged.
 *
 * ## Direction of authority: this join only ever runs INWARD
 *
 * Atlas matches source emails against users it ALREADY has. It never creates a
 * user, never grants anything on the strength of a directory row, and never
 * renders channel membership as a list of people. A source principal with no
 * Atlas account gets NO ROW here and is reported — the acceptance criterion
 * "logged, never guessed", which this module satisfies by having no branch that
 * could guess: {@link resolvePrincipals} returns matches, and non-matches exist
 * only as counts and bounded per-reason samples in one line per pass. (Per
 * pass, not per principal — a 5,000-person directory would otherwise be a log
 * flood, and the counts are what an operator acts on.)
 *
 * So the information gained here is exactly *"which of my existing users are in
 * which channel"*, which is the feature. Under the B2B framing Atlas already
 * applies to identity (#2757 — a work email belongs to the org, not the
 * person), that is an org-scoped directory join rather than personal-data
 * correlation. Stated here because it is a decision, not a default.
 *
 * ## ⚠️ THE POSTURE MOVED (2026-08-25, #5440) — read this before citing the
 * ## paragraph above
 *
 * This header used to say Atlas *"never writes an email, never persists the
 * vendor roster"*. **That is no longer true without qualification**, and the
 * sentence has been edited rather than left standing, because a promise a
 * reader can still quote is worse than no promise.
 *
 * Atlas now persists a **directory snapshot** — display name, email, vendor id,
 * and the date it was taken — for source principals who **authored an ingested
 * episode**. Not for the roster. The bound is authorship, and it is the whole
 * of the reversal: what is stored beyond the old sentence is the name of
 * someone whose WORDS ARE ALREADY IN THE RECORD.
 *
 * Why, in one line: finish condition 2 requires a human NAME on every
 * authoritative claim, `provenance.actor` holds an opaque handle
 * (`slack:U0AQW6KF2EM`), and resolving it to an Atlas user id attributes only
 * the minority — measured in us prod, 4 Atlas users against 2 distinct source
 * actors already producing claims, with the SSO narrowing above REFUSING to
 * resolve a guest rather than guess. The full argument, including the three
 * states and what this does not license, is the `Amendment (2026-08-25, #5440)`
 * in ADR-0036 §T5. Do not re-derive it from this file.
 *
 * **What did NOT move, so this module's other guarantees still hold as
 * written:** the join above still runs INWARD only; a snapshot confers no
 * membership, no grant and no entitlement; revocation is still a DELETE
 * licensed by complete-or-abort vendor reads; freshness is still clock-driven.
 * A snapshot is a display name attached to a handle, and nothing may query
 * these rows to FIND a person — they are readable only as the rendering of a
 * specific claim's `actor`, under that claim's own attribution gate
 * (ADR-0036's `Amendment (2026-07-27, #4836)`).
 *
 * ## Why the workspace scope is on the SQL, not on the caller
 *
 * The match joins through `member` to the org being synced. Email is globally
 * unique in Better Auth's `"user"` table but membership is not: the same person
 * can hold accounts in several orgs, and two tenants can employ people whose
 * addresses collide at the string level. A resolver that returned a bare user
 * id from `"user"` alone would hand the caller an id it would then write into
 * ANOTHER tenant's `fact_audience_member`, and `acl.ts`'s membership expansion
 * is workspace-scoped precisely because such a row grants inside the reader's
 * own tenant. Keeping the join in one SQL statement makes the unscoped variant
 * unwritable rather than merely discouraged.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("brain.audience.resolver");

/** Ids logged per unresolved-reason bucket. A bound, not a policy. */
const SAMPLE_CAP_PER_REASON = 10;

/**
 * Email → user id, scoped to the workspace's `member` rows.
 *
 * `LOWER(email)` on both sides follows the existing precedent in
 * `lib/auth/admin-user-ops.ts` — Better Auth stores the address as typed, and a
 * case-sensitive compare would silently fail to resolve a member who signed up
 * with a capitalised address. `= ANY($2)` rather than a per-email round trip:
 * a 500-person directory is one query, and the caller has the whole set in hand
 * anyway.
 *
 * Exported so the real-Postgres test runs this exact string against the live
 * schema rather than a paraphrase of it.
 */
export const RESOLVE_PRINCIPAL_EMAILS_SQL = `SELECT LOWER(u.email) AS email, u.id AS user_id
         FROM "user" u
         JOIN member m ON m."userId" = u.id
        WHERE m."organizationId" = $1
          AND LOWER(u.email) = ANY($2::text[])`;

/**
 * The workspace's DNS-verified SSO domains.
 *
 * Read straight from `sso_providers` rather than through an enterprise Tag, and
 * that is deliberate: this is not a feature gate, it is a narrowing that must
 * apply wherever the data exists. A self-hosted deploy with no `/ee` has no
 * rows, which yields no narrowing — the same answer a Noop layer would give,
 * reached without a seam that could be mocked open. `sso_providers` itself is
 * core schema (`0000_baseline.sql`), so no `@atlas/ee` import is involved.
 *
 * Only `enabled` AND `domain_verified` domains count. An unverified domain is a
 * claim the workspace has not proven, and narrowing to an unproven domain would
 * be worse than not narrowing at all — it would let anyone who could add a
 * domain row decide which emails resolve.
 *
 * `chk_enabled_requires_verified` already makes enabled-and-unverified
 * unrepresentable, so `domain_verified = true` is belt-and-braces today. It
 * stays because this predicate's correctness should not depend on a constraint
 * in another subsystem's table staying exactly as strict as it is now.
 */
export const VERIFIED_SSO_DOMAINS_SQL = `SELECT LOWER(domain) AS domain
         FROM sso_providers
        WHERE org_id = $1
          AND enabled = true
          AND domain_verified = true`;

/** What a resolution pass concluded, per source principal. */
export interface PrincipalResolution {
  /** Source principal id (e.g. Slack user id) → Atlas user id, for matches only. */
  readonly resolved: ReadonlyMap<string, string>;
  /** Principals that matched no Atlas user — counted and logged, never guessed. */
  readonly unresolvedCount: number;
}

/** One source principal as the vendor reported it. */
export interface SourcePrincipal {
  /** The vendor's user id — the log's subject, never a join key. */
  readonly id: string;
  /** The vendor-supplied address, or null when the vendor supplied none. */
  readonly email: string | null;
}

/** The narrow DB surface this module needs — injectable for tests. */
export interface ResolverDeps {
  readonly query?: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
}

/**
 * Load the workspace's verified SSO domains.
 *
 * THROWS on a DB failure rather than returning an empty set. The empty set
 * means "no narrowing", so swallowing the error would WIDEN resolution during
 * an incident — the fail-open direction, and the exact shape of mistake
 * CLAUDE.md's "prefer errors over silent fallbacks" rule names. The caller
 * turns the throw into an aborted audience, which changes no membership at all.
 */
export async function loadVerifiedSsoDomains(
  workspaceId: string,
  deps: ResolverDeps = {},
): Promise<ReadonlySet<string>> {
  const query = deps.query ?? internalQuery;
  const rows = await query<{ domain: string | null }>(VERIFIED_SSO_DOMAINS_SQL, [workspaceId]);
  const domains = new Set<string>();
  for (const row of rows) {
    const domain = row.domain?.trim().toLowerCase();
    if (domain !== undefined && domain !== "") domains.add(domain);
  }
  return domains;
}

/** The domain part of an address, lowercased — null when it has no usable one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * Resolve source principals to Atlas user ids for one workspace.
 *
 * Throws on a DB failure — see {@link loadVerifiedSsoDomains} for why a
 * resolution fault must never degrade to "nobody matched": the caller writes
 * membership from this result, and an empty result reconciles to a full
 * revocation of the audience.
 *
 * The unresolved SAMPLE in the log carries source principal ids, never emails.
 * An operator answering "why can't this person see it?" needs the id they can
 * paste into Slack, and a log line is not a place to put a directory dump of
 * addresses that mostly belong to people with no Atlas account at all.
 */
export async function resolvePrincipals(
  workspaceId: string,
  principals: readonly SourcePrincipal[],
  deps: ResolverDeps = {},
): Promise<PrincipalResolution> {
  const query = deps.query ?? internalQuery;
  const verifiedDomains = await loadVerifiedSsoDomains(workspaceId, deps);

  // email (lowercased) → the source principal ids carrying it. A list, not a
  // single id: two Slack accounts sharing one address is rare but legal, and
  // both should resolve to the same Atlas user rather than one silently winning.
  const byEmail = new Map<string, string[]>();
  const noEmail: string[] = [];
  const outsideVerifiedDomain: string[] = [];

  for (const principal of principals) {
    const email = principal.email?.trim().toLowerCase();
    if (email === undefined || email === "") {
      noEmail.push(principal.id);
      continue;
    }
    if (verifiedDomains.size > 0) {
      const domain = emailDomain(email);
      if (domain === null || !verifiedDomains.has(domain)) {
        outsideVerifiedDomain.push(principal.id);
        continue;
      }
    }
    const existing = byEmail.get(email);
    if (existing === undefined) byEmail.set(email, [principal.id]);
    else existing.push(principal.id);
  }

  const resolved = new Map<string, string>();
  if (byEmail.size > 0) {
    const rows = await query<{ email: string | null; user_id: string | null }>(
      RESOLVE_PRINCIPAL_EMAILS_SQL,
      [workspaceId, [...byEmail.keys()]],
    );
    for (const row of rows) {
      const email = row.email?.trim().toLowerCase();
      const userId = row.user_id?.trim();
      if (email === undefined || email === "" || userId === undefined || userId === "") continue;
      for (const principalId of byEmail.get(email) ?? []) resolved.set(principalId, userId);
    }
  }

  const unresolvedCount = principals.length - resolved.size;
  if (unresolvedCount > 0) {
    const unmatched = [...byEmail.values()].flat().filter((id) => !resolved.has(id));
    log.info(
      {
        workspaceId,
        principals: principals.length,
        resolved: resolved.size,
        unresolved: unresolvedCount,
        // The three reasons are separated because they need three different
        // operator actions: invite them to Atlas / grant the email scope /
        // check the SSO domain. A single "unresolved" count sends every
        // investigation to the wrong place.
        noEmail: noEmail.length,
        outsideVerifiedDomain: outsideVerifiedDomain.length,
        noAtlasAccount: unmatched.length,
        verifiedDomains: verifiedDomains.size,
        // A sample PER REASON, not one merged list. A concatenated sample is
        // order-biased: thirty no-email guests would fill the cap and starve
        // the `noAtlasAccount` bucket entirely — silently defeating the
        // three-separable-investigations property the counts above exist for.
        sampleNoEmail: noEmail.slice(0, SAMPLE_CAP_PER_REASON),
        sampleOutsideVerifiedDomain: outsideVerifiedDomain.slice(0, SAMPLE_CAP_PER_REASON),
        sampleNoAtlasAccount: unmatched.slice(0, SAMPLE_CAP_PER_REASON),
      },
      "brain audience: source principals did not resolve to an Atlas user — they are excluded from the audience",
    );
  }

  return { resolved, unresolvedCount };
}
