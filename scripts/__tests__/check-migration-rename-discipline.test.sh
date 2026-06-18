#!/bin/bash
# Adversarial fixture suite for scripts/check-migration-rename-discipline.sh
# (#3686). Each fixture builds a throwaway git repo with a base commit
# (the "origin/main" equivalent) plus a branch that ADDS one migration,
# then runs the guard with BASE_REF pointed at the base commit — exercising
# the real `git diff --diff-filter=A` path, not a mocked one.
#
# Locks in: the gate FAILS on single-phase RENAME COLUMN / DROP COLUMN in a
# NEWLY-ADDED migration (incl. DO-block and bare-rename spellings), PASSES a
# clean diff, PASSES when the offending statement is only in a PRE-EXISTING
# migration (proving 0133 is exempt by construction), PASSES when an added
# migration carries a justified `-- expand-contract:` marker on a DROP COLUMN,
# and — crucially — still FAILS a RENAME COLUMN even with a marker (the marker
# exempts DROP COLUMN only; a rename is never deploy-safe).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-migration-rename-discipline.sh"
MIG_REL="packages/api/src/lib/db/migrations"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_fixture EXPECTED  NAME  ADDED_FILE_BASENAME  ADDED_FILE_CONTENT  [BASE_SETUP_CMDS]
# BASE_SETUP_CMDS runs in the migrations dir on the base commit (before the
# branch is cut) — used to seed a pre-existing migration.
run_fixture() {
  local expected="$1" name="$2" added_name="$3" added_content="$4" base_setup="${5:-}"
  local tmp
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    git init --quiet -b main
    git config user.email t@t.t && git config user.name t
    mkdir -p "$MIG_REL"
    # Minimal README so the script's pointer path resolves.
    echo "# migrations" > "$MIG_REL/README.md"
    # Always present a pre-existing migration so the dir is non-empty on base.
    echo "CREATE TABLE IF NOT EXISTS seed (id text);" > "$MIG_REL/0001_seed.sql"
    [ -n "$base_setup" ] && ( cd "$MIG_REL" && eval "$base_setup" )
    git add -A && git commit --quiet -m base
    git checkout --quiet -b feature
    printf '%s\n' "$added_content" > "$MIG_REL/$added_name"
    git add -A && git commit --quiet -m "add $added_name"
  )

  local status=0
  ( cd "$tmp" && BASE_REF=main bash "$SCRIPT" > /dev/null 2>&1 ) || status=$?

  if { [ "$expected" = "pass" ] && [ "$status" -eq 0 ]; } ||
     { [ "$expected" = "fail" ] && [ "$status" -eq 1 ]; }; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ── clean diffs pass ──────────────────────────────────────────────────────
run_fixture pass "added CREATE TABLE is clean" "0002_new.sql" \
  'CREATE TABLE IF NOT EXISTS widgets (id text, name text);'

run_fixture pass "added ADD COLUMN (the expand half) is clean" "0002_add.sql" \
  'ALTER TABLE widgets ADD COLUMN origin text;'

run_fixture pass "RENAME TO (table rename) is not a column rename" "0002_tbl.sql" \
  'ALTER TABLE widgets RENAME TO gadgets;'

run_fixture pass "RENAME CONSTRAINT is not a column rename" "0002_con.sql" \
  'ALTER TABLE widgets RENAME CONSTRAINT chk_a TO chk_b;'

run_fixture pass "DROP COLUMN mentioned only in a comment" "0002_cmt.sql" \
  '-- historically this did: DROP COLUMN surface
CREATE TABLE IF NOT EXISTS notes (id text);'

# ── single-phase rename / drop fail ───────────────────────────────────────
run_fixture fail "single-phase RENAME COLUMN" "0002_rename.sql" \
  'ALTER TABLE widgets RENAME COLUMN surface TO origin;'

run_fixture fail "RENAME COLUMN inside a DO block (0133 shape)" "0002_do.sql" \
  'DO $$ BEGIN
  ALTER TABLE approval_rules RENAME COLUMN surface TO origin;
END $$;'

run_fixture fail "bare ALTER TABLE ... RENAME a TO b (column rename)" "0002_bare.sql" \
  'ALTER TABLE widgets RENAME surface TO origin;'

run_fixture fail "single-phase DROP COLUMN" "0002_drop.sql" \
  'ALTER TABLE widgets DROP COLUMN surface;'

run_fixture fail "DROP COLUMN IF EXISTS" "0002_dropif.sql" \
  'ALTER TABLE widgets DROP COLUMN IF EXISTS surface;'

# ── pre-existing migration is exempt by construction (0133) ───────────────
# The offending statement lives in a migration committed on BASE, and the
# branch adds only a clean migration → guard must PASS (never re-scans 0133).
run_fixture pass "pre-existing RENAME COLUMN is never re-scanned" "0002_clean.sql" \
  'CREATE TABLE IF NOT EXISTS clean (id text);' \
  'echo "ALTER TABLE approval_rules RENAME COLUMN surface TO origin;" > 0133_approval_origin_rename.sql'

# ── documented expand-contract escape hatch ───────────────────────────────
run_fixture pass "DROP COLUMN with justified expand-contract marker" "0002_contract.sql" \
  '-- expand-contract: N+1 contract drop; reads removed in 0001 (#1234)
ALTER TABLE widgets DROP COLUMN surface;'

run_fixture fail "bare expand-contract marker (no justification) does not exempt" "0002_bare_marker.sql" \
  '-- expand-contract:
ALTER TABLE widgets DROP COLUMN surface;'

# ── the marker covers DROP COLUMN only — never RENAME COLUMN ───────────────
# A rename is inherently single-phase; the escape hatch must not let one
# through even with a justified marker.
run_fixture fail "RENAME COLUMN with justified marker still fails (marker is DROP-only)" "0002_rename_marked.sql" \
  '-- expand-contract: justified for some reason (#1234)
ALTER TABLE widgets RENAME COLUMN surface TO origin;'

# A marked file may legitimately DROP (suppressed) yet still smuggle a rename —
# the drop is exempt, the rename is not, so the file fails on the rename.
run_fixture fail "marker suppresses the DROP but the co-located RENAME still fails" "0002_drop_and_rename.sql" \
  '-- expand-contract: N+1 contract drop; reads removed in 0001 (#1234)
ALTER TABLE widgets DROP COLUMN legacy;
ALTER TABLE widgets RENAME COLUMN surface TO origin;'

echo ""
echo "check-migration-rename-discipline.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
