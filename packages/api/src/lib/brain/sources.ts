/**
 * The closed vocabulary of `brain_episodes.source` — the connector CLASS a
 * producer stamps on the evidence it appends (ADR-0036 orders sources
 * class-major, vendor-minor).
 *
 * ## Why this is a shared constant rather than three string literals
 *
 * `correction.ts`'s tier-1 refusal (`isWarehouseDerived`) is a predicate over
 * this column: a warehouse-derived fact has no correction path, because the fix
 * belongs in the data or the semantic layer rather than in an override the
 * next sync would overwrite. That refusal is an ADR-level invariant, and its
 * ONLY trigger is `provenance.source === WAREHOUSE_SOURCE` — copied verbatim
 * out of the episode by `reconcile.ts`.
 *
 * So the refusal is exactly as strong as the agreement between the producer
 * that names the class and the predicate that reads it. While both sides
 * spelled their own literal, the agreement was a coincidence: a warehouse
 * connector (#4770 / #4771) naming its source `"snowflake"`, `"bigquery"`, or
 * `"warehouse:prod"` would have stopped tier-1 refusal firing without failing
 * anything, because every test on the refusal hand-seeded the same literal it
 * asserted against. Naming the class here, once, is what makes the two sides
 * the same fact.
 *
 * ## Adding a member
 *
 * Two gates, and they exist for different producers.
 * `BrainSourceConnector.source` is typed `EpisodeSource`, which stops an
 * in-repo connector inventing a class at compile time; and
 * `registerBrainSourceConnector` re-checks the value at runtime, because a
 * plugin is compiled separately and reaches the registry as data. So a new
 * class must come through this file either way — and `__tests__/sources.test.ts`
 * pins the list as a CLOSED key set, so adding one has to fail a test first.
 *
 * That friction is the point: **if the class you are adding is
 * warehouse-shaped, it must BE `WAREHOUSE_SOURCE`** (vendor identity belongs
 * in the catalog id and in `provenance.producer`, not in this column) —
 * otherwise tier-1 correction refusal silently stops applying to every fact
 * your connector produces, and nothing goes red.
 *
 * The one producer NOT gated here is the region import
 * (`admin-migrate.ts`'s `INSERT INTO brain_episodes`), which restores a
 * bundle's stored `source` verbatim. That is deliberate and matches the line
 * the retract guard draws: an import is a restore of evidence some other
 * region's registry already admitted, not a new class entering the system.
 */

/**
 * Every connector class that may reach `brain_episodes.source`.
 *
 * Ordered as ADR-0036 orders the classes, not alphabetically. `db/schema.ts`
 * names the same three beside the column and points here; migration 0180
 * deliberately does not constrain it — the column is plain `text` so a region
 * import can restore a bundle written by a newer vocabulary, which is the same
 * carve-out the header's last paragraph describes.
 */
export const EPISODE_SOURCES = ["slack", "warehouse", "human"] as const;

export type EpisodeSource = (typeof EPISODE_SOURCES)[number];

/** The chat class's first vendor — what `SLACK_HISTORY_SOURCE` resolves to. */
export const SLACK_SOURCE: EpisodeSource = "slack";

/**
 * The tier-1 class: facts derived from the warehouse itself.
 *
 * The one value `isWarehouseDerived` recognises. A connector producing
 * warehouse-derived episodes MUST stamp this — see the header.
 */
export const WAREHOUSE_SOURCE: EpisodeSource = "warehouse";

/**
 * A human's own words, recorded as evidence — today only `correct_fact`'s
 * correction episode. Never re-extracted: the episode is pre-stamped off the
 * extraction queue so a human's statement is not re-derived into a second,
 * machine-produced claim (#4915).
 */
export const HUMAN_SOURCE: EpisodeSource = "human";

/** Narrow an arbitrary value — a config string, a stored row — to the vocabulary. */
export function isEpisodeSource(value: unknown): value is EpisodeSource {
  return typeof value === "string" && (EPISODE_SOURCES as readonly string[]).includes(value);
}
