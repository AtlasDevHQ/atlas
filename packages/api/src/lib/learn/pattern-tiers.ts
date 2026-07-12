/**
 * Learned-pattern tier boundaries.
 *
 * A leaf module (no imports) so the constants below can be shared by both the
 * DB layer (`db/internal.ts` `getPromoteDecayCandidates`) and the route layer
 * (`api/routes/admin-learned-patterns.ts`) without either importer's tests
 * needing to mock a new symbol. Keeping the boundary here — rather than as an
 * export on the heavily-partial-mocked `db/internal.ts` — is what lets every
 * admin-route test that mocks `internal.ts` keep loading the route unchanged.
 */

/**
 * Repetition floor at which a query pattern stops being "seen-once" and becomes
 * reviewable + promotable (#4581). A pattern's `repetition_count` starts at 1 on
 * first capture and increments on every repeat observation via the DB-enforced
 * identity (#4572), so `>= 2` means "observed more than once". A seen-once row
 * (`repetition_count = 1`) persists — the identity row must exist for the second
 * observation to increment it — but sits below the default review queue, the
 * pending badge, and every promotion gate until it repeats (CONTEXT.md § Learned
 * query patterns: "a review queue full of seen-once noise" is an anti-goal).
 *
 * This is the single definition of that boundary, shared by the admin list route
 * + pending-count badge (`api/routes/admin-learned-patterns.ts`) and the
 * promote/decay candidate scan (`getPromoteDecayCandidates`), so the three
 * surfaces can never disagree on where seen-once ends.
 */
export const REPEATED_PATTERN_MIN_REPETITIONS = 2;
