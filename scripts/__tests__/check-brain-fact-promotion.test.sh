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

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
