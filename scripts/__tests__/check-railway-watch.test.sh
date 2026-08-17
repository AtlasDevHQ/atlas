#!/usr/bin/env bash
# Adversarial fixture suite for scripts/check-railway-watch.sh (#4738).
#
# The gate's verdict is a NEGATIVE — "no bundled path is unwatched" — and the
# failure it prevents is Railway answering `skippedReason: "No changes to watched
# files"` and SILENTLY NEVER DEPLOYING. There is no red build to notice; the
# release simply does not ship. Measured on `packages/mcp/**` at v0.0.63
# (#4733/#4734, fixed by hand in #4737): all four tag-gated services skipped the
# prod push.
#
# ⚠️ THE OLD ARM CANNOT FAIL FOR THIS CLASS, so every case here has to prove the
# NEW arm fired. The COPY-source arm skips `COPY . .` by design — that one line
# bundles every package in the repo — so against the real tree it reported "All
# 54 COPY sources covered" and exit 0 while `packages/okf-bundle` was copied into
# the api image and watched by nobody. Asserting a bare non-zero exit would let
# the old arm's own errors stand in for the new arm's, so every case greps a
# DISCRIMINATING PHRASE.
#
# ⚠️ `set -uo pipefail`, no `-e`: a failing case must not abort the tally.
#
# The four discipline devices, each a measured lesson from a sibling suite:
#   1. every `sed` is asserted to have LANDED (a no-op mutation reports SETUP
#      FAILURE, never a pass);
#   2. no verdict travels through command substitution (`fail` in a subshell
#      increments a copy, and the suite prints FAIL while exiting 0);
#   3. exit 1 ("a path is unwatched") and exit 2/warning ("this gate could not
#      look") are different outcomes;
#   4. an ABSOLUTE expected-case count, because a count derived from the cases
#      cannot notice a deleted case.
#
# Every tree is built under `mktemp -d`; nothing here writes tracked source, and
# the suite asserts `git status --porcelain` is unchanged at the end (#5172).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-railway-watch.sh"

[ -f "$GATE" ] || { echo "::error::gate under test not found at $GATE" >&2; exit 2; }
command -v bun >/dev/null || { echo "::error::bun is not on PATH; the workspace closure cannot be computed" >&2; exit 2; }

GIT_BEFORE="$(git -C "$ROOT" status --porcelain 2>/dev/null || echo "<git unavailable>")"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

CASE_N=0
TREE=""
MUTATED=-1

# A synthetic monorepo: a root package.json with workspaces, four packages
# (`app` depends on `lib`; `lib` peer-depends on `peer`; `orphan` is unrelated),
# and one DOCKERFILE service whose builder does `COPY . .` and whose runner copies
# `packages/app`, `packages/lib/dist` and a single data FILE.
#
# ⚠️ THE THREE COPY SHAPES ARE ALL PRESENT ON PURPOSE. A tree with only a bare
# package dir cannot distinguish the rule this gate ships from the simpler one it
# rejected — see the `data/` case below, which the simpler rule reports as a gap
# that does not exist.
new_tree() {
  CASE_N=$((CASE_N + 1))
  TREE="$TMPROOT/case$CASE_N"
  MUTATED=-1
  mkdir -p "$TREE/deploy/svc" "$TREE/packages/app/src" "$TREE/packages/lib/src" \
           "$TREE/packages/peer/src" "$TREE/packages/orphan/src" "$TREE/packages/data/data"

  cat >"$TREE/package.json" <<'JSON'
{ "name": "root", "private": true, "workspaces": ["packages/*"] }
JSON
  cat >"$TREE/packages/app/package.json" <<'JSON'
{ "name": "@t/app", "dependencies": { "@t/lib": "workspace:*" } }
JSON
  # ⚠️ A RANGE, not `workspace:*`, and in peerDependencies — the shape that makes
  # a protocol-matching closure incomplete. Every plugin in the real repo
  # declares `@useatlas/plugin-sdk` exactly this way while the image copies it in.
  cat >"$TREE/packages/lib/package.json" <<'JSON'
{ "name": "@t/lib", "peerDependencies": { "@t/peer": ">=0.0.1" } }
JSON
  cat >"$TREE/packages/peer/package.json" <<'JSON'
{ "name": "@t/peer" }
JSON
  cat >"$TREE/packages/orphan/package.json" <<'JSON'
{ "name": "@t/orphan" }
JSON
  cat >"$TREE/packages/data/package.json" <<'JSON'
{ "name": "@t/data" }
JSON
  : >"$TREE/packages/data/data/seed.sql"

  cat >"$TREE/deploy/svc/Dockerfile" <<'DOCKER'
FROM base AS builder
COPY package.json ./
COPY . .
FROM base AS runner
COPY --from=builder /app/packages/app ./packages/app
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/packages/data/data/seed.sql ./data/seed.sql
COPY --from=builder /app/node_modules ./node_modules
DOCKER

  cat >"$TREE/deploy/svc/railway.json" <<'JSON'
{
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "deploy/svc/Dockerfile",
    "dockerfileContext": "../..",
    "watchPatterns": [
      "package.json",
      "packages/app/**",
      "packages/lib/**",
      "packages/peer/**",
      "packages/data/data/**",
      "deploy/svc/**"
    ]
  }
}
JSON
}

# mutate REL SED_EXPR — apply and record whether it CHANGED anything.
mutate() {
  local f="$TREE/$1" expr="$2"
  cp "$f" "$f.pre"
  sed -i "$expr" "$f"
  if cmp -s "$f.pre" "$f"; then MUTATED=0; else MUTATED=1; fi
  rm -f "$f.pre"
}

# expect NAME EXPECTED_EXIT PHRASE — three-way: setup failure is not a pass.
expect() {
  local name="$1" want="$2" phrase="$3" rc=0 out
  if [ "$MUTATED" -eq 0 ]; then
    fail "$name — FIXTURE SETUP FAILED: the sed matched nothing, so the tree is pristine and NOTHING was tested. This is not a pass."
    return
  fi
  out=$(RAILWAY_WATCH_ROOT="$TREE" bash "$GATE" 2>&1) || rc=$?
  if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -qF -- "$phrase"; then
    pass "$name (exit $rc)"
  else
    fail "$name — expected exit $want containing '$phrase', got $rc"
    printf '%s\n' "$out" | sed 's/^/       | /' >&2
  fi
}

echo "check-railway-watch.test.sh — adversarial fixtures (#4738)"

# 1. POSITIVE CONTROL, first: everything below is vacuous without it. It also
# pins the SHAPE of the closure — `@t/peer` is reached only through
# `packages/lib`'s peerDependencies, and it must be counted.
new_tree
MUTATED=1
expect "POSITIVE CONTROL — a fully-watched synthetic service passes" 0 \
  "All 4 bundled workspace/image path(s) covered"

# 2. THE #4738 DEFECT ITSELF. A bundled package whose ONLY match is the
# manifest glob — precisely `packages/okf-bundle`'s state before this change.
new_tree
mutate deploy/svc/railway.json 's#"packages/lib/\*\*"#"packages/**/package.json"#'
expect "a bundled package matched ONLY by the manifest glob is caught" 1 \
  "'packages/lib' is bundled into the svc image but no watchPattern covers its source"

# 3. …and the error names the failure signature, because a reader who has not
# seen a silent skip will not otherwise know what they are looking at.
new_tree
mutate deploy/svc/railway.json 's#"packages/lib/\*\*"#"packages/**/package.json"#'
expect "…and the error names Railway's silent-skip signature" 1 \
  'skippedReason: "No changes to watched files"'

# 4. A BARE DIRECTORY ENTRY IS NOT COVERAGE. `"packages/lib"` matches the
# directory path and watches none of its source, so a directory-path test would
# read it as covered. This is why the gate probes a source FILE.
new_tree
mutate deploy/svc/railway.json 's#"packages/lib/\*\*"#"packages/lib"#'
expect "a bare directory watchPattern is not coverage for its source" 1 \
  "'packages/lib' is bundled into the svc image but no watchPattern covers its source"

# 5. THE TRANSITIVE, PEER-DEPENDENCY MEMBER. `@t/peer` is reached only through
# `@t/lib`'s peerDependencies with a RANGE — the shape a `workspace:*` grep
# misses entirely, and the one that would have let `packages/plugin-sdk` through.
new_tree
mutate deploy/svc/railway.json '/"packages\/peer\/\*\*",/d'
expect "a transitive peerDependency member is in the closure" 1 \
  "'packages/peer' is bundled into the svc image"

# 6. …and it really is TRANSITIVE: dropping the direct dependency's entry is
# caught too, so case 5 is not passing because the closure stopped at depth 1.
new_tree
mutate deploy/svc/railway.json '/"packages\/app\/\*\*",/d'
expect "the closure's own root is checked, not just its descendants" 1 \
  "'packages/app' is bundled into the svc image"

# 7. AN UNRELATED WORKSPACE IS NOT REQUIRED. `@t/orphan` is a workspace package
# that nothing bundles, so demanding it be watched would be a false positive —
# and a gate that cries wolf gets its errors added to watchPatterns wholesale.
new_tree
MUTATED=1
out7=$(RAILWAY_WATCH_ROOT="$TREE" bash "$GATE" 2>&1) || true
if printf '%s' "$out7" | grep -qF "packages/orphan"; then
  fail "an unbundled workspace package was demanded — false positive"
  printf '%s\n' "$out7" | sed 's/^/       | /' >&2
else
  pass "an unbundled workspace package is NOT demanded"
fi

# 8. A COPIED FILE IS COVERED ON ITS OWN TERMS, NOT BY ITS WHOLE PACKAGE.
#
# ⚠️ THE CASE THAT DISCRIMINATES THIS GATE FROM THE SIMPLER RULE IT REJECTED.
# `packages/data/data/seed.sql` is a single file; the narrow
# `packages/data/data/**` pattern is CORRECT, and a nearest-package rule applied
# to file paths reports `packages/data` as a gap that does not exist. Measured on
# the real tree: that rule flags `packages/cli`, whose `packages/cli/data/**`
# entry is right.
new_tree
MUTATED=1
out8=$(RAILWAY_WATCH_ROOT="$TREE" bash "$GATE" 2>&1) || true
if printf '%s' "$out8" | grep -qF "'packages/data' is bundled"; then
  fail "a package contributing only a data FILE was demanded whole — false positive"
  printf '%s\n' "$out8" | sed 's/^/       | /' >&2
else
  pass "a package contributing only a data file is not demanded whole"
fi

# 9. …but that file still has to be watched. Otherwise case 8 would be satisfied
# by a gate that ignores file paths altogether.
new_tree
mutate deploy/svc/railway.json 's#"packages/data/data/\*\*"#"packages/data/other/**"#'
expect "a copied data FILE must still be covered" 1 \
  "'packages/data/data/seed.sql' is bundled into the svc image"

# 10. THE TRIGGER IS THE BROAD COPY. Without `COPY . .` the image's inputs really
# are the COPY sources, the old arm is complete, and this arm must stand down
# rather than invent requirements.
new_tree
mutate deploy/svc/Dockerfile '/^COPY \. \.$/d'
expect "no broad \`COPY . .\` means the closure arm does not apply" 0 \
  "the workspace-closure arm does not apply"

# 11. A GATE THAT CANNOT LOOK MUST SAY SO — WITH A NON-ZERO EXIT.
#
# ⚠️ The first cut made this a `::warning::` on an exit-0 run, and that is a clean
# line to every consumer that matters: `ci.yml`'s step status, `ci-local.sh`'s PASS
# row, `gh pr checks`. This repo has already paid for the distinction, in a file
# this same change touches — `lighthouse.yml` records that "#4899 survived three
# months precisely because a polite annotation under a green check goes unread."
new_tree
mutate deploy/svc/Dockerfile '/^COPY --from=builder/d'
expect "a broad-COPY service with no readable runner copies EXITS 2" 2 \
  "CANNOT RUN for this service"

# 11b. …and the verdict names the GATE as the thing to fix, not watchPatterns.
# Counting a cannot-look as a coverage gap sent an operator to edit a config that
# was fine — the misdirecting-diagnostic class `BaselineProblem.kind` was split to
# prevent.
new_tree
mutate deploy/svc/Dockerfile '/^COPY --from=builder/d'
expect "…and points at the gate, not at watchPatterns" 2 \
  "NOT watchPatterns"

# 12. A root package.json with no workspaces is a CANNOT-LOOK (exit 2), not a
# coverage gap (exit 1) and certainly not an empty pass.
new_tree
mutate package.json 's#"workspaces": \["packages/\*"\]#"workspaces": []#'
expect "a root package.json declaring no workspaces exits 2" 2 \
  "could not compute the workspace closure"

# 13. NIXPACKS services are still skipped — the arm must not change that.
#
# ⚠️ Needs a SECOND, DOCKERFILE service in the tree, or the new zero-services
# floor fires instead and this case measures that rather than the skip. That
# collision is itself the finding: an all-NIXPACKS root must exit 2 (case 13c),
# while a NIXPACKS service ALONGSIDE a checked one is a legitimate skip. The two
# outcomes are different and both need pinning.
new_tree
mkdir -p "$TREE/deploy/other"
sed 's#deploy/svc/#deploy/other/#g' "$TREE/deploy/svc/railway.json" >"$TREE/deploy/other/railway.json"
cp "$TREE/deploy/svc/Dockerfile" "$TREE/deploy/other/Dockerfile"
mutate deploy/svc/railway.json 's#"DOCKERFILE"#"NIXPACKS"#'
expect "a NIXPACKS service is skipped while its DOCKERFILE sibling is still checked" 0 \
  "builder=NIXPACKS — SKIPPED"

# 13a. ⚠️ THE COPY-SOURCE ARM'S VACUITY FLOOR MUST *SUPPRESS* ITS CLEAN LINE, NOT
# JUST COUNT THE VACUITY.
#
# Indenting the COPY lines defeats the `^COPY` anchor, so `extract_sources` reads
# nothing. The first cut of this floor detected that and incremented
# `CANNOT_LOOK` — and then fell through to print `All 0 COPY sources covered`, the
# exact string its own comment quotes as the defect. Counting a vacuity is not
# suppressing the negative it produces, and every OTHER floor in that loop
# `continue`s, which is what stops them doing the same.
#
# So this case asserts BOTH halves: the non-zero exit, and the ABSENCE of the
# clean sentence. Either alone passes the broken version.
new_tree
mutate deploy/svc/Dockerfile 's#^COPY package.json ./#  COPY package.json ./#'
if [ "$MUTATED" -ne 1 ]; then
  fail "FIXTURE SETUP FAILED: could not indent the COPY line, so NOTHING was tested"
else
  rc_vac=0
  out_vac=$(RAILWAY_WATCH_ROOT="$TREE" bash "$GATE" 2>&1) || rc_vac=$?
  if [ "$rc_vac" = "2" ] \
     && printf '%s' "$out_vac" | grep -qF "verified NOTHING for this service" \
     && ! printf '%s' "$out_vac" | grep -qF "All 0 COPY sources covered"; then
    pass "an unreadable COPY set exits 2 AND never prints 'All 0 COPY sources covered' (exit $rc_vac)"
  else
    fail "COPY-source vacuity — expected exit 2, the CANNOT-LOOK error, and NO 'All 0 …' line; got $rc_vac"
    printf '%s\n' "$out_vac" | sed 's/^/       | /' >&2
  fi
fi

# 13a2. ⚠️ AND THE CLOSURE ARM'S CLEAN LINE MUST NAME WHAT IT ACTUALLY COVERED.
#
# A broad-COPY service whose image paths resolve to NO workspace package gets no
# closure computed at all — and the line still said "bundled workspace/image
# path(s)" over a set containing none. An honest count with a misleading scope,
# which is the same defect as a vacuous count one degree weaker.
NOPKG_TREE="$TMPROOT/no-package-roots"
mkdir -p "$NOPKG_TREE/deploy/svc" "$NOPKG_TREE/semantic"
cat >"$NOPKG_TREE/package.json" <<'JSON'
{ "name": "root", "private": true, "workspaces": ["packages/*"] }
JSON
mkdir -p "$NOPKG_TREE/packages/only"
cat >"$NOPKG_TREE/packages/only/package.json" <<'JSON'
{ "name": "@t/only" }
JSON
cat >"$NOPKG_TREE/deploy/svc/Dockerfile" <<'DOCKER'
FROM base AS builder
COPY package.json ./
COPY . .
FROM base AS runner
COPY --from=builder /app/semantic ./semantic
DOCKER
cat >"$NOPKG_TREE/deploy/svc/railway.json" <<'JSON'
{
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "deploy/svc/Dockerfile",
    "dockerfileContext": "../..",
    "watchPatterns": ["package.json", "semantic/**", "deploy/svc/**"]
  }
}
JSON
rc_nopkg=0
out_nopkg=$(RAILWAY_WATCH_ROOT="$NOPKG_TREE" bash "$GATE" 2>&1) || rc_nopkg=$?
if printf '%s' "$out_nopkg" | grep -qF "NO workspace closure was computed" \
   && ! printf '%s' "$out_nopkg" | grep -qF "bundled workspace/image path(s) covered"; then
  pass "a service with no workspace-package image paths says NO closure was computed"
else
  fail "no-package-roots — expected the scope-qualified line and NOT the 'bundled workspace' one (exit $rc_nopkg)"
  printf '%s\n' "$out_nopkg" | sed 's/^/       | /' >&2
fi

# 13b. ⚠️ THE CRITICAL ONE: A RUN THAT EXAMINED ZERO SERVICES MUST NOT PRINT ITS
# CLEAN NEGATIVE. `nullglob` is unset, so an empty `deploy/*/railway.json` glob
# runs the loop once with the literal pattern, `[ -f ]` fails, `continue` fires,
# and every counter stays 0 — falling straight through to "OK: … covered by their
# watchPatterns", the sentence a reviewer greps for, on a run that read no file.
# The `RAILWAY_WATCH_ROOT` seam this change introduces is what makes a wrong root
# reachable; before it, `ROOT` was computed and could not be wrong.
EMPTY_TREE="$TMPROOT/empty-root"
mkdir -p "$EMPTY_TREE"
rc_empty=0
out_empty=$(RAILWAY_WATCH_ROOT="$EMPTY_TREE" bash "$GATE" 2>&1) || rc_empty=$?
if [ "$rc_empty" = "2" ] && printf '%s' "$out_empty" | grep -qF "this gate verified NOTHING"; then
  pass "a root with NO deploy services exits 2 rather than printing its clean negative (exit $rc_empty)"
else
  fail "empty root — expected exit 2 saying it verified nothing, got $rc_empty"
  printf '%s\n' "$out_empty" | sed 's/^/       | /' >&2
fi

# 13c. …and the same for a root where every service is on a non-DOCKERFILE
# builder, which reaches the identical end state by a different door.
NIX_TREE="$TMPROOT/nixpacks-only"
mkdir -p "$NIX_TREE/deploy/only"
cat >"$NIX_TREE/deploy/only/railway.json" <<'JSON'
{ "build": { "builder": "NIXPACKS", "watchPatterns": ["apps/only/**"] } }
JSON
rc_nix=0
out_nix=$(RAILWAY_WATCH_ROOT="$NIX_TREE" bash "$GATE" 2>&1) || rc_nix=$?
if [ "$rc_nix" = "2" ] && printf '%s' "$out_nix" | grep -qF "this gate verified NOTHING"; then
  pass "a root where every service is NIXPACKS exits 2, not a clean sweep (exit $rc_nix)"
else
  fail "nixpacks-only root — expected exit 2, got $rc_nix"
  printf '%s\n' "$out_nix" | sed 's/^/       | /' >&2
fi

# 13d. THE BROAD-COPY SPELLINGS MUST AGREE BETWEEN THE TWO ARMS. `extract_sources`
# skips a source token of `.` OR `./`; `has_broad_copy` recognised only the bare
# `COPY . .`. So `COPY ./ ./` was skipped by the COPY-source arm AND reported
# "no broad COPY . . — the workspace-closure arm does not apply" — both arms
# standing down while the broad copy bundled every package, with a STATED NEGATIVE
# telling the reader not to look.
for spelling in 'COPY .\/ .\/' 'COPY . .\/' 'COPY --link . .'; do
  new_tree
  mutate deploy/svc/Dockerfile "s#^COPY \. \.\$#${spelling}#"
  expect "the closure arm still applies to \`$(printf '%s' "$spelling" | sed 's#\\##g')\`" 0 \
    "All 4 bundled workspace/image path(s) covered"
done

# 13e. THE IMAGE-CONTENT EXTRACTOR HAS A COMPLETENESS FLOOR. It pins one spelling;
# a reordered `--chown` before `--from`, a BuildKit `--link`, or a digest-pinned
# stage name drops a line SILENTLY, taking a package and its whole transitive
# closure out of `required` while the gate prints `All N … covered`. MEASURED on
# the real Dockerfiles: the first pattern missed
# `COPY --from=node:24-trixie-slim@sha256:… /usr/local/bin/node`.
new_tree
mutate deploy/svc/Dockerfile 's#^COPY --from=builder /app/packages/app ./packages/app$#COPY --chown=x:y --from=builder /app/packages/app ./packages/app#'
expect "a reordered --chown/--from is still READ, not dropped" 0 \
  "All 4 bundled workspace/image path(s) covered"

# 13f. ⚠️ THE COMPLETENESS FLOOR FIRES WHEN THE EXTRACTOR UNDER-READS — and the
# only way to test that is to BREAK THE EXTRACTOR, because the floor's whole job
# is to catch a line shape the extractor cannot read, which by definition is one
# nobody has thought of. So this case narrows the extractor in the fixture's OWN
# COPY of the gate (never the tracked one) and requires the floor to notice.
#
# Measured without the floor: the reordered-`--chown` case below simply lost a
# package, its whole transitive closure went unchecked, and the gate printed
# `All N … covered`. Both premises are verified, because a silently-missed `sed`
# would make this fixture pass for the wrong reason.
# ⚠️ The patch goes through `bun`, not `sed`: the string being replaced IS a
# regex full of `[`, `]`, `*`, `+` and `?`, and hand-escaping it for BRE is how a
# fixture ends up silently matching nothing. A literal `replace` cannot misfire,
# and it reports whether it landed.
new_tree
GATE_COPY="$TREE/gate-narrowed.sh"
cp "$GATE" "$GATE_COPY"
PATCHER="$TREE/narrow.ts"
cat >"$PATCHER" <<'TS'
// Narrow the extractor to "only ever read packages/app", so every other /app/
// token in the fixture Dockerfile goes unread while the counter still sees them
// all. A literal replace, so it cannot silently match a different thing.
const p = Bun.env.GATE_COPY!;
const src = await Bun.file(p).text();
const FROM = "grep -oE '/app/[^[:space:]]+'";
const TO = "grep -oE '/app/packages/app'";
if (!src.includes(FROM)) {
  process.stderr.write(`the extractor's token grep is not where this fixture expects it\n`);
  process.exit(1);
}
await Bun.write(p, src.replace(FROM, TO));
TS
if GATE_COPY="$GATE_COPY" bun "$PATCHER" 2>/dev/null; then
  rc_floor=0
  out_floor=$(RAILWAY_WATCH_ROOT="$TREE" bash "$GATE_COPY" 2>&1) || rc_floor=$?
  if [ "$rc_floor" = "2" ] && printf '%s' "$out_floor" | grep -qF "source token(s) from the runner copies"; then
    pass "an under-reading extractor is caught by the completeness floor (exit $rc_floor)"
  else
    fail "narrowed extractor — expected exit 2 naming the token shortfall, got $rc_floor"
    printf '%s\n' "$out_floor" | sed 's/^/       | /' >&2
  fi
else
  fail "FIXTURE PREMISE BROKEN: could not narrow the extractor in the gate copy, so NOTHING was tested"
fi

# 13g. ⚠️ DUPLICATE CLOSURE ROOTS MUST NOT TRIP THE VACUITY FLOOR. `closure_roots`
# accumulates one line per image path; the closure returns a SET. Four image paths
# under ONE package give root_count 4 against a 1-element closure, so without the
# dedup a perfectly healthy tree reports "the traversal is broken".
#
# This is LIVE-ADJACENT rather than hypothetical: `web`'s three image paths
# (`.next/standalone`, `.next/static`, `public`) all resolve to `packages/web`, so
# it already runs at root_count 3 against a 5-element closure and passes only
# because 5 > 3. One more Dockerfile line and it inverts.
DUP_TREE="$TMPROOT/dup-roots"
mkdir -p "$DUP_TREE/deploy/svc" "$DUP_TREE/packages/solo/a" "$DUP_TREE/packages/solo/b" \
         "$DUP_TREE/packages/solo/c" "$DUP_TREE/packages/solo/d"
cat >"$DUP_TREE/package.json" <<'JSON'
{ "name": "root", "private": true, "workspaces": ["packages/*"] }
JSON
cat >"$DUP_TREE/packages/solo/package.json" <<'JSON'
{ "name": "@t/solo" }
JSON
cat >"$DUP_TREE/deploy/svc/Dockerfile" <<'DOCKER'
FROM base AS builder
COPY package.json ./
COPY . .
FROM base AS runner
COPY --from=builder /app/packages/solo/a ./a
COPY --from=builder /app/packages/solo/b ./b
COPY --from=builder /app/packages/solo/c ./c
COPY --from=builder /app/packages/solo/d ./d
DOCKER
cat >"$DUP_TREE/deploy/svc/railway.json" <<'JSON'
{
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "deploy/svc/Dockerfile",
    "dockerfileContext": "../..",
    "watchPatterns": ["package.json", "packages/solo/**", "deploy/svc/**"]
  }
}
JSON
rc_dup=0
out_dup=$(RAILWAY_WATCH_ROOT="$DUP_TREE" bash "$GATE" 2>&1) || rc_dup=$?
if [ "$rc_dup" = "0" ] && ! printf '%s' "$out_dup" | grep -qF "the traversal is broken"; then
  pass "four image paths under ONE package do not trip the vacuity floor (exit $rc_dup)"
else
  fail "duplicate closure roots — expected exit 0 with no traversal complaint, got $rc_dup"
  printf '%s\n' "$out_dup" | sed 's/^/       | /' >&2
fi

# 14. THE REAL REPO IS THE FLOOR. Every case above runs against a synthetic tree,
# so nothing so far proves the gate agrees with the tree we actually ship.
rc14=0
out14=$(bash "$GATE" 2>&1) || rc14=$?
if [ "$rc14" = "0" ]; then
  pass "the real repo passes the extended gate"
else
  fail "the real repo FAILS the extended gate (exit $rc14)"
  printf '%s\n' "$out14" | sed 's/^/       | /' >&2
fi

# 15. …and the real repo's api regions are the ones #4738 is about, so assert the
# two entries this change added are present in every one of them. A gate passing
# because someone deleted the closure arm would still pass case 14.
missing_entries=""
for svc in api api-eu api-apac; do
  for entry in "packages/okf-bundle/**" "packages/sdk/**"; do
    grep -qF -- "\"$entry\"" "$ROOT/deploy/$svc/railway.json" || missing_entries="$missing_entries $svc:$entry"
  done
done
if [ -z "$missing_entries" ]; then
  pass "every api region watches packages/okf-bundle/** and packages/sdk/**"
else
  fail "missing watchPatterns entries:$missing_entries"
fi

# 16. Nothing here may write tracked source (#5172).
GIT_AFTER="$(git -C "$ROOT" status --porcelain 2>/dev/null || echo "<git unavailable>")"
if [ "$GIT_BEFORE" = "$GIT_AFTER" ]; then
  pass "the working tree is unchanged — every case ran in mktemp"
else
  fail "the working tree CHANGED during this suite"
  diff <(printf '%s\n' "$GIT_BEFORE") <(printf '%s\n' "$GIT_AFTER") | sed 's/^/       | /' >&2
fi

# ⚠️ AN ABSOLUTE LITERAL. A count derived from the cases cannot notice a deleted
# case — measured on `check-docs-brain-snippets.test.sh`, which reported
# `40 passed, 0 failed` with cases removed.
EXPECTED_CASES=27
TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -eq "$EXPECTED_CASES" ]; then
  pass "all $EXPECTED_CASES cases ran"
else
  fail "expected $EXPECTED_CASES cases, $TOTAL ran — a case was added or deleted without updating EXPECTED_CASES"
fi

echo ""
echo "check-railway-watch.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
