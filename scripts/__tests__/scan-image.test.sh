#!/bin/bash
# Adversarial fixture suite for scripts/scan-image.sh.
#
# Locks in four properties of the gate, each of which fails silently on its own:
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
# Expressed as tests rather than one-off manual checks so they keep holding
# after a Trivy upgrade or a policy-flag edit — every one of these properties
# can be destroyed by a single flag change that nothing else would catch.
#
# Also covers scripts/list-runtime-base-images.sh, which decides *what* gets
# scanned: a discovery bug there is silent, and looks exactly like coverage.
#
# Requires: docker, trivy. Runs in .github/workflows/image-scan.yml; skips with
# a clear message when run locally without them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/scan-image.sh"
DISCOVER="$SCRIPT_DIR/list-runtime-base-images.sh"
FIXTURES="$ROOT/.github/fixtures/image-scan"

for f in "$SCAN" "$DISCOVER"; do
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

# (4) The gate must go RED on a deliberately vulnerable image.
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

# (5) Findings must reach SARIF even on a failing scan — a gate that fails and
#     then discards its evidence is not triageable.
if [ -s "$SARIF_DIR/fixture-vulnerable.sarif" ]; then
  ok "failing scan still emits a non-empty SARIF report"
else
  bad "failing scan produced no SARIF at $SARIF_DIR/fixture-vulnerable.sarif"
fi

# (6) The baseline must suppress the GATE and nothing else. This is the whole
#     premise of the two-pass split in scan-image.sh: if a baselined CVE also
#     disappeared from SARIF, the exemption would be an invisibility cloak
#     rather than a documented, dated deferral.
#
#     Built hermetically: take the fixture's own findings, baseline exactly
#     those, and assert the gate goes green while the SARIF still names them.
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
    ok "baselined findings still appear in SARIF ($probe_cve) — report pass is unfiltered"
  else
    bad "baseline leaked into the report pass — $probe_cve is missing from SARIF"
  fi
fi

# (7) A vulnerable LIBRARY must be REPORTED but must NOT block.
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

# (8) The gate must go GREEN on an image with no packages.
docker build -q -f "$FIXTURES/Dockerfile.clean" -t atlas-scan-fixture:clean "$FIXTURES" >/dev/null
rc=0
bash "$SCAN" atlas-scan-fixture:clean fixture-clean "$SARIF_DIR" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "package-free image passes the gate"
else
  bad "clean fixture — expected exit 0, got exit $rc (gate is unconditionally red)"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
