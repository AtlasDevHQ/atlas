/**
 * The closed vocabulary of `brain_episodes.source` — the SOURCE KIND a producer
 * stamps on the evidence it appends.
 *
 * ## What a member is (the mixed grain, stated plainly)
 *
 * ADR-0036 §T6 sequences connectors class-major, vendor-minor (chat →
 * transcripts → email → docs), but the stored column is NOT purely either.
 * `warehouse` and `human` are CLASSES — neither has a vendor and neither comes
 * from a connector at all. `slack` is a VENDOR within the chat class, and the
 * `<channelId>:<ts>` source-id contract in `ingest/slack/config.ts` is why: the
 * id format is vendor-specific, so collapsing every chat vendor onto one stored
 * value would make two vendors' ids share a dedupe namespace.
 *
 * So the vocabulary is a closed enumeration of source kinds at whatever grain
 * each one actually has, and a second chat vendor (Teams, Discord) is a NEW
 * MEMBER here, not a reuse of `slack`. That is a deliberate one-line PR, and
 * `__tests__/sources.test.ts` makes it fail a test first.
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
 * that names the kind and the predicate that reads it. While both sides spelled
 * their own literal, that agreement was a coincidence. ADR-0036 commits to
 * warehouse-derived facts as tier-1 but no milestone in the M1–M6 cut has
 * scoped the producer yet, so the value is one future naming decision away from
 * silence: a producer stamping `"snowflake"`, `"bigquery"` or `"warehouse:prod"`
 * would have stopped tier-1 refusal firing without failing ANYTHING, because
 * every test on the refusal hand-seeded the same literal it asserted against
 * (#4938). Naming the kind here, once, is what makes the two sides one fact.
 *
 * ## Adding a member
 *
 * Two gates, at different producers. `BrainSourceConnector.source` is typed
 * `EpisodeSource`, which stops an in-repo connector inventing a kind at compile
 * time; `registerBrainSourceConnector` re-checks at runtime, because a registry
 * is a data boundary — ADR-0036 M3 makes connectors plugin-shaped, and a plugin
 * compiled separately reaches it as data rather than as a checked type. (No
 * plugin registers a brain source today; the check is there for when one does.)
 *
 * The rule that actually matters: **if the kind you are adding is
 * warehouse-shaped, it must BE `WAREHOUSE_SOURCE`.** A warehouse connector's
 * vendor identity belongs in the catalog id and in `provenance.producer`;
 * putting it here instead silently stops tier-1 correction refusal applying to
 * every fact that connector produces, and nothing goes red.
 *
 * The one producer NOT gated is the region import (`admin-migrate.ts`'s `INSERT
 * INTO brain_episodes`), which restores a bundle's stored `source` verbatim so
 * a bundle written by a newer vocabulary still imports. That is the same
 * restore-is-not-a-new-arbitration line `RETRACT_FACT_SQL`'s sole-writer scan
 * draws for `invalidated_at` (`__tests__/correction.test.ts`). It is a real
 * fail-open lane, so the import LOGS an out-of-vocabulary value rather than
 * accepting it silently.
 */

/**
 * Every source kind that may reach `brain_episodes.source`.
 *
 * Chat first, then the two kinds that come from no connector. `db/schema.ts`
 * names the same three beside the column and points here; migration 0180 leaves
 * the column plain `text` with no CHECK, which is what lets the region import
 * above restore a value this list does not yet know.
 */
export const EPISODE_SOURCES = ["slack", "warehouse", "human"] as const;

export type EpisodeSource = (typeof EPISODE_SOURCES)[number];

/**
 * The chat class's first vendor — what `SLACK_HISTORY_SOURCE` resolves to.
 *
 * `satisfies`, not a `: EpisodeSource` annotation, on all three below: the
 * annotation would widen the constant to the whole union and cost every
 * consumer its `===` narrowing, while `satisfies` keeps the literal type AND
 * still fails compilation if the value leaves the vocabulary.
 */
export const SLACK_SOURCE = "slack" satisfies EpisodeSource;

/**
 * The tier-1 kind: facts derived from the warehouse itself.
 *
 * The one value `isWarehouseDerived` recognises. A producer of
 * warehouse-derived episodes MUST stamp this — see the header.
 */
export const WAREHOUSE_SOURCE = "warehouse" satisfies EpisodeSource;

/**
 * A human's own words, recorded as evidence — today only `correct_fact`'s
 * correction episode. Never re-extracted: the episode is pre-stamped off the
 * extraction queue so a human's statement is not re-derived into a second,
 * machine-produced claim (#4915).
 */
export const HUMAN_SOURCE = "human" satisfies EpisodeSource;

/** Narrow an arbitrary value — a config string, a stored row — to the vocabulary. */
export function isEpisodeSource(value: unknown): value is EpisodeSource {
  return typeof value === "string" && (EPISODE_SOURCES as readonly string[]).includes(value);
}
