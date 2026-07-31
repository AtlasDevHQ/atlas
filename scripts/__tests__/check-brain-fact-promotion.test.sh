#!/bin/bash
# Adversarial fixture suite for scripts/check-brain-fact-promotion.sh (#4769).
#
# A guard nobody has watched FAIL is a guard that passes because it matches
# nothing. These fixtures pin both directions: the shapes that must fire, the
# shapes that must not, and the allowlist carve-out.
#
# Each fixture runs against a throwaway tree via BRAIN_PROMOTION_ROOT, so the
# real codebase is never touched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-brain-fact-promotion.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_fixture <label> <expect: pass|fail> <relative-path> <file-contents>
run_fixture() {
  local label="$1" expect="$2" relpath="$3" contents="$4"
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/$(dirname "$relpath")"
  printf '%s\n' "$contents" > "$tmp/$relpath"

  local rc=0
  BRAIN_PROMOTION_ROOT="$tmp" bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
  rm -rf "$tmp"

  if [ "$expect" = "pass" ] && [ "$rc" -eq 0 ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  elif [ "$expect" = "fail" ] && [ "$rc" -eq 1 ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label — expected $expect, got exit $rc"; FAIL=$((FAIL + 1))
  fi
}

echo "check-brain-fact-promotion adversarial fixtures:"

# (a) The canonical rogue promotion → must FAIL.
run_fixture "single-line UPDATE … SET status fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1`);'

# (b) The same statement spread over lines inside a template literal — the shape
#     real SQL in this codebase actually takes → must FAIL.
run_fixture "multi-line UPDATE … SET status fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`
  UPDATE brain_facts
     SET status = '"'"'published'"'"',
         updated_at = now()
   WHERE workspace_id = $1
`);'

# (c) An INSERT that NAMES status → must FAIL. A writer choosing the review
#     state at insert time is the same bypass as promoting one.
run_fixture "INSERT naming status fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject, status) VALUES ($1,$2,$3,$4)`);'

# (d) An INSERT that omits status → must PASS. This is the expected ingest
#     shape: 0180 defaults the column to '"'"'draft'"'"', so the gate applies itself.
run_fixture "INSERT omitting status passes (0180 defaults to draft)" pass \
  "packages/api/src/lib/brain/connector.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject, predicate, object, provenance, source_episode_id, visible_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`);'

# (e) A non-status UPDATE (retraction stamps invalidated_at) → must PASS.
run_fixture "UPDATE of invalidated_at passes (retraction is not a status flip)" pass \
  "packages/api/src/lib/brain/retract.ts" \
'await db.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1`);'

# (f) A SELECT that merely reads status → must PASS.
run_fixture "SELECT gating on status passes" pass \
  "packages/api/src/lib/brain/search.ts" \
'await db.query(`SELECT id FROM brain_facts WHERE workspace_id = $1 AND status = '"'"'published'"'"'`);'

# (g) Prose in a comment describing the forbidden statement → must PASS. The
#     guard strips comments; otherwise every doc-comment about the rule would
#     trip the rule.
run_fixture "commented-out / prose mention does not false-positive" pass \
  "packages/api/src/lib/brain/notes.ts" \
'// Never write `UPDATE brain_facts SET status = '"'"'published'"'"'` outside the adapter.
export const NOTE = 1;'

# (h) The adapter itself — the one legitimate promotion path → must PASS.
run_fixture "the allowlisted adapter passes" pass \
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1 AND id = ANY($2::uuid[])`);'

# (i) The allowlisted region import → must PASS (restores a prior gate decision).
run_fixture "the allowlisted region import passes" pass \
  "packages/api/src/api/routes/admin-migrate.ts" \
'await client.query(`INSERT INTO brain_facts (id, workspace_id, subject, status, visible_to) VALUES ($1,$2,$3,$4,$5)`);'

# (i2) The allowlisted correction machinery (#4915) → must PASS: `correct_fact`
#      is the second gate-time decision maker the gated-column commentary
#      forecast, promoting the human-authored replacement inside the
#      correction transaction.
run_fixture "the allowlisted correction machinery passes" pass \
  "packages/api/src/lib/brain/correction.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1 AND id = $2::uuid AND status = '"'"'draft'"'"'`);'

# (i2b) The generated template mirror of the correction machinery → must PASS
#       under its own glob, exactly like fixture (w) for the adapter — the
#       template scan is deliberate, so each allowlisted file needs both
#       spellings covered.
run_fixture "generated template mirror of the correction machinery passes" pass \
  "create-atlas/templates/nextjs-standalone/src/lib/brain/correction.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1 AND id = $2::uuid AND status = '"'"'draft'"'"'`);'

# (i3) The carve-out is the FILE, not the directory: a sibling under
#      `lib/brain/` writing the same shape must still FAIL.
run_fixture "a non-allowlisted lib/brain sibling still fails" fail \
  "packages/api/src/lib/brain/reconcile.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1`);'

# (j) A test file staging a published fixture → must PASS (excluded by pattern).
run_fixture "a .test.ts fixture is excluded" pass \
  "packages/api/src/lib/brain/__tests__/seed.test.ts" \
'await pool.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE id = $1`);'

# (k) LOWERCASE SQL → must FAIL. Keyword casing is a style choice, not a
#     security boundary; a case-sensitive guard would be trivially evaded.
run_fixture "lowercase SQL still fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`update brain_facts set status = '"'"'published'"'"' where workspace_id = $1`);'

# (l) A QUOTED identifier → must FAIL.
run_fixture "quoted table identifier still fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE "brain_facts" SET status = '"'"'published'"'"' WHERE id = $1`);'

# (m) An ALIASED update → must FAIL.
run_fixture "aliased UPDATE still fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts AS f SET status = '"'"'published'"'"' WHERE f.id = $1`);'

# (n) The Drizzle write-builder form → must FAIL. No such call site exists today
#     (the codebase writes this table only as raw SQL), so this is a tripwire
#     for a style change — exactly the shape a grep-only guard would miss.
run_fixture "Drizzle write-builder form fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ status: "published" }).where(eq(brainFacts.id, id));'

# (o) A Drizzle SELECT naming the table → must PASS. The pre-filter now matches
#     `brainFacts`, so a read must not be caught by the widened net.
run_fixture "Drizzle select on brainFacts passes" pass \
  "packages/api/src/lib/brain/read.ts" \
'const rows = await db.select().from(brainFacts).where(eq(brainFacts.status, "published"));'

# (p) A non-status Drizzle update (retraction) → must PASS.
run_fixture "Drizzle update of invalidated_at passes" pass \
  "packages/api/src/lib/brain/retract.ts" \
'await db.update(brainFacts).set({ invalidatedAt: new Date() }).where(eq(brainFacts.id, id));'

# (q) The UPSERT shape — the one the original suite missed, and the one
#     ADR-0030's connector engine actually writes. No table name follows
#     `UPDATE`; `status` is absent from the INSERT column list.
run_fixture "ON CONFLICT … DO UPDATE SET status fails" fail \
  "packages/api/src/lib/brain/connector.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject) VALUES ($1,$2,$3)
  ON CONFLICT (id) DO UPDATE SET status = '"'"'published'"'"'`);'

# (r) The same upsert WITHOUT touching status → must PASS. Re-ingest of a fact
#     body is legitimate; only the review state is gated.
run_fixture "ON CONFLICT … DO UPDATE of a non-status column passes" pass \
  "packages/api/src/lib/brain/connector.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, object) VALUES ($1,$2,$3)
  ON CONFLICT (id) DO UPDATE SET object = EXCLUDED.object`);'

# (s) A SCHEMA-QUALIFIED update → must FAIL.
run_fixture "schema-qualified UPDATE fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE public.brain_facts SET status = '"'"'published'"'"' WHERE id = $1`);'

# (t) A POSITIONAL insert (no column list) → must FAIL. Grep cannot tell whether
#     it sets status, and a positional insert into a 17-column table is
#     unreviewable regardless.
run_fixture "column-less positional INSERT fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`INSERT INTO brain_facts VALUES ($1,$2,$3,'"'"'published'"'"')`);'

# (u) A one-shot backfill under db/migrations/scripts/ → must FAIL. CLAUDE.md
#     says backfills live exactly there, and an `--exclude-dir=migrations`
#     swallowed the whole path until this was probed.
run_fixture "backfill under db/migrations/scripts/ is NOT exempt" fail \
  "packages/api/src/lib/db/migrations/scripts/0180-backfill.ts" \
'await db.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1`);'

# (v) The over-breadth the docstring admits: a retraction that FILTERS on status
#     is refused too. Pinned so the behaviour is a stated decision rather than a
#     surprise — loosening it must be a deliberate edit that fails this fixture.
run_fixture "retraction that merely FILTERS on status is refused (documented over-breadth)" fail \
  "packages/api/src/lib/brain/retract.ts" \
'await db.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1 AND status = '"'"'published'"'"'`);'

# (w) The GENERATED template mirror of an allowlisted file → must PASS.
#     `prepare-templates.sh` copies packages/api sources into
#     `create-atlas/templates/*/src/` (gitignored). Allowlisting by
#     `packages/api/`-prefixed path exempted the original and then failed on its
#     own copy — caught by /ci, not by these fixtures, which is why it is one now.
run_fixture "generated template mirror of an allowlisted file passes" pass \
  "create-atlas/templates/docker/src/lib/content-mode/adapters/brain-facts.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1`);'

# (x) A template file that is NOT allowlisted → must still FAIL. The scan covers
#     create-atlas deliberately; the allowlist widening must not exempt the tree.
run_fixture "a NON-allowlisted template file still fails" fail \
  "create-atlas/templates/docker/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE id = $1`);'

# ── Shapes a second reviewer found by staging its own trees. Every one of these
#    EVADED the guard when it already had 22 green fixtures — which is the whole
#    argument for probing a gate adversarially instead of trusting its suite.

# (y) Drizzle INSERT naming status. The ORM half had no tripwire at all while
#     the raw-SQL equivalent (fixture c) was refused — one write, two spellings,
#     opposite verdicts. Most plausible shape for #4770/#4771's ingest fiber.
run_fixture "Drizzle .insert().values({status}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.insert(brainFacts).values({ status: "published", subject: s });'

# (z) The Drizzle upsert — the ORM twin of fixture (q).
run_fixture "Drizzle .insert().onConflictDoUpdate({set:{status}}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.insert(brainFacts).values(v).onConflictDoUpdate({ set: { status: "published" } });'

# (aa) A namespace-qualified table reference — `\.update\(brainFacts` could not
#      see `schema.brainFacts`.
run_fixture "Drizzle update on a namespace-qualified table fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(schema.brainFacts).set({ status: "published" });'

# (bb) Quoted AND schema-qualified together. The old single leading `"?`
#      consumed the quote, so the qualifier group could never match the closing
#      one — the docstring claimed both were accepted; only either was.
run_fixture "quoted schema-qualified UPDATE fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE "public"."brain_facts" SET status = $1`);'

# (cc) The INSERT alias form, which is valid Postgres.
run_fixture "INSERT INTO … AS f (…, status) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`INSERT INTO brain_facts AS f (id, status) VALUES ($1,$2)`);'

# (dd) The legitimate ORM ingest — insert WITHOUT status → must PASS. This is
#      the shape #4770/#4771 should write, and the widened insert pattern must
#      not block it.
run_fixture "Drizzle .insert() omitting status passes" pass \
  "packages/api/src/lib/brain/connector.ts" \
'await db.insert(brainFacts).values({ subject: s, predicate: p, object: o, visibleTo: ["org"] });'

# (ee) The allowlist must pin the PACKAGE, not just the relative path. Rooting
#      the entries at `src/` (the first fix for the template-mirror problem) was
#      shorter and covered both real homes — and silently handed the same
#      carve-out to every other scanned root. Fixture (x) missed it because it
#      varied the FILENAME rather than the package.
run_fixture "a rogue plugin at the allowlisted RELATIVE path is NOT exempt" fail \
  "plugins/rogue/src/api/routes/admin-migrate.ts" \
'await db.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE id = $1`);'

run_fixture "ee/ at the allowlisted relative path is NOT exempt" fail \
  "ee/src/lib/content-mode/adapters/brain-facts.ts" \
'await tx.query(`UPDATE brain_facts SET status = '"'"'published'"'"' WHERE workspace_id = $1`);'

# (ff) Statement splitting must not let two UNRELATED statements pair up: an
#      UPDATE of some other table plus a later mention of brain_facts.status
#      is not a write to it. This is the correctness half of the per-statement
#      rewrite (the other half was cutting the gate from 211s to ~1s).
run_fixture "tokens from two different statements do not pair up" pass \
  "packages/api/src/lib/brain/read.ts" \
'await db.query(`UPDATE other_table SET name = $1`);
const live = await db.query(`SELECT id FROM brain_facts WHERE status = '"'"'published'"'"'`);'

# ── (gg) The `visible_to` arm (#4823). Publish now writes the GRANT as well as
#    the review state, so a second writer to that column is the same class of
#    defect — with a worse failure direction: `status` fails closed, an ACL
#    fails open. The arm is deliberately UPDATE-ONLY; the INSERT fixtures below
#    are what stop a future edit from "tidying" it into symmetry with `status`
#    and breaking derive-at-ingest.

run_fixture "UPDATE … SET visible_to fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET visible_to = ARRAY['"'"'org'"'"'] WHERE id = $1`);'

run_fixture "Drizzle .update().set({visibleTo}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ visibleTo: ["org"] }).where(eq(brainFacts.id, id));'

run_fixture "ON CONFLICT … DO UPDATE SET visible_to fails" fail \
  "packages/api/src/lib/brain/connector.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject) VALUES ($1,$2,$3)
  ON CONFLICT (id) DO UPDATE SET visible_to = EXCLUDED.visible_to`);'

# An INSERT naming `visible_to` must PASS: that IS the derive-at-ingest grant
# (`reconcile.ts`'s INSERT_FACT_SQL, `ingest/episodes.ts`). Refusing it would
# refuse the write the whole ACL design rests on.
run_fixture "Drizzle .insert().onConflictDoUpdate({set:{visibleTo}}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.insert(brainFacts).values(v).onConflictDoUpdate({ set: { visibleTo: ["org"] } });'

run_fixture "INSERT naming visible_to passes — the grant IS derived at ingest" pass \
  "packages/api/src/lib/brain/reconcile.ts" \
'await tx.query(`INSERT INTO brain_facts (workspace_id, subject, predicate, object, provenance, source_episode_id, visible_to)
  VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid, ARRAY(SELECT jsonb_array_elements_text($7::jsonb)))`);'

run_fixture "Drizzle .insert().values({visibleTo}) passes — INSERT-only asymmetry" pass \
  "packages/api/src/lib/brain/ingest/episodes.ts" \
'await db.insert(brainFacts).values({ subject: s, visibleTo: ["org"] });'

# The allowlisted adapter is where the widening UPDATE lives.
run_fixture "the allowlisted adapter's visible_to widening passes" pass \
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts" \
'await tx.query(`UPDATE brain_facts f SET status = '"'"'published'"'"', visible_to = ARRAY(SELECT jsonb_array_elements_text(w.grant)) FROM (SELECT 1) w WHERE f.status = '"'"'draft'"'"'`);'

# A write to some OTHER table'"'"'s visible_to is not this gate'"'"'s business.
run_fixture "UPDATE of another table's visible_to passes" pass \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_episodes SET visible_to = ARRAY['"'"'org'"'"'] WHERE id = $1`);
const live = await db.query(`SELECT id FROM brain_facts`);'

# ── valid_to (#4912): the supersession stamp, UPDATE-only like the grant ──

run_fixture "UPDATE … SET valid_to fails (autonomous supersession)" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET valid_to = now() WHERE workspace_id = $1 AND subject = $2`);'

run_fixture "Drizzle .update().set({validTo}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ validTo: new Date() }).where(eq(brainFacts.id, id));'

run_fixture "INSERT naming valid_from passes — a producer may open a window, never close one" pass \
  "packages/api/src/lib/brain/reconcile-shape.ts" \
'await db.query(`INSERT INTO brain_facts (workspace_id, subject, predicate, object, valid_from, provenance, source_episode_id, visible_to)
  VALUES ($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7::uuid, ARRAY(SELECT jsonb_array_elements_text($8::jsonb)))`);'

run_fixture "SELECT filtering on valid_to passes — reads are the point of the column" pass \
  "packages/api/src/lib/brain/read.ts" \
'const rows = await db.query(`SELECT id FROM brain_facts WHERE workspace_id = $1 AND invalidated_at IS NULL AND valid_to IS NULL`);'

# The allowlisted adapter is where the supersession stamp lives.
run_fixture "the allowlisted adapter's supersession stamp passes" pass \
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts" \
'await tx.query(`UPDATE brain_facts SET valid_to = now(), updated_at = now() WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status = '"'"'published'"'"' AND valid_to IS NULL RETURNING id::text AS id`);'

# A retraction mentions neither gated column, so it must keep passing now that
# `valid_to` is gated — the regression that matters most, because retraction is
# the one legitimate brain_facts UPDATE outside the allowlist.
run_fixture "retraction still passes with valid_to gated" pass \
  "packages/api/src/lib/brain/retract2.ts" \
'await db.query(`UPDATE brain_facts AS f SET invalidated_at = now(), updated_at = now() WHERE f.id = $1 AND f.invalidated_at IS NULL`);'

# The upsert's UPDATE half is the shape that evaded the visible_to gate when it
# was first written, and `valid_to` sits in the same INSERT-legal /
# UPDATE-forbidden asymmetry — so both spellings must trip (#4912).
run_fixture "ON CONFLICT … DO UPDATE SET valid_to fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET valid_to = now()`);'

run_fixture "Drizzle .insert().onConflictDoUpdate({set:{validTo}}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.insert(brainFacts).values({ subject: s }).onConflictDoUpdate({ target: brainFacts.id, set: { validTo: new Date() } });'

echo ""

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
