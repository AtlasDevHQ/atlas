-- 0208 — A human NAME on every authoritative claim (#5440, ADR-0036 §T5
-- `Amendment (2026-08-25, #5440)`).
--
-- ⚠️ **This table is the one place the resolver's inward-only posture is
-- reversed.** Read ADR-0036 §T5's amendment before changing anything here; it
-- is the decision, and this file is its consequence. `lib/brain/audience/
-- resolver.ts`'s "THE POSTURE MOVED" header carries the same argument at the
-- module that used to promise the opposite.
--
-- ## What forced it
--
-- Finish condition 2 reads *"every authoritative claim has a human name on it…
-- you can point at THE PERSON"*. `brain_facts.provenance ->> 'actor'` holds an
-- opaque vendor handle — `slack:U0AQW6KF2EM` — and NOTHING in the record maps
-- it to a person. #5424 demonstrated the gate holds (no claim is missing an
-- actor, a source or a date) and then asked whether a stable handle satisfies
-- "a human name". Answered 2026-08-25: no.
--
-- The obvious fix — a resolved Atlas user id beside the actor — was rejected on
-- a MEASUREMENT. Atlas users are a small subset of a chat workspace, and the
-- resolver's SSO-domain narrowing REFUSES to resolve a guest on a personal
-- address rather than guess. Measured in us prod on a four-person dogfood
-- workspace, the most favourable case available: 4 Atlas users, 1 resolved
-- audience member, 2 distinct source actors already producing claims. A
-- resolved-id column would attribute the minority and leave the majority
-- exactly where they started.
--
-- ## Three states, because a nullable id collapses two different facts
--
-- *Not yet resolved* is transient and a sweep fixes it. *Resolved, and this
-- person has no Atlas account* is permanent, and is a legitimate state of a
-- real person. 0187's header names that conflation on slot keys — "NULL used to
-- carry TWO meanings, and eliminating the first is what the constraint is FOR"
-- — and `object_cmp` and `PromotionReport.supersessionHeldBack` already use the
-- shape that avoids it. So `state` is a NOT NULL discriminator, never a
-- nullable id:
--
--   `atlas`     — resolved to an Atlas user id. The name is obtained by a LIVE
--                 join to `"user"`, so renaming the user changes every surface
--                 with no re-ingest. NOTHING is snapshotted here: where a live
--                 join exists a snapshot is strictly worse, because it goes
--                 stale with no re-derivation path.
--   `directory` — the source's directory names them; they have no Atlas
--                 account. A DATED snapshot, because there is no live join to
--                 make. This inverts the rule above for a reason: for someone
--                 who has left both the chat vendor and the company, a name
--                 captured at ingest is the ONLY record that will ever name
--                 them.
--   `opaque`    — the handle and nothing else. A POSITIVE record that Atlas
--                 looked and could not name this person, which is why it is a
--                 stored row rather than an absent one — see erasure below.
--
-- An ABSENT row is a fourth thing and is deliberately distinguishable at rest:
-- no capture pass has reached this actor yet. Both absent and stored-`opaque`
-- render to the reader as "cannot name this person" — the reader is not owed
-- the difference — but an operator is, because one is "wait for the next cycle"
-- and the other is "the directory has nothing and never will".
--
-- ## The bound is AUTHORSHIP, and the bound IS the reversal
--
-- Only principals who actually **authored an ingested episode** get a row.
-- People who spoke into the Atlas, not a copy of the customer's directory.
-- Persisting the whole `users.list` response would be a directory copy and
-- ADR-0036 refuses it by name. What is stored beyond the resolver's old
-- sentence is therefore exactly *the name of someone whose words are already in
-- the record*.
--
-- ## Erasure is why `opaque` is a ROW
--
-- A `directory` snapshot is personal data about someone who is not an Atlas
-- user and cannot themselves ask Atlas for anything, so an operator must be
-- able to clear one. Clearing returns the claim to `opaque` — the `retract`
-- shape, where the record keeps the statement and loses the person — and it
-- must be DURABLE: if erasure were a DELETE, the next 30-minute audience cycle
-- would re-capture the name and the erasure would have lasted half an hour.
-- So an erased row STAYS, as an `opaque` tombstone with `erased_at` set, and
-- the capture writer skips it forever.
--
-- ## What is deliberately NOT indexed
--
-- There is no index on `email`, `display_name` or `real_name`, and that is a
-- prohibition rather than an omission. ADR-0036: *"Nothing may query these rows
-- to FIND a person; they are readable only as the rendering of a specific
-- claim's `actor`, under that claim's own attribution gate."* The primary key
-- serves the only supported access path — actor → identity — and a name index
-- would make the unsupported one cheap enough to write by accident.
--
-- ## What this does not license
--
-- It is not a people directory, not an `@`-mention resolver, not a contact
-- surface, and not a join key for anything. A row here confers NO membership,
-- NO grant and NO entitlement: `fact_audience_member` remains the only table
-- that grants, and `user_id` here is a display pointer, never an ACL input.

CREATE TABLE IF NOT EXISTS brain_actor_identity (
  -- Better-Auth organization id. Workspace-global, TEXT/no-FK like every other
  -- org-scoped Atlas table.
  workspace_id text NOT NULL,

  -- The claim's `provenance.actor`, VERBATIM — `<source>:<vendor user id>`,
  -- e.g. `slack:U0AQW6KF2EM`. This is the join key and it is the WHOLE reason
  -- the identity lives in a side table: ADR-0037 §5's retain-the-surface rule
  -- says the stored handle is never rewritten, so the resolved identity is
  -- added BESIDE it. Re-deriving identity from a rewritten value is
  -- irreversible, and a snapshot is exactly the kind of data later found wrong.
  actor text NOT NULL,

  -- The two halves of `actor`, stored split so a reader never has to re-parse
  -- the composite. `source` matches `brain_episodes.source`; `vendor_user_id`
  -- is what the vendor's own API answers to.
  source text NOT NULL,
  vendor_user_id text NOT NULL,

  -- The discriminator. NOT NULL, closed by CHECK, and the reason this table is
  -- not `provenance.actorUserId` — see the header.
  state text NOT NULL,

  -- `atlas` ONLY. A Better-Auth `"user".id`, resolved through the audience
  -- resolver's email join. The NAME is not stored: the reader joins `"user"`
  -- live, which is the whole point of this state.
  --
  -- ⚠️ No FK, matching every other org-scoped table's posture toward the
  -- Better-Auth spine (those tables are global by ADR-0024 and are not in
  -- `db/schema.ts`). A deleted user therefore leaves a dangling pointer, and
  -- the reader treats a join that answers nothing as `opaque` rather than
  -- rendering a blank — deletion of the account is not a licence to assert a
  -- name Atlas can no longer stand behind.
  user_id text,

  -- `directory` ONLY — the dated snapshot. Both name fields are carried because
  -- the vendor distinguishes them and neither is reliably present: Slack's
  -- `profile.display_name` is what the person chose to be called and is often
  -- empty, `profile.real_name` is what the workspace admin sees. A reader
  -- prefers the display name and falls back.
  display_name text,
  real_name text,
  -- The durable cross-system identifier, and the only join the vendor's Web API
  -- supports. On the wire under the SAME attribution gate as `actor`: a display
  -- name alone can be a nickname shared by two people, and condition 2 asks a
  -- reviewer to point at THE PERSON.
  email text,
  -- When the snapshot was taken. NOT NULL for `directory` so a stale name is
  -- legible AS STALE rather than asserted as current — the `brain_entity`
  -- `snapshot_at` argument, applied to a person.
  snapshot_at timestamptz,

  -- Operator erasure. Set ⇒ `state = 'opaque'` and the capture writer skips
  -- this row forever. See the header: erasure that a background cycle can undo
  -- is not erasure.
  erased_at timestamptz,
  -- Who erased it. Attribution on the erasure itself, on the same argument
  -- `brain_slack_channel.excluded_by` and `brain_enrollment.enrolled_by` make.
  erased_by text,

  -- When this actor first got a row, and when it last changed. `captured_at` is
  -- NOT `snapshot_at`: a row can be re-captured to the same values (no snapshot
  -- change) or move between states.
  captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One identity per actor per workspace. The actor IS the identity here — the
  -- same handle in two workspaces is two rows, because the directory that names
  -- it is the workspace's, not the vendor's.
  PRIMARY KEY (workspace_id, actor),

  -- `''` on any of the three key columns is a row that joins nothing (or, for
  -- `actor`, joins every other degenerate row) — 0187's `DEFAULT ''` hazard.
  CONSTRAINT ck_brain_actor_identity_key_present
    CHECK (actor <> '' AND source <> '' AND vendor_user_id <> ''),

  CONSTRAINT ck_brain_actor_identity_state
    CHECK (state IN ('atlas', 'directory', 'opaque')),

  -- The three states, enforced at rest rather than trusted from the writer.
  -- Each arm is exhaustive in BOTH directions — it says what must be present
  -- and what must be absent — so a half-written row cannot present as another
  -- state. Without the absence half, an `atlas` row carrying a stale
  -- `display_name` would render whichever field the reader happened to prefer.
  CONSTRAINT ck_brain_actor_identity_atlas_shape
    CHECK (
      state <> 'atlas'
      OR (
        user_id IS NOT NULL AND user_id <> ''
        AND display_name IS NULL AND real_name IS NULL AND email IS NULL
        AND snapshot_at IS NULL
      )
    ),

  -- At least one NAMING field, because a `directory` row that names nobody is
  -- an `opaque` row with extra steps — and it would render as a blank, which is
  -- precisely the outcome the condition refuses. Email counts: it names a
  -- person to anyone who can read it.
  CONSTRAINT ck_brain_actor_identity_directory_shape
    CHECK (
      state <> 'directory'
      OR (
        user_id IS NULL
        AND snapshot_at IS NOT NULL
        -- COALESCE, not a bare `<> ''`: a CHECK PASSES when its expression
        -- is NULL, so `display_name <> ''` on three NULL columns evaluates to
        -- NULL and admits exactly the nameless `directory` row this arm exists
        -- to forbid.
        AND (
          COALESCE(display_name, '') <> ''
          OR COALESCE(real_name, '') <> ''
          OR COALESCE(email, '') <> ''
        )
      )
    ),

  CONSTRAINT ck_brain_actor_identity_opaque_shape
    CHECK (
      state <> 'opaque'
      OR (
        user_id IS NULL AND display_name IS NULL AND real_name IS NULL
        AND email IS NULL AND snapshot_at IS NULL
      )
    ),

  -- Erasure implies the tombstone state. The reverse is NOT implied: an
  -- `opaque` row with no `erased_at` is the ordinary "we looked and the
  -- directory did not name them" outcome, which is a different fact from "a
  -- person removed this name".
  CONSTRAINT ck_brain_actor_identity_erasure_shape
    CHECK (erased_at IS NULL OR (state = 'opaque' AND erased_by IS NOT NULL AND erased_by <> ''))
);

-- The capture writer's own read: "which of this workspace's actors have I
-- already resolved, and which did an operator erase?" A workspace-prefix scan,
-- which the primary key already serves — so there is deliberately NO second
-- index here. See the header for the name columns that are deliberately
-- unindexed; this comment records that the omission was considered for the
-- writer's path too and that the PK covers it.
