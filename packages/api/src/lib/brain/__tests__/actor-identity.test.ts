/**
 * The human NAME behind a claim's vendor handle (#5440, ADR-0036 §T5's
 * `Amendment (2026-08-25, #5440)`).
 *
 * The properties worth a test are the ones a plausible wrong implementation
 * gets wrong, and there are four:
 *
 *   1. **`atlas` resolves LIVE.** The row stores a pointer, never a name, so a
 *      renamed account changes the surface with no re-ingest. A snapshot in that
 *      state would pass a naive "does it render a name" test and fail the
 *      acceptance criterion.
 *   2. **`directory` carries its DATE.** A snapshot without one is a stale name
 *      asserted as current.
 *   3. **`opaque` is a NAMED state, reached by every degradation.** Never a
 *      blank, never a fallback to the handle — the two renderings finish
 *      condition 2 explicitly refuses.
 *   4. **Erasure HOLDS against the capture writer.** An erasure a background
 *      cycle can undo is not an erasure, and that property lives in one `WHERE`
 *      clause — which is exactly the kind of thing a refactor drops.
 *
 * #5454 adds two more, at the bottom of this file: a handle that CARRIES its own
 * answer must not be sent to the table and told `opaque`, and the stored
 * vocabulary must not quietly grow the rendered one's fourth arm.
 */

import { describe, expect, it } from "bun:test";
import {
  MACHINE_IDENTITY,
  BRAIN_ACTOR_IDENTITY_STATES,
  CAPTURE_ACTOR_IDENTITY_SQL,
  ERASE_ACTOR_IDENTITY_SQL,
  LOAD_ACTOR_IDENTITIES_SQL,
  LOAD_DERIVED_ATLAS_USERS_SQL,
  NO_ACTOR_IDENTITIES,
  OPAQUE_IDENTITY,
  actorsIn,
  derivableActor,
  identityFor,
  loadActorIdentities,
  provenanceActor,
  type ActorIdentityReader,
} from "@atlas/api/lib/brain/actor-identity";
import { EPISODE_SOURCES, WAREHOUSE_SOURCE } from "@atlas/api/lib/brain/sources";
import { WAREHOUSE_PRODUCER_PRINCIPAL } from "@atlas/api/lib/brain/warehouse-producer";

const WS = "ws-actor-identity";

/** A reader that answers one canned page and records what it was asked. */
function readerFor(rows: readonly Record<string, unknown>[]): ActorIdentityReader & {
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params: params ?? [] });
      return { rows };
    },
  };
}

/**
 * A reader that answers PER STATEMENT (#5454).
 *
 * The read is two statements now, and keying the double on the SQL rather than
 * on call order is what stops these tests asserting their own script: a change
 * that stopped issuing one of them, or issued them in the other order, still
 * gets the right rows here and fails on the ANSWER instead.
 */
function readerBySql(
  rowsBySql: Record<string, readonly Record<string, unknown>[]>,
): ActorIdentityReader {
  return {
    query: async (sql) => ({ rows: rowsBySql[sql] ?? [] }),
  };
}

describe("provenanceActor / actorsIn", () => {
  it("reads the same key and applies the same emptiness test as the projection", () => {
    // The handles a page LOOKS UP and the handles it RENDERS must agree, or one
    // claim renders `opaque` while an identical one beside it resolves.
    expect(provenanceActor({ actor: "slack:U1" })).toBe("slack:U1");
    expect(provenanceActor({ actor: "" })).toBeNull();
    expect(provenanceActor({ actor: null })).toBeNull();
    expect(provenanceActor({})).toBeNull();
    expect(provenanceActor("not an object")).toBeNull();
    expect(provenanceActor(null)).toBeNull();
    expect(provenanceActor([{ actor: "slack:U1" }])).toBeNull();
  });

  it("deduplicates across a page", () => {
    expect(
      actorsIn([{ actor: "slack:U1" }, { actor: "slack:U1" }, { actor: "slack:U2" }, {}]).toSorted(),
    ).toEqual(["slack:U1", "slack:U2"]);
  });
});

describe("identityFor — absence is a NAMED state, not undefined", () => {
  it("gives an unknown actor the explicit opaque state", () => {
    // The whole point: a blank would read as "nobody asserted this claim", and
    // falling back to the handle is what #5440 ruled insufficient.
    expect(identityFor(NO_ACTOR_IDENTITIES, "slack:U1")).toEqual(OPAQUE_IDENTITY);
    expect(OPAQUE_IDENTITY).toEqual({ state: "opaque", erased: false });
  });

  it("returns null — NOT opaque — when there is no actor at all", () => {
    // Two different facts. `null` is "no author, so no identity question";
    // `opaque` asserts that somebody spoke and Atlas cannot name them.
    expect(identityFor(NO_ACTOR_IDENTITIES, null)).toBeNull();
    expect(identityFor(NO_ACTOR_IDENTITIES, "")).toBeNull();
  });
});

describe("loadActorIdentities — the three states", () => {
  it("resolves `atlas` from the LIVE join, never from a stored name", async () => {
    const db = readerFor([
      {
        actor: "slack:U1",
        state: "atlas",
        user_id: "user-1",
        display_name: null,
        real_name: null,
        email: null,
        snapshot_at: null,
        erased_at: null,
        user_name: "Ada Lovelace",
        user_email: "ada@corp.test",
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U1"]);
    expect(out.get("slack:U1")).toEqual({
      state: "atlas",
      userId: "user-1",
      name: "Ada Lovelace",
      email: "ada@corp.test",
    });
    // The property behind the acceptance criterion, asserted on the SQL rather
    // than only on the projection: the name comes off `"user"`, so renaming the
    // account changes the surface with no re-ingest and no backfill.
    expect(LOAD_ACTOR_IDENTITIES_SQL).toContain('LEFT JOIN "user" u ON u.id = ai.user_id');
    expect(LOAD_ACTOR_IDENTITIES_SQL).toContain("u.name AS user_name");
  });

  it("degrades an `atlas` row whose account is gone to opaque", async () => {
    // A dangling pointer — the account was deleted after the pointer was
    // written. Deleting an account is not a licence to assert a name Atlas can
    // no longer stand behind, and rendering the stored user id as if it were a
    // person is the failure this arm prevents.
    const db = readerFor([
      {
        actor: "slack:U1",
        state: "atlas",
        user_id: "user-gone",
        display_name: null,
        real_name: null,
        email: null,
        snapshot_at: null,
        erased_at: null,
        user_name: null,
        user_email: null,
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U1"]);
    expect(out.get("slack:U1")).toEqual({ state: "opaque", erased: false });
  });

  it("carries a `directory` snapshot WITH its date", async () => {
    const db = readerFor([
      {
        actor: "slack:U2",
        state: "directory",
        user_id: null,
        display_name: "dana",
        real_name: "Dana Okafor",
        email: "dana@contractor.test",
        snapshot_at: new Date("2026-04-05T00:00:00.000Z"),
        erased_at: null,
        user_name: null,
        user_email: null,
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U2"]);
    expect(out.get("slack:U2")).toEqual({
      state: "directory",
      displayName: "dana",
      realName: "Dana Okafor",
      email: "dana@contractor.test",
      snapshotAt: "2026-04-05T00:00:00.000Z",
    });
  });

  it("refuses an UNDATED directory snapshot rather than rendering it", async () => {
    // Unreachable from the database (`ck_brain_actor_identity_directory_shape`),
    // so reaching it means the row arrived some other way. Rendering it would
    // assert a stale name as current, which is the one thing the date exists to
    // prevent — so it degrades to the honest answer instead.
    const db = readerFor([
      {
        actor: "slack:U2",
        state: "directory",
        user_id: null,
        display_name: "dana",
        real_name: null,
        email: null,
        snapshot_at: null,
        erased_at: null,
        user_name: null,
        user_email: null,
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U2"]);
    expect(out.get("slack:U2")).toEqual({ state: "opaque", erased: false });
  });

  it("reports an ERASED opaque row distinctly from a never-named one", async () => {
    const db = readerFor([
      {
        actor: "slack:U3",
        state: "opaque",
        user_id: null,
        display_name: null,
        real_name: null,
        email: null,
        snapshot_at: null,
        erased_at: new Date("2026-05-06T00:00:00.000Z"),
        user_name: null,
        user_email: null,
      },
      {
        actor: "slack:U4",
        state: "opaque",
        user_id: null,
        display_name: null,
        real_name: null,
        email: null,
        snapshot_at: null,
        erased_at: null,
        user_name: null,
        user_email: null,
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U3", "slack:U4"]);
    // Both name nobody; only one says a person removed the name.
    expect(out.get("slack:U3")).toEqual({ state: "opaque", erased: true });
    expect(out.get("slack:U4")).toEqual({ state: "opaque", erased: false });
  });

  it("degrades an out-of-vocabulary state to opaque", async () => {
    const db = readerFor([
      {
        actor: "slack:U9",
        state: "resolved",
        user_id: null,
        display_name: "Someone",
        real_name: null,
        email: null,
        snapshot_at: new Date(),
        erased_at: null,
        user_name: null,
        user_email: null,
      },
    ]);
    const out = await loadActorIdentities(db, WS, ["slack:U9"]);
    expect(out.get("slack:U9")).toEqual({ state: "opaque", erased: false });
  });

  it("asks for nothing when the page names no actors", async () => {
    const db = readerFor([]);
    expect((await loadActorIdentities(db, WS, [])).size).toBe(0);
    expect((await loadActorIdentities(db, WS, ["", ""])).size).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("degrades a FAILED read to opaque instead of failing the page", async () => {
    // ⚠️ The direction of failure is the argument. A name that cannot be loaded
    // renders as "we cannot name this person" — honest, and copy the surface
    // already has. A rejection would fail the whole review page and every
    // `searchBrain` answer over a SIDE table that grants nothing and gates
    // nothing.
    //
    // The reachable cause is real: the `atlas` arm joins Better Auth's
    // `"user"`, so a deployment running `ATLAS_AUTH_MODE=none` may not have
    // that relation at all.
    const db: ActorIdentityReader = {
      query: () => Promise.reject(new Error('relation "user" does not exist')),
    };
    const out = await loadActorIdentities(db, WS, ["slack:U1"]);
    expect(out.size).toBe(0);
    // …and the caller's default turns that absence into the NAMED state.
    expect(identityFor(out, "slack:U1")).toEqual(OPAQUE_IDENTITY);
  });

  it("issues ONE query for a page and deduplicates its handles", async () => {
    // The property that lets this sit on the `searchBrain` hot path beside
    // `loadEpisodes`. A per-row query would pass every assertion above.
    const db = readerFor([]);
    await loadActorIdentities(db, WS, ["slack:U1", "slack:U1", "slack:U2"]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.params).toEqual([WS, ["slack:U1", "slack:U2"]]);
  });
});

describe("the write path's two load-bearing clauses", () => {
  it("leaves an operator's erasure alone on re-capture", () => {
    // ⚠️ THE erasure guarantee, and it is one predicate. Without it every
    // erasure would last until the next 30-minute audience cycle re-captured
    // the name — and it would fail silently: the operator sees the erasure
    // take, and the name comes back.
    expect(CAPTURE_ACTOR_IDENTITY_SQL).toContain(
      "WHERE brain_actor_identity.erased_at IS NULL",
    );
  });

  it("advances `snapshot_at` only when the snapshot actually changed", () => {
    // A date that moves every 30 minutes reports itself as fresh forever, which
    // is exactly the "stale name asserted as current" the date exists against.
    // `IS DISTINCT FROM` and not `<>`, because every snapshot column is
    // nullable and `NULL <> NULL` is NULL — a name arriving where there was
    // none would compare as unchanged and keep the older date.
    expect(CAPTURE_ACTOR_IDENTITY_SQL).toContain("IS DISTINCT FROM EXCLUDED.display_name");
    expect(CAPTURE_ACTOR_IDENTITY_SQL).toContain("ELSE brain_actor_identity.snapshot_at");
  });

  it("never lets a capture pass DESTROY a snapshot", () => {
    // ⚠️ The guard that keeps the feature from quietly undoing itself. An
    // author in `users.list` today gets a dated snapshot; if they later drop
    // OUT of the directory — a Slack Connect guest whose connection ends — the
    // capture decides `opaque`, and an unguarded upsert would overwrite the
    // snapshot with a nameless row on the next 30-minute cycle. That is exactly
    // the person the snapshot exists for, and the loss is irreversible. The
    // vendor going quiet about someone is not evidence Atlas should forget
    // them; the ONE path that removes a snapshot is an operator's erasure.
    expect(CAPTURE_ACTOR_IDENTITY_SQL).toContain(
      "NOT (brain_actor_identity.state = 'directory' AND EXCLUDED.state = 'opaque')",
    );
  });

  it("erases only a `directory` snapshot", () => {
    // An `atlas` row stores no snapshot — its name is a live join to an account
    // whose own erasure path is account deletion — so "erasing" one would remove
    // nothing and leave a current colleague unnameable on every claim they made.
    expect(ERASE_ACTOR_IDENTITY_SQL).toContain("AND state = 'directory'");
    // The claim is untouched: this statement names one table and it is not
    // `brain_facts`.
    expect(ERASE_ACTOR_IDENTITY_SQL).not.toContain("brain_facts");
  });
});

describe("the stored vocabulary", () => {
  it("is exactly the three states the ADR settles on", () => {
    // Mirrors `ck_brain_actor_identity_state`. A fourth member here without a
    // matching CHECK is a value the database refuses; a fourth in the CHECK
    // without one here is a row every reader degrades to `opaque`.
    //
    // ⚠️ `machine` is deliberately NOT here (#5454). It is a RENDERED state
    // derived from the handle, and adding it to this list would be a claim that
    // the CHECK admits it — which it does not, and must not: a stored `machine`
    // row would be a persisted assertion about a handle that already carries
    // the answer.
    expect([...BRAIN_ACTOR_IDENTITY_STATES]).toEqual(["atlas", "directory", "opaque"]);
  });
});

// ---------------------------------------------------------------------------
// #5454 — the two handles that carry their own answer
// ---------------------------------------------------------------------------

/**
 * `derivableActor` — the handles the stored table must not be asked about.
 *
 * ## Mutations verified red (2026-08-26)
 *
 *   1. `derivableActor`: `actor.startsWith(USER_PREFIX)` → `actor.startsWith("human:")`
 *      — the handle a CAPTURE-based fix would have keyed. Red on "reads a
 *      `user:<id>` handle as the Atlas account it names".
 *   2. `derivableActor`: `=== WAREHOUSE_CLASS` → `!== WAREHOUSE_CLASS`. Red on
 *      "calls a warehouse-class handle a machine" and on "leaves every other
 *      handle to the stored table".
 *   3. `derivableActor`: `userId === "" ? null : …` → always the `atlas-user`
 *      arm. Red on "refuses a bare `user:` prefix".
 *   4. `loadActorIdentities`: drop the `if (out.has(actor)) continue;` guard.
 *      Red on "lets a STORED row win over the `user:` derivation".
 *   5. `loadActorIdentities`: let a `machine` handle fall through into `wanted`
 *      instead of `continue`. Red on "answers a machine WITHOUT asking the
 *      database anything".
 *   6. `sources.ts`: add a `user` member to `EPISODE_SOURCE_SPECS`. Red on "has
 *      no episode source spelled `user`" — the collision that would make arm 1
 *      name the wrong person rather than fail.
 */
describe("derivableActor — #5454", () => {
  it("reads a `user:<id>` handle as the Atlas account it names", () => {
    // The correction lane. `correctFact` writes `user:${ctx.userId}`, and the
    // payload after the colon IS a `"user".id` — the most directly resolvable
    // identifier in the record, which the surface used to call unnameable.
    expect(derivableActor("user:3AaGbeai")).toEqual({ kind: "atlas-user", userId: "3AaGbeai" });
    // An id may hold anything non-empty: Better Auth ids have no shape this
    // module is entitled to assume, which is `parsePrincipal`'s own posture.
    expect(derivableActor("user:a:b")).toEqual({ kind: "atlas-user", userId: "a:b" });
  });

  it("refuses a bare `user:` prefix", () => {
    // Nothing to join on, so `opaque` is the honest answer — and a null here is
    // what produces it.
    expect(derivableActor("user:")).toBeNull();
  });

  it("calls a warehouse-class handle a machine, by CLASS and not by producer name", () => {
    // The literal in prod today…
    // ⚠️ The BARE principal, which is what `warehouse-producer.ts` actually
    // stamps -- `reconcile.ts` short-circuits on an explicit principal before
    // composing a `${source}:` prefix. Asserting the composed form here is what
    // let a dead arm ship green: `system` is not an episode source, so the
    // class test answered `null` and every real machine claim rendered opaque.
    expect(derivableActor(WAREHOUSE_PRODUCER_PRINCIPAL)).toEqual({ kind: "machine" });
    // Every other system principal in the tree is a machine too.
    expect(derivableActor("system:brain-extraction")).toEqual({ kind: "machine" });
    expect(derivableActor("system:scheduler")).toEqual({ kind: "machine" });
    // `system:` alone names nothing and must not claim to.
    expect(derivableActor("system:")).toBeNull();
    // The composed form still resolves, for a handle that really was built
    // from an episode source.
    expect(derivableActor(`${WAREHOUSE_SOURCE}:${WAREHOUSE_PRODUCER_PRINCIPAL}`)).toEqual({
      kind: "machine",
    });
    // …and a producer that does not exist yet. Matching the constant above
    // would leave the NEXT warehouse producer rendering as an unnameable
    // person, which is the shape of the defect rather than an instance of it.
    expect(derivableActor(`${WAREHOUSE_SOURCE}:system:some-future-producer`)).toEqual({
      kind: "machine",
    });
  });

  it("leaves every other handle to the stored table", () => {
    for (const handle of [
      "slack:U0AQW6KF2EM",
      "zoom:abc",
      "outlook:someone@corp.test",
      // `human:` is the EPISODE's composed handle on the correction lane. No
      // fact carries it — `correctFact` passes `user:<id>` as the explicit
      // principal — so answering it would answer a question nothing asks.
      "human:3AaGbeai",
      // The unauthenticated-local arm: a human with no id to resolve. That
      // deployment declared it has no ids to record, so "cannot name this
      // person" is TRUE here and this is the one lane left alone deliberately.
      "human:local-operator",
      // Outside this deployment's vocabulary — a region import restores
      // `source` verbatim, and declining to claim a class it cannot see is the
      // posture the correction gate already takes.
      "notasource:system:whatever",
      "nocolon",
      ":leading",
      "",
    ]) {
      expect(derivableActor(handle)).toBeNull();
    }
  });

  it("has no episode source spelled `user`, which is what makes the prefix unambiguous", () => {
    // ⚠️ The day one is added, `derivableActor` starts naming the WRONG person
    // for every claim from that source rather than failing — a composed
    // `user:<vendorId>` handle would take the correction lane's arm.
    expect(EPISODE_SOURCES).not.toContain("user" as (typeof EPISODE_SOURCES)[number]);
  });
});

describe("loadActorIdentities — the derived answers (#5454)", () => {
  it('names the correcting human from "user" with NO stored row', async () => {
    // The acceptance criterion at the unit seam: `brain_actor_identity` answers
    // nothing, and the claim still names a person.
    const db = readerBySql({
      [LOAD_ACTOR_IDENTITIES_SQL]: [],
      [LOAD_DERIVED_ATLAS_USERS_SQL]: [
        { id: "user-corrector", name: "Matt Sywualk", email: "matt@useatlas.dev" },
      ],
    });
    const out = await loadActorIdentities(db, WS, ["user:user-corrector"]);
    expect(out.get("user:user-corrector")).toEqual({
      state: "atlas",
      userId: "user-corrector",
      name: "Matt Sywualk",
      email: "matt@useatlas.dev",
    });
    // The SAME state a captured pointer produces, from the SAME relation — one
    // answer reached with one indirection fewer, not a fourth arm.
    expect(LOAD_DERIVED_ATLAS_USERS_SQL).toContain('FROM "user" u');
  });

  it("degrades a `user:` handle whose account is gone to opaque", async () => {
    // Deleting an account is not a licence to assert a name Atlas can no longer
    // stand behind, and rendering the id as if it were a person is exactly what
    // `opaque` exists against — the same degradation a dangling stored pointer
    // takes.
    const db = readerBySql({
      [LOAD_ACTOR_IDENTITIES_SQL]: [],
      [LOAD_DERIVED_ATLAS_USERS_SQL]: [],
    });
    const out = await loadActorIdentities(db, WS, ["user:user-gone"]);
    expect(out.get("user:user-gone")).toEqual({ state: "opaque", erased: false });
  });

  it("lets a STORED row win over the `user:` derivation", async () => {
    // Precedence, and it is the erasure guarantee generalised: a stored row is
    // a deliberate act with an erasure path attached, so wherever one exists it
    // is authoritative and the derivation only fills a gap. Nothing writes
    // `user:` rows today; this is what keeps the ordering true if anything ever
    // does.
    const db = readerBySql({
      [LOAD_ACTOR_IDENTITIES_SQL]: [
        {
          actor: "user:user-corrector",
          state: "opaque",
          user_id: null,
          display_name: null,
          real_name: null,
          email: null,
          snapshot_at: null,
          erased_at: new Date("2026-05-06T00:00:00.000Z"),
          user_name: null,
          user_email: null,
        },
      ],
      [LOAD_DERIVED_ATLAS_USERS_SQL]: [
        { id: "user-corrector", name: "Matt Sywualk", email: "matt@useatlas.dev" },
      ],
    });
    const out = await loadActorIdentities(db, WS, ["user:user-corrector"]);
    expect(out.get("user:user-corrector")).toEqual({ state: "opaque", erased: true });
  });

  it("answers a machine WITHOUT asking the database anything", async () => {
    // Machine-ness is a property of the handle, so it needs no row — which is
    // why it holds on a deployment whose capture cycle has never run, and why
    // the handle is not sent to either statement.
    const db = readerFor([]);
    const actor = `${WAREHOUSE_SOURCE}:${WAREHOUSE_PRODUCER_PRINCIPAL}`;
    const out = await loadActorIdentities(db, WS, [actor]);
    expect(out.get(actor)).toEqual(MACHINE_IDENTITY);
    expect(db.calls).toHaveLength(0);
  });

  it("still answers a machine when the identity read FAILS", async () => {
    // The one answer that survives the degrade-to-opaque catch, and it survives
    // for free rather than by special pleading: it never needed a row.
    const db: ActorIdentityReader = {
      query: () => Promise.reject(new Error('relation "user" does not exist')),
    };
    const machine = `${WAREHOUSE_SOURCE}:${WAREHOUSE_PRODUCER_PRINCIPAL}`;
    const out = await loadActorIdentities(db, WS, [machine, "slack:U1"]);
    expect(out.get(machine)).toEqual(MACHINE_IDENTITY);
    expect(identityFor(out, "slack:U1")).toEqual(OPAQUE_IDENTITY);
  });

  it("keeps a connector-only page at ONE query, and issues the second only for `user:` handles", async () => {
    // The hot-path property. A page of ordinary claims costs exactly what it
    // cost before #5454; the second statement is the price of a page that
    // actually carries a correction.
    const connectorOnly = readerFor([]);
    await loadActorIdentities(connectorOnly, WS, ["slack:U1", "slack:U2"]);
    expect(connectorOnly.calls).toHaveLength(1);

    const withCorrection = readerFor([]);
    await loadActorIdentities(withCorrection, WS, ["slack:U1", "user:user-a", "user:user-a"]);
    expect(withCorrection.calls).toHaveLength(2);
    // Deduplicated on both sides, and the `user:` read is keyed by the BARE id
    // — it is a `"user"` read, not a handle read.
    //
    // ⚠️ BOTH reads carry the workspace. The derived read did not until #5454's
    // review: Better-Auth's `"user"` is global, and `admin-migrate.ts` binds an
    // imported bundle's `provenance.actor` verbatim, so an unscoped read would
    // hand a foreign person's name and email to any reader entitled to `actor`
    // here. The workspace argument IS the fix; asserting it is what keeps it.
    expect(withCorrection.calls.map((c) => c.params)).toEqual(
      expect.arrayContaining([
        [WS, ["slack:U1", "user:user-a"]],
        [WS, ["user-a"]],
      ]),
    );
  });

  it("keeps the two reads independent when only ONE of them fails", async () => {
    // A `Promise.all` over rejecting promises would lose whichever answer DID
    // come back, which is why each read degrades to `[]` on its own rather than
    // throwing into the other's join.
    const db: ActorIdentityReader = {
      query: (sql) =>
        sql === LOAD_DERIVED_ATLAS_USERS_SQL
          ? Promise.reject(new Error('relation "user" does not exist'))
          : Promise.resolve({
              rows: [
                {
                  actor: "slack:U1",
                  state: "directory",
                  user_id: null,
                  display_name: "dana",
                  real_name: null,
                  email: null,
                  snapshot_at: new Date("2026-04-05T00:00:00.000Z"),
                  erased_at: null,
                  user_name: null,
                  user_email: null,
                },
              ],
            }),
    };
    const out = await loadActorIdentities(db, WS, ["slack:U1", "user:user-a"]);
    expect(out.get("slack:U1")).toMatchObject({ state: "directory", displayName: "dana" });
    expect(identityFor(out, "user:user-a")).toEqual(OPAQUE_IDENTITY);
  });
});
