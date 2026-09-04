#!/usr/bin/env bash
# Adversarial fixture suite for scripts/check-parked-regions.sh.
#
# The gate reads live Railway, which CI cannot do. So the suite drives it
# through its two injection seams instead — PARKED_CONFIG (a scaffolded region
# config) and PARKED_PROBE_CMD (a stub standing in for Railway) — which makes
# every case runnable with no credentials and no network.
#
# What each case locks in, and why it is here rather than inferred:
#
#   1. DERIVATION — parked is `selectable:false` AND `requestable:true`. A
#      selectable region is not inspected even when running; `staging` is
#      selectable:false but NOT requestable and must not be treated as parked.
#      Both of those exclusions are load-bearing: treating staging as parked
#      would fail the gate forever on a service that is supposed to run.
#
#   2. THE TWO FAILING DIRECTIONS, each driven separately, because they are
#      different defects that both looked like success on 2026-09-04:
#        - deployment live      → the region was never actually stopped
#        - autodeploy enabled   → the next release restarts it
#      A gate that only caught one would have passed the other.
#
#   3. DECLINE, NOT PASS, when infrastructure cannot be read. An unreadable
#      probe must exit 3, never 0 — a gate that returns green when it looked at
#      nothing is worse than no gate, which is the whole lesson of the incident
#      this guard comes from.
#
# The suite ends with a real-repo case: the parked set derived from the actual
# `deploy/api/atlas.config.ts` must be exactly the regions that config marks
# parked, so the parser cannot drift from the file it reads.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-parked-regions.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0
TMPS=()
cleanup() { for t in "${TMPS[@]:-}"; do [ -n "$t" ] && rm -rf "$t"; done; }
trap cleanup EXIT

# mkconfig <<'EOF' … EOF  — write a region-map fixture, echo its path.
mkconfig() {
  local tmp
  tmp="$(mktemp -d)"; TMPS+=("$tmp")
  cat > "$tmp/atlas.config.ts"
  printf '%s' "$tmp/atlas.config.ts"
}

# mkprobe <autodeploy> <deployment> — a stub probe answering the same for every
# service. `-` for either field omits that line (a malformed answer).
mkprobe() {
  local tmp auto="$1" dep="$2"
  tmp="$(mktemp -d)"; TMPS+=("$tmp")
  {
    printf '#!/usr/bin/env bash\n'
    [ "$auto" != "-" ] && printf 'printf "autodeploy=%s\\n"\n' "$auto"
    [ "$dep" != "-" ] && printf 'printf "deployment=%s\\n"\n' "$dep"
    printf 'exit 0\n'
  } > "$tmp/probe.sh"
  chmod +x "$tmp/probe.sh"
  printf '%s' "$tmp/probe.sh"
}

# mkprobe_silent — a probe that answers nothing at all (Railway unreachable).
mkprobe_silent() {
  local tmp
  tmp="$(mktemp -d)"; TMPS+=("$tmp")
  printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/probe.sh"
  chmod +x "$tmp/probe.sh"
  printf '%s' "$tmp/probe.sh"
}

# run_case <expected-exit> <name> <config> <probe>
run_case() {
  local expected="$1" name="$2" config="$3" probe="$4" status=0 out
  out="$(PARKED_CONFIG="$config" PARKED_PROBE_CMD="$probe" bash "$SCRIPT" 2>&1)" || status=$?
  if [ "$status" -eq "$expected" ]; then
    printf '  ok    %s (exit %d)\n' "$name" "$status"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s — expected exit %d, got %d\n' "$name" "$expected" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    FAIL=$((FAIL + 1))
  fi
}

# ── Fixtures ──────────────────────────────────────────────────────────────────

PARKED_ONE="$(mkconfig <<'EOF'
      "us": {
        label: "United States",
        apiUrl: "https://api.useatlas.dev",
        isDefault: true,
      },
      "eu": {
        label: "Europe",
        apiUrl: "https://api-eu.useatlas.dev",
        selectable: false,
        requestable: true,
      },
      "staging": {
        label: "Staging",
        apiUrl: "https://api.staging.useatlas.dev",
        selectable: false,
      },
EOF
)"

NONE_PARKED="$(mkconfig <<'EOF'
      "us": {
        label: "United States",
        apiUrl: "https://api.useatlas.dev",
        isDefault: true,
      },
      "staging": {
        label: "Staging",
        apiUrl: "https://api.staging.useatlas.dev",
        selectable: false,
      },
EOF
)"

UNPARSEABLE="$(mkconfig <<'EOF'
// a config whose region map has been reshaped beyond recognition
export const regions = [];
EOF
)"

GOOD_PROBE="$(mkprobe false REMOVED)"

# ── Cases ─────────────────────────────────────────────────────────────────────

echo "check-parked-regions.test.sh"
echo ""
echo "  derivation"

run_case 0 "a properly parked region passes" "$PARKED_ONE" "$GOOD_PROBE"
run_case 0 "no parked region is a pass, not an error" "$NONE_PARKED" "$GOOD_PROBE"

# staging must not be inspected: a probe that would FAIL any inspected service,
# against a config whose only non-selectable arm is staging, must still pass.
run_case 0 "staging (selectable:false, not requestable) is not treated as parked" \
  "$NONE_PARKED" "$(mkprobe true SUCCESS)"

echo ""
echo "  the two failing directions"

run_case 1 "RED: a parked region with a live deployment" \
  "$PARKED_ONE" "$(mkprobe false SUCCESS)"
run_case 1 "RED: a parked region with autodeploy enabled" \
  "$PARKED_ONE" "$(mkprobe true REMOVED)"
run_case 1 "RED: both wrong at once" \
  "$PARKED_ONE" "$(mkprobe true BUILDING)"

# A deployment mid-flight is live, not parked.
run_case 1 "RED: a parked region mid-deploy (DEPLOYING)" \
  "$PARKED_ONE" "$(mkprobe false DEPLOYING)"

echo ""
echo "  a service with no deployment at all is parked"
run_case 0 "NONE counts as no live deployment" "$PARKED_ONE" "$(mkprobe false NONE)"

echo ""
echo "  decline, never a false green"

run_case 3 "an unreadable probe DECLINES rather than passing" \
  "$PARKED_ONE" "$(mkprobe_silent)"
run_case 3 "a probe missing autodeploy= DECLINES" \
  "$PARKED_ONE" "$(mkprobe - REMOVED)"
run_case 3 "a probe missing deployment= DECLINES" \
  "$PARKED_ONE" "$(mkprobe false -)"

echo ""
echo "  cannot look"

run_case 2 "a missing config exits 2" "/nonexistent/atlas.config.ts" "$GOOD_PROBE"
run_case 2 "a config with no region arms exits 2" "$UNPARSEABLE" "$GOOD_PROBE"

# ── Real-repo case ────────────────────────────────────────────────────────────
#
# The parser must agree with the actual config. Derive the expected parked set
# independently here (grep the arms marked requestable) and compare.

echo ""
echo "  real repo"

REAL_CONFIG="$ROOT/deploy/api/atlas.config.ts"
if [ ! -f "$REAL_CONFIG" ]; then
  printf '  FAIL  real config not found at %s\n' "$REAL_CONFIG"
  FAIL=$((FAIL + 1))
else
  derived="$(PARKED_CONFIG="$REAL_CONFIG" PARKED_PROBE_CMD="$GOOD_PROBE" \
    bash "$SCRIPT" 2>/dev/null | sed -n 's/^  \([a-z0-9-]*\) -> service .\(.*\)./\1/p' | sort | tr '\n' ' ')"
  expected="$(grep -c 'requestable: true' "$REAL_CONFIG" 2>/dev/null || echo 0)"
  derived_count="$(printf '%s' "$derived" | wc -w | tr -d ' ')"
  if [ "$derived_count" -eq "$expected" ] && [ "$expected" -gt 0 ]; then
    printf '  ok    parser agrees with the real config (%s parked: %s)\n' "$expected" "$derived"
    PASS=$((PASS + 1))
  elif [ "$expected" -eq 0 ] && [ "$derived_count" -eq 0 ]; then
    printf '  ok    real config marks no region parked, and the parser agrees\n'
    PASS=$((PASS + 1))
  else
    printf '  FAIL  parser derived %d parked region(s) [%s] but the config carries %s `requestable: true`\n' \
      "$derived_count" "$derived" "$expected"
    FAIL=$((FAIL + 1))
  fi
fi

echo ""
printf 'check-parked-regions.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
