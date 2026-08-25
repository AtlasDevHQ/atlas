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
 */

import { describe, expect, it } from "bun:test";
import {
  BRAIN_ACTOR_IDENTITY_STATES,
  CAPTURE_ACTOR_IDENTITY_SQL,
  ERASE_ACTOR_IDENTITY_SQL,
  LOAD_ACTOR_IDENTITIES_SQL,
  NO_ACTOR_IDENTITIES,
  OPAQUE_IDENTITY,
  actorsIn,
  identityFor,
  loadActorIdentities,
  parseActorHandle,
  provenanceActor,
  type ActorIdentityReader,
} from "@atlas/api/lib/brain/actor-identity";

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

describe("parseActorHandle", () => {
  it("splits on the FIRST colon, because that is what mints the handle", () => {
    // `resolvedPrincipal` builds `${episode.source}:${actor}`, so every later
    // colon belongs to the vendor id. Splitting on the last one would mangle a
    // vendor whose ids contain one.
    expect(parseActorHandle("slack:U0AQW6KF2EM")).toEqual({
      source: "slack",
      vendorUserId: "U0AQW6KF2EM",
    });
    expect(parseActorHandle("slack:T1:U2")).toEqual({ source: "slack", vendorUserId: "T1:U2" });
  });

  it("returns null for anything that is not a source-qualified handle", () => {
    // Not an error — "this handle names no vendor directory to look in". The
    // caller renders `opaque`, which is the honest answer for a human
    // correction's explicit principal.
    expect(parseActorHandle("U0AQW6KF2EM")).toBeNull();
    expect(parseActorHandle(":U1")).toBeNull();
    expect(parseActorHandle("slack:")).toBeNull();
    expect(parseActorHandle("")).toBeNull();
  });
});

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
    expect([...BRAIN_ACTOR_IDENTITY_STATES]).toEqual(["atlas", "directory", "opaque"]);
  });
});
