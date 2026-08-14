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

# _run_guard <relpath> <contents> — stage a throwaway tree holding ONE file and
# run the guard against it. Results come back in GUARD_RC and GUARD_OUT.
#
# The three fixture helpers below differ only in what they ASSERT; staging the
# tree is identical for all of them and was written out three times.
#
# BOTH results are globals, deliberately. Echoing the status so a caller could
# write `rc="$(_run_guard …)"` puts the whole function in a SUBSHELL, where the
# GUARD_OUT assignment is discarded — the message fixtures then matched against
# an empty string and passed only because they were asserting on nothing.
GUARD_OUT=""
GUARD_RC=0
_run_guard() {
  local relpath="$1" contents="$2" tmp rc=0
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/$(dirname "$relpath")"
  printf '%s\n' "$contents" > "$tmp/$relpath"
  GUARD_OUT="$(BRAIN_PROMOTION_ROOT="$tmp" bash "$SCRIPT" 2>&1)" || rc=$?
  # intentionally ignored: best-effort restore so `rm -rf` cannot be blocked by
  # a fixture's own `chmod 000`; the `rm -rf` that follows reports its own
  # failure if this did not help.
  chmod -R u+rwX "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
  GUARD_RC="$rc"
}

_tally() {
  local ok="$1" label="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label — $detail"; FAIL=$((FAIL + 1))
  fi
}

# run_fixture <label> <expect: pass|fail> <relative-path> <file-contents>
run_fixture() {
  local label="$1" expect="$2"
  _run_guard "$3" "$4"
  if { [ "$expect" = "pass" ] && [ "$GUARD_RC" -eq 0 ]; } \
    || { [ "$expect" = "fail" ] && [ "$GUARD_RC" -eq 1 ]; }; then
    _tally 1 "$label" ""
  else
    _tally 0 "$label" "expected $expect, got exit $GUARD_RC"
  fi
}

# run_message_fixture <label> <relative-path> <file-contents> <expected-substring…>
#
# Exit-code fixtures cannot see WHICH advice the guard printed, and the guard
# argues at length that naming the wrong column "would send the reader to fix
# code they did not write". That argument was unenforced: the entire per-column
# remediation text could be deleted and every fixture above stay green.
#
# The case that made this concrete: `statement_writes_gated_column` used to
# return on the first matching arm, and every SLOT-CONSUMER statement carries
# `AND valid_to IS NULL` — all three require it by design, so a realistic re-key
# does too. (Not every brain_facts statement does: `INSERT_FACT_SQL` has no
# WHERE, and the promote UPDATE never names `valid_to`.) So a re-key reported a
# supersession stamp, and the identity advice was unreachable in the one shape
# it exists for — and the HEADLINE, which is the line GitHub surfaces, stayed
# wrong for a further round after the offenders line was fixed.
run_message_fixture() {
  local label="$1" relpath="$2" contents="$3"
  shift 3
  local needle
  _run_guard "$relpath" "$contents"
  if [ "$GUARD_RC" -ne 1 ]; then
    _tally 0 "$label" "expected the gate to FAIL (exit 1), got exit $GUARD_RC"
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$GUARD_OUT"; then
      _tally 0 "$label" "output never mentions: $needle"
      return
    fi
  done
  _tally 1 "$label" ""
}

# run_status_fixture <label> <expected-rc> <setup-fn>
#
# `run_fixture` only distinguishes rc 0 from rc 1, so the guard's fail-CLOSED
# branch — "the candidate scan itself failed, this gate did NOT run", rc 2 — was
# unexpressible and therefore unpinned. That branch is the one that stops a
# broken scan from printing "check passed". Takes a setup callback because these
# fixtures need a tree shape (an unreadable file, an empty tree) rather than one
# file's contents.
run_status_fixture() {
  local label="$1" expect_rc="$2" setup="$3"
  local tmp rc=0
  tmp="$(mktemp -d)"
  "$setup" "$tmp"
  BRAIN_PROMOTION_ROOT="$tmp" bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
  # intentionally ignored: see _run_guard.
  chmod -R u+rwX "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
  if [ "$rc" -eq "$expect_rc" ]; then
    _tally 1 "$label" ""
  else
    _tally 0 "$label" "expected exit $expect_rc, got $rc"
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

# (j2) A MUTATION SPEC quoting the forbidden statement → must PASS (#5061).
#      `scripts/mutate.ts` applies these before/after strings to real source and
#      reverts them; writing the violation down is the whole job, and this exact
#      string is how `object-cmp-pg.test.ts` measures what "0191 never grows a
#      backfill" is worth. Excluded by the `*.mutations.ts` pattern.
run_fixture "a .mutations.ts spec quoting the forbidden statement is excluded" pass \
  "packages/api/scripts/mutations/object-cmp.mutations.ts" \
'export const EDIT = { newString: `UPDATE brain_facts SET object_cmp = object;` };'

# (j3) THE NEGATIVE CONTROL for (j2), and the reason the carve-out is a SUFFIX
#      rather than a directory: a file in the same directory that is not a spec
#      must still FAIL. Without this, `--exclude-dir='mutations'` would pass the
#      suite identically while exempting every `mutations/` directory in the
#      tree — including a GraphQL or migration module that happens to take the
#      name.
run_fixture "a non-spec .ts beside the mutation specs still fails" fail \
  "packages/api/scripts/mutations/helper.ts" \
'await db.query(`UPDATE brain_facts SET object_cmp = object`);'

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
#     it sets status, and a positional insert into a table this wide is
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

# The must-PASS arm for `valid_to` ITSELF, not just its `valid_from` sibling.
# Without it the "both directions on every column" claim was false for the one
# column the guard calls invisible-when-violated: adding `valid_to` to the
# blanket INSERT rule would have broken no fixture. An INSERT carrying a closed
# window is a RESTORE (the region import writes it verbatim), not a new
# arbitration — the same line the allowlist draws.
run_fixture "INSERT naming valid_to passes — a closed window is a restore, not an arbitration" pass \
  "packages/api/src/lib/brain/import-shape.ts" \
'await db.query(`INSERT INTO brain_facts (workspace_id, subject, predicate, object, valid_from, valid_to, provenance, source_episode_id, visible_to)
  VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::jsonb,$8::uuid, ARRAY(SELECT jsonb_array_elements_text($9::jsonb)))`);'

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

# ── pre_widening_visible_to (#4836): the grant arm's second column ────────
#
# It rides the SAME alternation as `visible_to` — `(pre_widening_)?visible_to`
# — and had no fixture of its own until #4939, which is a gap rather than a
# style choice: `\b` sits at a `_`/`v` boundary that is NOT a word boundary, so
# `\bvisible_to\b` does not match inside `pre_widening_visible_to`. The
# optional-prefix group is load-bearing, and nothing held it. Corrupting this
# column is silent in both directions (#4836's disclosure returns in full, or
# attribution is withheld corpus-wide), and the header of migration 0183
# explicitly forecloses the backfill script that would be the likeliest rogue
# writer — so the arm has to be pinned, not assumed.
run_fixture "UPDATE … SET pre_widening_visible_to fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET pre_widening_visible_to = ARRAY['"'"'org'"'"'] WHERE workspace_id = $1`);'

run_fixture "Drizzle .update().set({preWideningVisibleTo}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ preWideningVisibleTo: tokens }).where(eq(brainFacts.id, id));'

# Same asymmetry as the grant it shadows: an INSERT naming it is a restore, not
# a widening decision — the region import writes the column verbatim. Names the
# pre-widening column ALONE, deliberately: an INSERT carrying `visible_to` too
# would pass on that column's arm regardless, and prove nothing about this one.
run_fixture "INSERT naming pre_widening_visible_to passes (restore, not a widening)" pass \
  "packages/api/src/lib/brain/import-shape.ts" \
'await db.query(`INSERT INTO brain_facts (workspace_id, subject, predicate, object, pre_widening_visible_to, provenance, source_episode_id)
  VALUES ($1,$2,$3,$4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6::jsonb, $7::uuid)`);'

# ── the identity keys (#5019, ADR-0037) ──────────────────────────────────
#
# UPDATE-forbidden / INSERT-legal, on the grant's exact terms: a key is derived
# at ingest, and re-keying is what changes a claim's collisions — which is what
# the publish gate stamps `valid_to` on. Each column gets its OWN failing
# fixture rather than one representative, because they are four independent
# alternations in the arm and a fixture on one proves nothing about the others.

run_fixture "UPDATE … SET subject_key fails (a re-key outside the approval seam)" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET subject_key = $2 WHERE workspace_id = $1`);'

run_fixture "UPDATE … SET predicate_key fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET predicate_key = $2 WHERE workspace_id = $1 AND predicate_key = $3`);'

run_fixture "UPDATE … SET object_key fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET object_key = $2 WHERE workspace_id = $1`);'

run_fixture "Drizzle .update().set({subjectKey}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ subjectKey: k }).where(eq(brainFacts.id, id));'

run_fixture "Drizzle .update().set({predicateKey}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ predicateKey: k }).where(eq(brainFacts.id, id));'

run_fixture "Drizzle .update().set({objectKey}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.update(brainFacts).set({ objectKey: k }).where(eq(brainFacts.id, id));'

# The upsert half, the shape that evaded the grant arm when it was first
# written — it names no table after `UPDATE`.
run_fixture "ON CONFLICT … DO UPDATE SET predicate_key fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`INSERT INTO brain_facts (id, workspace_id, subject) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET predicate_key = $4`);'

run_fixture "Drizzle .insert().onConflictDoUpdate({set:{objectKey}}) fails" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.insert(brainFacts).values({ subject: s }).onConflictDoUpdate({ target: brainFacts.id, set: { objectKey: k } });'

# Both `_cmp` arms now guard a REAL column against a real re-key — `object_cmp`
# since #5030 / migration 0191, `subject_cmp` since #5032 / migration 0193 — and
# `INSERT_FACT_SQL` writes both, which is legal because this gate is UPDATE-only.
# (This block used to say `subject_cmp` was gated ahead of its column and that
# its fixture was the only thing holding the alternation in place. True then,
# false now, and left uncorrected it would misdescribe what the fixture proves.)
#
# ⚠️ They are still not twins, and the two fixtures are not one test written
# twice: ADR-0037 defines `object_cmp` as proving difference to ENABLE
# supersession and `subject_cmp` as proving it to SUPPRESS every consumer. So a
# rogue re-derivation of the first stamps `valid_to` on a pair nobody
# arbitrated, and of the second splits a live belief apart with no reviewer and
# no row to find it by. Deleting either alternation loses a distinct hazard.
run_fixture "UPDATE … SET subject_cmp fails (the column EXISTS since #5032)" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET subject_cmp = $2 WHERE workspace_id = $1`);'

run_fixture "UPDATE … SET object_cmp fails (the column EXISTS since #5030)" fail \
  "packages/api/src/lib/brain/rogue.ts" \
'await db.query(`UPDATE brain_facts SET object_cmp = $2 WHERE workspace_id = $1`);'

# The must-PASS half. An INSERT naming the keys is #5020'"'"'s `INSERT_FACT_SQL`,
# and gating it would refuse the write the whole identity design rests on —
# the same line the grant draws. Names ONLY the key columns beyond the
# structural minimum, so it cannot pass on some other column'"'"'s arm.
run_fixture "INSERT naming the identity keys passes — derived at ingest, like the grant" pass \
  "packages/api/src/lib/brain/reconcile-shape.ts" \
'await db.query(`INSERT INTO brain_facts (workspace_id, subject, predicate, object, subject_key, predicate_key, object_key, provenance, source_episode_id, visible_to)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid, ARRAY(SELECT jsonb_array_elements_text($10::jsonb)))`);'

run_fixture "Drizzle .insert().values({subjectKey}) passes" pass \
  "packages/api/src/lib/brain/reconcile-shape.ts" \
'await db.insert(brainFacts).values({ subject: s, subjectKey: sk, predicateKey: pk, objectKey: ok, visibleTo: tokens });'

# Reading and JOINING on a key is the entire point of materializing it — the
# gate must not make the slot lookup itself unwritable.
run_fixture "SELECT joining on the identity keys passes" pass \
  "packages/api/src/lib/brain/read.ts" \
'const rows = await db.query(`SELECT id FROM brain_facts WHERE workspace_id = $1 AND subject_key = $2 AND predicate_key = $3 AND object_key = $4 AND invalidated_at IS NULL AND valid_to IS NULL`);'

# The regression that matters: retraction is the one legitimate unallowlisted
# brain_facts UPDATE, and it must stay legitimate now that five more columns are
# gated. Re-pinned here rather than assumed from the `valid_to` fixture above,
# since a new arm is a new way to break it.
run_fixture "retraction still passes with the identity keys gated" pass \
  "packages/api/src/lib/brain/retract3.ts" \
'await db.query(`UPDATE brain_facts AS f SET invalidated_at = now(), updated_at = now() WHERE f.id = $1 AND f.invalidated_at IS NULL`);'

# A one-shot backfill under `db/migrations/scripts/*.ts` is the path the guard's
# header specifically says it declines to exclude by directory. Nothing pinned
# that for the identity arm.
run_fixture "a .ts re-key under db/migrations/scripts/ fails" fail \
  "packages/api/src/lib/db/migrations/scripts/rekey-identity.ts" \
'await pool.query(`UPDATE brain_facts SET predicate_key = $2 WHERE workspace_id = $1 AND predicate_key = $3`);'

# ── the failure MESSAGE, not just the exit code ───────────────────────────
#
# The realistic re-key. It carries `AND valid_to IS NULL` because all three slot
# consumers require it, which is exactly what made first-match reporting route
# this to the supersession advice. Both arms must be named, and the identity
# remedy — the alias-approval seam, and INSERT being legal — must be printed.
run_message_fixture "a re-key that also mentions valid_to reports BOTH arms, with the identity remedy" \
  "packages/api/src/lib/brain/rekey.ts" \
'await db.query(`UPDATE brain_facts
   SET subject_key = $3, predicate_key = $4
 WHERE workspace_id = $1 AND subject_key = $2
   AND invalidated_at IS NULL AND valid_to IS NULL`);' \
  "is RE-KEYED outside the alias-approval seam (#5019)" \
  "(valid_to identity)" \
  "alias-approval" \
  "Naming the keys on the INSERT is correct and required"

# ── the scan's own failure modes ─────────────────────────────────────────
#
# A tree with no candidate file at all must PASS (rc 0): grep exits 1, which is
# the one benign status.
_setup_empty() { mkdir -p "$1/packages/api/src/lib/brain"; printf 'export const X = 1;\n' > "$1/packages/api/src/lib/brain/unrelated.ts"; }
run_status_fixture "an empty tree passes — grep exit 1 is 'no match', not 'broken'" 0 _setup_empty

# An UNREADABLE candidate must fail CLOSED (rc 2), not print "check passed".
# Without this, a permission error, a missing grep, or a bad root all render as
# a clean scan — the exact fail-open shape CLAUDE.md forbids on a security gate.
_setup_unreadable() {
  mkdir -p "$1/packages/api/src/lib/brain"
  printf 'await db.query(`SELECT id FROM brain_facts`);\n' > "$1/packages/api/src/lib/brain/read.ts"
  chmod 000 "$1/packages/api/src/lib/brain/read.ts"
}
# Skipped for root, which can read anything and would see rc 0 here.
if [ "$(id -u)" -ne 0 ]; then
  run_status_fixture "an unreadable candidate fails CLOSED (exit 2), never 'check passed'" 2 _setup_unreadable
else
  echo "  ~ skipped (running as root): an unreadable candidate fails CLOSED"
fi

# ── the headline precedence, EVERY ordered pair ──────────────────────────
#
# The guard picks one `::error::` headline from `SEVERITY_ORDER`. That order was
# wrong twice in one review — `valid_to` ahead of `identity`, so a re-key was
# reported as a supersession stamp — and it survived the first fix because the
# only fixture covering it pinned a single pair.
#
# TWO assertions, and the split is the point. Generating the pairs from the
# script's own array would be self-fulfilling: reorder the array and the
# expectations reorder with it, which is a test agreeing with the code rather
# than checking it. So the intended order is written out HERE as the pin, the
# script's array is required to equal it, and the pairs are then generated to
# prove the IMPLEMENTATION (`arm_fired` / `headline_for`) matches the
# declaration. Changing the precedence means editing both, deliberately.
#
# One SET list naming both columns trips both arms; the higher-precedence one
# must own the headline.
declare -A PRECEDENCE_COLUMN=(
  [visible_to]="visible_to"
  [identity]="subject_key"
  [valid_to]="valid_to"
  [status]="status"
)
declare -A PRECEDENCE_HEADLINE=(
  [visible_to]="\`visible_to\` is MUTATED"
  [identity]="is RE-KEYED outside the alias-approval seam"
  [valid_to]="\`valid_to\` is stamped"
  [status]="\`status\` is written"
)

# The pin. Failure direction, most severe first: a grant write DISCLOSES; a
# re-key reaches the irreversible `valid_to` stamp by proxy, so it subsumes the
# stamp wherever a statement carries both; a stamp retires a belief invisibly; a
# status write over-trusts a claim, the recoverable one.
EXPECTED_ORDER=(visible_to identity valid_to status)

SEVERITY_ORDER_LINE="$(grep -oE '^SEVERITY_ORDER=\(([^)]*)\)' "$SCRIPT" | head -1)"
if [ -z "$SEVERITY_ORDER_LINE" ]; then
  echo "  ✗ check-brain-fact-promotion.sh no longer declares SEVERITY_ORDER=( … ) — re-point this parse, or every pair below is unasserted"
  FAIL=$((FAIL + 1))
else
  # shellcheck disable=SC2206
  ORDER=( ${SEVERITY_ORDER_LINE#SEVERITY_ORDER=(} )
  ORDER[${#ORDER[@]}-1]="${ORDER[${#ORDER[@]}-1]%)}"
  if [ "${ORDER[*]}" = "${EXPECTED_ORDER[*]}" ]; then
    _tally 1 "SEVERITY_ORDER is (${EXPECTED_ORDER[*]})" ""
  else
    _tally 0 "SEVERITY_ORDER is (${EXPECTED_ORDER[*]})" \
      "the script declares (${ORDER[*]}). The headline order is a failure-direction decision, not a formatting choice — if you mean to change it, change EXPECTED_ORDER here too and say why."
  fi
  for hi in "${ORDER[@]}"; do
    for lo in "${ORDER[@]}"; do
      [ "$hi" = "$lo" ] && continue
      # Only assert pairs in the declared order (hi before lo).
      hi_i=-1; lo_i=-1
      for i in "${!ORDER[@]}"; do
        [ "${ORDER[$i]}" = "$hi" ] && hi_i=$i
        [ "${ORDER[$i]}" = "$lo" ] && lo_i=$i
      done
      [ "$hi_i" -lt "$lo_i" ] || continue
      run_message_fixture "precedence: $hi outranks $lo in the headline" \
        "packages/api/src/lib/brain/precedence.ts" \
        "await db.query(\`UPDATE brain_facts SET ${PRECEDENCE_COLUMN[$hi]} = \$2, ${PRECEDENCE_COLUMN[$lo]} = \$3 WHERE workspace_id = \$1\`);" \
        "${PRECEDENCE_HEADLINE[$hi]}"
    done
  done
fi

# …and a re-key that mentions nothing else gets the same headline by the
# single-arm route, so the precedence chain is pinned from both directions.
run_message_fixture "a bare re-key gets the identity headline alone" \
  "packages/api/src/lib/brain/rekey2.ts" \
'await db.query(`UPDATE brain_facts SET object_key = $2 WHERE workspace_id = $1`);' \
  "is RE-KEYED outside the alias-approval seam (#5019)" \
  "(identity)"

echo ""

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
