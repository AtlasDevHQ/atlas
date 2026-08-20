#!/bin/bash
# Adversarial fixture suite for the image-scan gate.
#
# Locks in the properties that fail silently on their own.
#
# ── The scanner itself (#4822) ────────────────────────────────────────────────
#
#   1. It FAILS on a deliberately vulnerable image. This is the acceptance
#      criterion from #4822 — "prove the negative; a green run against a
#      currently-clean tree proves nothing."
#   2. It PASSES on an image with no packages. Without this, a gate that is
#      merely broken and unconditionally red would satisfy (1).
#   3. The .trivyignore baseline suppresses the GATE but not the SARIF report,
#      so an exemption stays a documented deferral rather than becoming
#      invisible.
#   4. A vulnerable LIBRARY is reported but does not block, pinning the
#      OS-only gate scope documented in scan-image.sh.
#
# ── What decides WHETHER the gate applies (#5361) ─────────────────────────────
#
#   5. A base reference the PR did NOT touch is report-only — even when the
#      image is genuinely vulnerable. That is the whole point of #5361, and it
#      is also the property most likely to be destroyed by accident, because
#      breaking it makes the gate stricter and therefore looks safe.
#   6. A base reference the PR BUMPED, or one it introduced with a new
#      Dockerfile, gates absolutely. Without these two the change is
#      indistinguishable from deleting the tier.
#   7. Every runtime stage in the tree upgrades its OS packages. (5) is only
#      sound because of this, and a runtime stage that skips the upgrade is
#      invisible to BOTH scan tiers — unchanged base ref, and not one of the
#      three images in the built-images matrix.
#   8. The three built-image Dockerfiles still end in the stage image-scan.yml
#      names in `no-cache-filters`. That flag is the only thing stopping the
#      runner stage's upgrade from restoring out of the gha cache, which made
#      the gate of record scan an artifact nobody ships — measured, not
#      hypothetical (#5361).
#
# Expressed as tests rather than one-off manual checks so they keep holding
# after a Trivy upgrade or a policy-flag edit — every one of these properties
# can be destroyed by a single flag change that nothing else would catch.
#
# Also covers scripts/list-runtime-base-images.sh, which decides *what* gets
# scanned: a discovery bug there is silent, and looks exactly like coverage.
#
# Requires: docker, trivy for the scan half. The discovery, ref-diff and
# runtime-stage-upgrade halves need neither and always run. Runs in
# .github/workflows/image-scan.yml; skips the rest with a clear message when run
# locally without them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/scan-image.sh"
DISCOVER="$SCRIPT_DIR/list-runtime-base-images.sh"
GATE="$SCRIPT_DIR/base-image-gate.sh"
UPGRADES="$SCRIPT_DIR/check-runtime-stage-upgrades.sh"
FIXTURES="$ROOT/.github/fixtures/image-scan"

for f in "$SCAN" "$DISCOVER" "$GATE" "$UPGRADES"; do
  if [ ! -f "$f" ]; then
    echo "::error::script under test not found at $f" >&2
    exit 2
  fi
done

PASS=0
FAIL=0

ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# ── Discovery fixtures (no docker/trivy needed) ──────────────────────────────
echo "list-runtime-base-images adversarial fixtures:"

# (1) Build-only stages must NOT reach the scan matrix. A Dockerfile that
#     compiles something in a throwaway stage and copies the artifact out ships
#     none of that stage's packages; gating on them is unactionable red.
tmp="$(mktemp -d)"
mkdir -p "$tmp/svc"
cat > "$tmp/svc/Dockerfile" <<'EOF'
FROM alpine:3.21 AS base
FROM debian:trixie-slim AS toolchain
RUN echo build-only
FROM base AS runner
COPY --from=toolchain /bin/true /bin/true
EOF
out="$(BASE_IMAGE_ROOT="$tmp" bash "$DISCOVER")"
if [ "$out" = "alpine:3.21" ]; then
  ok "resolves aliased runtime stage and drops the build-only stage"
else
  bad "runtime-stage resolution — expected 'alpine:3.21', got: $(echo "$out" | tr '\n' ' ')"
fi

# (2) An unresolvable reference must fail loudly. Silently dropping it would
#     leave a hole in the matrix that is indistinguishable from coverage.
cat > "$tmp/svc/Dockerfile" <<'EOF'
ARG BASE=alpine:3.21
FROM ${BASE} AS runner
EOF
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$DISCOVER" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "build-arg-interpolated base image fails closed"
else
  bad "build-arg interpolation — expected exit 1, got exit $rc"
fi

# (3) The real tree must resolve to a non-empty set. Guards against a find/prune
#     edit that quietly matches nothing.
if [ -n "$(bash "$DISCOVER")" ]; then
  ok "real tree resolves at least one runtime base image"
else
  bad "real tree resolved an empty image set"
fi
rm -rf "$tmp"

# ── Base-image gate: ref-diff fixtures (#5361, no docker/trivy needed) ───────
#
# These decide WHETHER the gate applies to a given base image, which since
# #5361 is the whole of the base tier's policy. They are adversarial in the
# direction that matters: each one breaks the tree first, runs the real
# decision code, and reads the answer. A green run against the repo as it
# stands proves nothing about any of them.
echo "base-image-gate ref-diff adversarial fixtures:"

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq not found — base-image-gate.sh cannot build a matrix without it, so these fixtures cannot run" >&2
  exit 2
fi

# Two throwaway trees standing in for merge-base and head. Nothing is scanned
# here; the question is only which refs the gate would mark `gated`.
mb="$(mktemp -d)"; hd="$(mktemp -d)"
mkdir -p "$mb/svc" "$hd/svc"

gated_of() { # <matrix-json> <ref>
  printf '%s' "$1" | jq -r --arg r "$2" '.[] | select(.ref == $r) | .gated'
}

# (4) THE ONE #5361 IS ABOUT. A base ref that did not move is report-only, even
#     though the image is genuinely vulnerable. Breaking this makes the gate
#     STRICTER, which is why nothing else would catch it: a stricter security
#     gate reads as a safe change right up until it blocks a docs-only PR on a
#     CVE no Atlas artifact has ever carried (#5359).
printf 'FROM alpine:3.10 AS runner\n' > "$mb/svc/Dockerfile"
printf 'FROM alpine:3.10 AS runner\nRUN echo unrelated-change\n' > "$hd/svc/Dockerfile"
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode diff --base-tree "$mb" 2>/dev/null)"
if [ "$(gated_of "$m" alpine:3.10)" = "false" ]; then
  ok "unchanged base ref is report-only, not gated"
else
  bad "unchanged ref — expected gated=false, got: $m"
fi

# (5) A PIN BUMP to a worse image goes red. The fixture is the bump itself: the
#     merge-base tree pins a maintained Alpine, the head tree pins the
#     end-of-life 3.10 that Dockerfile.vulnerable uses precisely because its
#     fixable HIGH/CRITICAL findings are frozen history.
printf 'FROM alpine:3.21 AS runner\n' > "$mb/svc/Dockerfile"
printf 'FROM alpine:3.10 AS runner\n' > "$hd/svc/Dockerfile"
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode diff --base-tree "$mb" 2>/dev/null)"
if [ "$(gated_of "$m" alpine:3.10)" = "true" ]; then
  ok "bumped base pin is gated"
else
  bad "pin bump — expected gated=true for alpine:3.10, got: $m"
fi

# (6) A NEW DOCKERFILE ON A NEW BASE goes red, and the base it did not touch
#     stays report-only in the same run. Both halves matter: the first is the
#     case with no merge-base finding set to diff against (every finding is
#     "new"), and the second is what stops the answer from being "gate
#     everything whenever any Dockerfile moved".
#
#     This also pins DISCOVERY. The new Dockerfile's base is enumerated
#     nowhere; it reaches the matrix only because discovery walks the tree.
printf 'FROM alpine:3.21 AS runner\n' > "$mb/svc/Dockerfile"
printf 'FROM alpine:3.21 AS runner\n' > "$hd/svc/Dockerfile"
mkdir -p "$hd/newsvc"
printf 'FROM alpine:3.10 AS runner\n' > "$hd/newsvc/Dockerfile"
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode diff --base-tree "$mb" 2>/dev/null)"
if [ "$(gated_of "$m" alpine:3.10)" = "true" ] && [ "$(gated_of "$m" alpine:3.21)" = "false" ]; then
  ok "new Dockerfile on an unenumerated base is discovered AND gated; the untouched base is not"
else
  bad "new-Dockerfile case — expected alpine:3.10 gated and alpine:3.21 not, got: $m"
fi

# (7) The two non-diff modes do what they say. `report-only` is every
#     non-pull_request trigger, where the built-image tier is the gate;
#     `gate-all` is the fail-safe. Asserted together because the failure that
#     matters is them being swapped, and either one alone would still pass.
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode report-only 2>/dev/null)"
n_gated="$(printf '%s' "$m" | jq '[.[] | select(.gated)] | length')"
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode gate-all 2>/dev/null)"
n_ungated="$(printf '%s' "$m" | jq '[.[] | select(.gated | not)] | length')"
if [ "$n_gated" = "0" ] && [ "$n_ungated" = "0" ]; then
  ok "report-only gates nothing and gate-all gates everything"
else
  bad "modes — report-only left $n_gated gated, gate-all left $n_ungated ungated"
fi

# (8) FAIL-SAFE DIRECTION. When the merge-base tree cannot be read, "we do not
#     know what was there" must resolve to "all of it is new", never to
#     "nothing changed" — otherwise a checkout failure silently ungates the PR.
m="$(BASE_IMAGE_ROOT="$hd" bash "$GATE" matrix --mode diff --base-tree "$mb/does-not-exist" 2>/dev/null)"
n_ungated="$(printf '%s' "$m" | jq '[.[] | select(.gated | not)] | length')"
if [ -n "$m" ] && [ "$n_ungated" = "0" ]; then
  ok "unreadable merge-base tree fails safe to gating every ref"
else
  bad "fail-safe — expected every ref gated, got: $m"
fi
rm -rf "$mb" "$hd"

# ── The premise the report-only mode rests on (#5361 D5) ─────────────────────
#
# "An unchanged base ref is report-only" is only sound while every runtime
# stage upgrades its OS packages. A runtime stage that skips the upgrade is
# invisible to BOTH tiers — its base ref did not change, so the base tier does
# not gate it, and only three of the eight Dockerfiles are in the built-images
# matrix — so this guard is the only thing that can see it.
echo "check-runtime-stage-upgrades adversarial fixtures:"

tmp="$(mktemp -d)"; mkdir -p "$tmp/svc"

# (9) THE GUARD MUST GO RED on a runtime stage with no upgrade. This is the
#     fixture the whole #5361 design depends on: ship everything else without
#     it and the repo is less safe than before the change.
cat > "$tmp/svc/Dockerfile" <<'EOF'
FROM oven/bun:1.3.13 AS base
FROM base AS runner
COPY . /app
EOF
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "runtime stage with no apt-get upgrade / apk upgrade fails the guard"
else
  bad "no-upgrade fixture — expected exit 1, got exit $rc (the guard cannot go red)"
fi

# (10) …and GREEN once the upgrade is added, to the SAME tree. Without this,
#      a guard that was merely broken and unconditionally red would satisfy (9).
cat > "$tmp/svc/Dockerfile" <<'EOF'
FROM oven/bun:1.3.13 AS base
FROM base AS runner
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
COPY . /app
EOF
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "adding the upgrade to that same stage turns the guard green"
else
  bad "upgrade fixture — expected exit 0, got exit $rc (guard is unconditionally red)"
fi

# (11) An upgrade in a stage the runtime stage does NOT inherit from must not
#      count. deploy/api builds nsjail in a throwaway debian stage and copies a
#      binary out; upgrading there patches nothing that ships. Matching the
#      whole file for the string would pass this and mean nothing.
cat > "$tmp/svc/Dockerfile" <<'EOF'
FROM oven/bun:1.3.13 AS base
FROM debian:trixie-slim AS toolchain
RUN apt-get update && apt-get upgrade -y
FROM base AS runner
COPY --from=toolchain /bin/true /bin/true
EOF
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "upgrade in a non-ancestor build stage does not satisfy the guard"
else
  bad "build-stage upgrade — expected exit 1, got exit $rc (guard credits a stage that never ships)"
fi

# (12) An upgrade in a COMMENT runs nothing. A guard that reads its own
#      documentation as evidence is the exact defect check-gate-fixtures-wired.sh
#      was written to close, one surface over.
cat > "$tmp/svc/Dockerfile" <<'EOF'
FROM alpine:3.21 AS runner
# RUN apk upgrade --no-cache
EOF
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "a commented-out upgrade does not satisfy the guard"
else
  bad "comment fixture — expected exit 1, got exit $rc (prose is being read as an upgrade)"
fi

# (13) VACUITY FLOOR. A guard whose product is the negative "every runtime stage
#      upgrades" must refuse to emit it after finding nothing to check.
rm -f "$tmp/svc/Dockerfile"
rc=0
BASE_IMAGE_ROOT="$tmp" bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then
  ok "empty tree is a hard error, not a clean run"
else
  bad "vacuity floor — expected exit 2 on a tree with no Dockerfiles, got exit $rc"
fi
rm -rf "$tmp"

# (14) The --assert-runtime-stage mode, both directions. image-scan.yml passes
#      the matched name to `no-cache-filters`, which is the ONLY thing forcing
#      the runner stage's apt-get upgrade to re-run instead of restoring from
#      the gha cache. A rename that silently matches no stage puts the
#      built-image tier — the gate of record since #5361 — back to scanning an
#      artifact nobody ships, and reporting it green.
tmp="$(mktemp -d)"
cat > "$tmp/Dockerfile" <<'EOF'
FROM alpine:3.21 AS base
FROM base AS runner
RUN apk upgrade --no-cache
EOF
rc=0
bash "$UPGRADES" --assert-runtime-stage "$tmp/Dockerfile" runner >/dev/null 2>&1 || rc=$?
rc2=0
bash "$UPGRADES" --assert-runtime-stage "$tmp/Dockerfile" builder >/dev/null 2>&1 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ]; then
  ok "--assert-runtime-stage accepts the real final stage and rejects a wrong name"
else
  bad "runtime-stage assertion — expected exit 0 for 'runner' and 1 for 'builder', got $rc and $rc2"
fi

# (15) …and the three built-image Dockerfiles really are named what
#      image-scan.yml's matrix passes. This is the live coupling, not a
#      hypothetical one: get it wrong and nothing in the build fails.
rc=0
for df in "$ROOT/deploy/api/Dockerfile" "$ROOT/deploy/web/Dockerfile" "$ROOT/deploy/docs/Dockerfile"; do
  bash "$UPGRADES" --assert-runtime-stage "$df" runner >/dev/null 2>&1 || rc=1
done
if [ "$rc" -eq 0 ]; then
  ok "all three built-image Dockerfiles end in a stage named 'runner'"
else
  bad "built-image final stages — one of deploy/{api,web,docs} is no longer 'runner'"
fi
rm -rf "$tmp"

# (16) The REAL tree passes. This is the measured premise itself, not a
#      property of the guard: every runtime stage Atlas ships upgrades its OS
#      packages, which is why an unchanged base ref does not need to block.
rc=0
bash "$UPGRADES" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "every runtime stage in the real tree upgrades its OS packages"
else
  bad "real tree — expected exit 0, got exit $rc (the #5361 premise is false right now)"
fi

# ── Scan-gate fixtures (need docker + trivy) ─────────────────────────────────
echo "scan-image adversarial fixtures:"

if ! command -v docker >/dev/null 2>&1 || ! command -v trivy >/dev/null 2>&1; then
  echo "  ⊘ skipped — docker and/or trivy not available locally (these run in CI)"
  echo "  $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

SARIF_DIR="$(mktemp -d)"
trap 'rm -rf "$SARIF_DIR"; docker rmi -f atlas-scan-fixture:vulnerable atlas-scan-fixture:clean atlas-scan-fixture:library >/dev/null 2>&1 || true' EXIT

# (17) The gate must go RED on a deliberately vulnerable image.
#
#     Deliberately run with the REAL .trivyignore (no TRIVY_BASELINE override),
#     because that is the shipped configuration. Proving the gate red against an
#     empty baseline would leave open the possibility that the checked-in
#     baseline swallows a genuinely new vulnerable image.
docker build -q -f "$FIXTURES/Dockerfile.vulnerable" -t atlas-scan-fixture:vulnerable "$FIXTURES" >/dev/null
rc=0
bash "$SCAN" atlas-scan-fixture:vulnerable fixture-vulnerable "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "deliberately vulnerable image fails the gate (against the shipped baseline)"
else
  bad "vulnerable fixture — expected exit 1, got exit $rc (gate cannot go red)"
fi

# (18) Findings must reach SARIF even on a failing scan — a gate that fails and
#     then discards its evidence is not triageable.
if [ -s "$SARIF_DIR/fixture-vulnerable.sarif" ]; then
  ok "failing scan still emits a non-empty SARIF report"
else
  bad "failing scan produced no SARIF at $SARIF_DIR/fixture-vulnerable.sarif"
fi

# (19) The baseline must suppress the GATE and nothing else. This is the whole
#     premise of the two-pass split in scan-image.sh: if a baselined CVE also
#     disappeared from SARIF, the exemption would be an invisibility cloak
#     rather than a documented, dated deferral.
#
#     Built hermetically: take the fixture's own findings, baseline exactly
#     those, and assert the gate goes green while the SARIF still names them.
#
#     ⚠️ The enumeration below passes --ignore-unfixed, which is load-bearing
#     now that the report pass carries the same flag (2026-08-12). It keeps the
#     probe CVE inside the set the report pass can still emit, so a green
#     assertion here means "the BASELINE did not leak" and not "the CVE happened
#     to be fixable". Drop that flag and this test starts failing for a reason
#     that has nothing to do with the baseline split it exists to check.
trivy image --scanners vuln --pkg-types os --severity HIGH,CRITICAL --ignore-unfixed \
  --ignorefile /dev/null --quiet --format json atlas-scan-fixture:vulnerable 2>/dev/null \
  | grep -oE '"VulnerabilityID": *"[^"]+"' | sed 's/.*"\([A-Z][A-Z0-9-]*\)"$/\1/' | sort -u \
  > "$SARIF_DIR/fixture.ids"

if [ ! -s "$SARIF_DIR/fixture.ids" ]; then
  bad "could not enumerate fixture findings — cannot test the baseline split"
else
  sed 's/$/ exp:2099-01-01/' "$SARIF_DIR/fixture.ids" > "$SARIF_DIR/fixture.trivyignore"
  probe_cve="$(head -1 "$SARIF_DIR/fixture.ids")"

  rc=0
  TRIVY_BASELINE="$SARIF_DIR/fixture.trivyignore" \
    bash "$SCAN" atlas-scan-fixture:vulnerable fixture-baselined "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "baselined findings do not fail the gate"
  else
    bad "baseline split — expected exit 0 with every finding baselined, got exit $rc"
  fi

  if grep -q "$probe_cve" "$SARIF_DIR/fixture-baselined.sarif" 2>/dev/null; then
    ok "baselined findings still appear in SARIF ($probe_cve) — baseline not applied to the report pass"
  else
    bad "baseline leaked into the report pass — $probe_cve is missing from SARIF"
  fi
fi

# (20) A vulnerable LIBRARY must be REPORTED but must NOT block.
#
#     This pins the scope decision in scan-image.sh: OS packages gate, library
#     findings go to code scanning and are remediated by hand (#4878 — bun has
#     no Dependabot security updates, so nothing opens that PR). Without this,
#     dropping --pkg-types os from the gate would pass every other test here
#     and only surface later as unrelated PRs going red on transitive bumps.
docker build -q -f "$FIXTURES/Dockerfile.library" -t atlas-scan-fixture:library "$FIXTURES" >/dev/null
rc=0
bash "$SCAN" atlas-scan-fixture:library fixture-library "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "vulnerable library does not block the gate (OS-only scope)"
else
  bad "library fixture — expected exit 0, got exit $rc (gate is blocking on libraries)"
fi

if grep -q "GHSA-p6mc-m468-83gg\|CVE-2020-8203" "$SARIF_DIR/fixture-library.sarif" 2>/dev/null; then
  ok "vulnerable library still reported in SARIF"
else
  bad "library finding missing from SARIF — reported-but-not-gated is the whole point"
fi

# (21) The gate must go GREEN on an image with no packages.
docker build -q -f "$FIXTURES/Dockerfile.clean" -t atlas-scan-fixture:clean "$FIXTURES" >/dev/null
rc=0
bash "$SCAN" atlas-scan-fixture:clean fixture-clean "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "package-free image passes the gate"
else
  bad "clean fixture — expected exit 0, got exit $rc (gate is unconditionally red)"
fi

# (22) The census pass must run and print to the job log.
#
#     This is the compensating control for --ignore-unfixed on the report pass
#     (2026-08-12). That flag stops unfixed CVEs from becoming code-scanning
#     alerts; the census is the ONLY place they remain visible. Delete the
#     census and the flag silently becomes a suppression, which is precisely
#     the "invisibility cloak" failure (19) exists to prevent one surface over.
#
#     ⚠️ Scope of what this can prove, stated because the gap is not obvious:
#     it asserts the census RUNS, not that it surfaces a finding the SARIF
#     omits. Neither shipped fixture can prove the latter — measured
#     2026-08-12, atlas-scan-fixture:vulnerable has 8 findings and ZERO of them
#     unfixed, so "in census but not in SARIF" is an empty set and any such
#     assertion would pass without being able to fail. Writing it anyway would
#     add a test that looks like coverage and is not. If a fixture with a
#     durably-unfixed CVE ever exists, tighten this to the set-difference form.
census_out="$(bash "$SCAN" atlas-scan-fixture:clean fixture-census "$SARIF_DIR" 2>&1)" || true
if printf '%s' "$census_out" | grep -q "census: ALL findings including unfixed"; then
  ok "census pass runs and labels itself in the job log"
else
  bad "census pass missing — unfixed findings now have no visible surface at all"
fi

# (23) END TO END: a gated ref that is genuinely vulnerable goes RED through the
#      real decision path. Fixtures (5) and (6) prove the ref-diff marks a
#      bumped or newly-introduced base `gated`; (17) proves scan-image.sh can
#      exit 1. Neither implies the two are wired together, and the wiring is one
#      argument wide — `base-image-gate.sh scan` could drop the verdict on the
#      floor and every other test here would still pass.
rc=0
bash "$GATE" scan atlas-scan-fixture:vulnerable fixture-gated true "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  ok "gated ref with fixable HIGH/CRITICAL findings blocks (end to end)"
else
  bad "gated end-to-end — expected exit 1, got exit $rc (a bumped pin would merge)"
fi

# (24) …and the SAME image, ungated, does not block. Same scan, same findings,
#      opposite verdict — so a green result here can only come from the gating
#      decision and never from the image happening to be clean. This is #5361's
#      claim in its most falsifiable form.
rc=0
bash "$GATE" scan atlas-scan-fixture:vulnerable fixture-ungated false "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "the identical vulnerable image is report-only when the ref is unchanged"
else
  bad "report-only end-to-end — expected exit 0, got exit $rc (unrelated PRs still blocked)"
fi

# (25) A report-only outcome must not leave an ::error:: annotation behind. A red
#      annotation on a job that then passes is the same unactionable-red failure
#      the gate's whole policy is built to avoid: people stop reading
#      annotations, and then miss the one that meant something. Measured on the
#      first CI run of #5361 — scan-image.sh annotated ::error:: and the job went
#      green anyway.
out="$(bash "$GATE" scan atlas-scan-fixture:vulnerable fixture-annot-off false "$SARIF_DIR" 2>&1 || true)"
if ! printf '%s' "$out" | grep -q '::error::' && printf '%s' "$out" | grep -q '::notice::REPORT-ONLY'; then
  ok "report-only emits a notice and no error annotation"
else
  bad "annotation — report-only run should carry ::notice:: and no ::error::"
fi

# (26) …and both paths that SHOULD annotate still do, so (25) cannot be
#      satisfied by having removed the annotation everywhere. Two of them,
#      because they come from different scripts: the gated verdict is
#      base-image-gate.sh's, and the default TRIVY_ANNOTATE=error is
#      scan-image.sh's — the built-image tier calls that one directly and must
#      not lose its annotation to this change.
gated_out="$(bash "$GATE" scan atlas-scan-fixture:vulnerable fixture-annot-on true "$SARIF_DIR" 2>&1 || true)"
direct_out="$(bash "$SCAN" atlas-scan-fixture:vulnerable fixture-annot-direct "$SARIF_DIR" 2>&1 || true)"
if printf '%s' "$gated_out" | grep -q '::error::BLOCKED:' \
   && printf '%s' "$direct_out" | grep -q '::error::Fixable HIGH/CRITICAL'; then
  ok "gated verdict and a direct scan-image.sh call both still annotate as errors"
else
  bad "annotation — expected ::error:: from both the gated path and a bare scan-image.sh call"
fi

# ⚠️ Not asserted, and the omission is deliberate: that a SCANNER failure (exit
# other than 0 or 1) still fails even when the ref is ungated. Provoking one
# means making Trivy itself break — a bad image ref, a poisoned cache — and
# every cheap way to do that also produces exit 1 on some Trivy versions, so the
# test would pass without being able to fail. base-image-gate.sh handles the
# case explicitly (`if [ "$rc" -ne 1 ]`); the named mutation, if anyone can
# stage one, is to delete that branch and watch a scanner outage read as green.

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
