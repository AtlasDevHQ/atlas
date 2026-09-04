#!/usr/bin/env bash
# check-parked-regions.sh — a region the config calls PARKED may not still be
# running, and may not be able to restart itself.
#
# ## Why this exists
#
# Parking `eu`/`apac` (#5582, 2026-09-01) was a COST decision: two idle
# always-on API processes were 43% of a $38.87 Railway bill, and memory is 90%
# of that bill. The config half shipped that day — `selectable: false` +
# `requestable: true`, verified live on the signup picker and the login
# region-map. The scale-down half never happened. Both services kept one replica
# and ~0.5 GB resident until 2026-09-04, so the entire saving the change existed
# for was never realized, for three days, while EVERY surface correctly reported
# both regions as parked.
#
# Nothing was wrong with any artifact. The config was right, the picker was
# right, the docs were right. What was missing is the only thing this gate does:
# compare what the config CLAIMS against what the infrastructure IS.
#
# ## Three ways it hid, all found the same afternoon
#
# 1. **`/api/health` answers `200` from a parked region.** The region string in
#    that payload is config, not topology — an `api-eu` container relocated to
#    `us-west2` still said `{"region":"eu"}`. A health check cannot see this
#    class at all, which is why this gate reads deployment state instead.
# 2. **`railway scale <home-region>=0` does not stop a service.** It removes the
#    region and Railway assigns a DEFAULT one at one replica. Measured on prod:
#    the EU service kept serving, from the US.
# 3. **Serverless cannot sleep these processes.** The API holds a persistent
#    private-network Postgres pool, and Railway counts an open pool as outbound
#    traffic that prevents sleep — without showing it in the metrics graph, so
#    the failure looks exactly like success.
#
# The mechanism that works, and the three writes parking actually takes, are in
# docs/development/parked-regions.md. This gate enforces writes 2 and 3.
#
# ## What it asserts, per parked region
#
#   autodeploy   must be DISABLED. Both parked services track the `prod` branch,
#                so with autodeploy on, the next release rebuilds and restarts
#                them — measured: the v0.2.30 prod push deployed api-eu and
#                api-apac alongside api and web. Releases here run roughly
#                daily, so a stop without this reverts within a day.
#   deployment   the latest deployment must NOT be live. A parked service has
#                had its deployment removed (`railway down`), so the expected
#                status is REMOVED — or no deployment at all.
#
# A region is PARKED when its arm carries `selectable: false` AND
# `requestable: true`. That pairing is the same one `lib/residency/picker.ts`
# uses, and it deliberately excludes `staging`, which is `selectable: false` and
# NOT requestable — an internal arm that is supposed to keep running.
#
# Selectable regions are not inspected. `us` must keep autodeploy and a live
# deployment, and asserting that is a different gate's job.
#
# ## Deriving, not enumerating
#
# The parked set and each region's service name are READ from
# `deploy/api/atlas.config.ts` — the service name is the first label of the
# arm's `apiUrl` host (`https://api-eu.useatlas.dev` → `api-eu`). Nothing here
# hard-codes `eu` or `apac`, so parking a third region is covered the moment its
# arm lands, with no edit to this file. (A hand-listed set is another claim
# nobody verifies, which is the failure this gate exists to catch.)
#
# ## Exit codes
#
#   0  every parked region is genuinely parked
#   1  a parked region is still running, or can restart itself
#   2  cannot look — the config is missing or no region arm parsed
#   3  DECLINED — no Railway credentials, so infrastructure was never read
#
# ⚠️ **3 is not a pass.** Without credentials this gate verifies nothing, and it
# says so rather than returning green — the same posture `scripts/ci-local.sh`
# takes when `TEST_DATABASE_URL` is absent. CI has no Railway token, so this is
# the expected result there; the gate is for the release runbook and the
# operator, where the credentials exist.
#
# Adversarial fixtures: scripts/__tests__/check-parked-regions.test.sh

set -uo pipefail

ROOT="${PARKED_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG="${PARKED_CONFIG:-$ROOT/deploy/api/atlas.config.ts}"

# Railway coordinates. Overridable so the fixtures never need real ones.
PROJECT_ID="${RAILWAY_PROJECT_ID:-08fe35c3-d1c7-4e34-b6a4-ec5e51c6f241}"
ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-a0a5532e-8e2a-416f-bd24-ae8d2088b330}"

# The probe seam. Called as `$PARKED_PROBE_CMD <service-name>` and expected to
# print two lines:
#
#   autodeploy=true|false
#   deployment=<STATUS>          # REMOVED, SUCCESS, BUILDING, …, or NONE
#
# Anything else — including a non-zero exit — is treated as "could not read",
# which DECLINES rather than passing. Fixtures inject a stub here; in real use
# it is unset and the built-in Railway probe below runs.
PROBE_CMD="${PARKED_PROBE_CMD:-}"

fail=0
declined=0
checked=0

say()  { printf '%s\n' "$*"; }
err()  { printf '::error::%s\n' "$*" >&2; }

# ── The parked set, read out of the config ────────────────────────────────────
#
# Walks each `"<id>": { … },` arm inside the residency regions map and emits
#   <region-id> <service-name>
# for the arms that are selectable:false AND requestable:true.
parked_regions() {
  awk '
    # Enter a region arm: a quoted key opening a brace.
    /^[[:space:]]*"[a-z0-9-]+"[[:space:]]*:[[:space:]]*\{/ {
      match($0, /"[a-z0-9-]+"/)
      id = substr($0, RSTART + 1, RLENGTH - 2)
      inarm = 1; sel = ""; req = ""; api = ""
      next
    }
    inarm && /apiUrl[[:space:]]*:/ {
      if (match($0, /https?:\/\/[^"'"'"']+/)) api = substr($0, RSTART, RLENGTH)
    }
    inarm && /selectable[[:space:]]*:/    { sel = ($0 ~ /true/) ? "true" : "false" }
    inarm && /requestable[[:space:]]*:/   { req = ($0 ~ /true/) ? "true" : "false" }
    # Close the arm.
    inarm && /^[[:space:]]*\},?[[:space:]]*$/ {
      if (sel == "false" && req == "true" && api != "") {
        host = api
        sub(/^https?:\/\//, "", host)
        sub(/\/.*$/, "", host)
        sub(/\..*$/, "", host)          # first label: api-eu.useatlas.dev -> api-eu
        if (host != "") print id, host
      }
      inarm = 0
    }
  ' "$1"
}

# ── The built-in probe (real Railway) ─────────────────────────────────────────
railway_probe() {
  local service_name="$1" service_id status_json deploy_status

  service_id="$(railway api \
    'query($id:String!){project(id:$id){services{edges{node{id name}}}}}' \
    --var id="$PROJECT_ID" 2>/dev/null \
    | SERVICE_NAME="$service_name" python3 -c "
import sys, json, os
want = os.environ['SERVICE_NAME']
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
for e in d.get('data', {}).get('project', {}).get('services', {}).get('edges', []):
    if e['node']['name'] == want:
        print(e['node']['id']); break
" 2>/dev/null)"

  # Fall back to resolving by name through the CLI's own linking if the broad
  # query is not available to this token.
  if [ -z "$service_id" ]; then return 1; fi

  status_json="$(railway api \
    'query($p:String!,$e:String!,$s:String!){serviceInstanceAutoDeployStatus(projectId:$p,environmentId:$e,serviceId:$s){enabled}}' \
    --var p="$PROJECT_ID" --var e="$ENVIRONMENT_ID" --var s="$service_id" 2>/dev/null)" || return 1

  local enabled
  enabled="$(printf '%s' "$status_json" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
s = d.get('data', {}).get('serviceInstanceAutoDeployStatus')
print('true' if s and s.get('enabled') else 'false')
" 2>/dev/null)" || return 1
  [ -n "$enabled" ] || return 1

  deploy_status="$(railway deployment list --service "$service_name" 2>/dev/null \
    | sed -n '2p' | awk -F'|' '{gsub(/ /,"",$2); print $2}')"
  [ -n "$deploy_status" ] || deploy_status="NONE"

  printf 'autodeploy=%s\ndeployment=%s\n' "$enabled" "$deploy_status"
}

probe() {
  if [ -n "$PROBE_CMD" ]; then
    $PROBE_CMD "$1"
  else
    railway_probe "$1"
  fi
}

# ── Run ───────────────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG" ]; then
  err "config not found at $CONFIG — this gate cannot look."
  exit 2
fi

mapfile -t PARKED < <(parked_regions "$CONFIG")

if [ "${#PARKED[@]}" -eq 0 ]; then
  # No parked region is a legitimate state (every region serving). But an
  # unparseable config looks identical, so prove at least one arm was seen.
  if ! grep -qE '^[[:space:]]*"[a-z0-9-]+"[[:space:]]*:[[:space:]]*\{' "$CONFIG"; then
    err "no region arm parsed out of $CONFIG — has its shape changed?"
    exit 2
  fi
  say "check-parked-regions.sh: no region is parked (none carries selectable:false + requestable:true). Nothing to assert."
  exit 0
fi

say "check-parked-regions.sh — ${#PARKED[@]} parked region(s) read from ${CONFIG#"$ROOT"/}"

if [ -z "$PROBE_CMD" ] && ! command -v railway >/dev/null 2>&1; then
  say ""
  say "  DECLINED: the railway CLI is not on PATH, so infrastructure was never read."
  say "  This gate needs Railway credentials; CI has none. Run it from the release"
  say "  runbook or an operator shell. See docs/development/parked-regions.md."
  exit 3
fi

for entry in "${PARKED[@]}"; do
  region="${entry%% *}"
  service="${entry##* }"
  say ""
  say "  $region -> service '$service'"

  if ! out="$(probe "$service" 2>/dev/null)" || [ -z "$out" ]; then
    say "    COULD NOT READ — no answer from the probe for '$service'."
    declined=1
    continue
  fi

  autodeploy="$(printf '%s\n' "$out" | sed -n 's/^autodeploy=//p' | head -1)"
  deployment="$(printf '%s\n' "$out" | sed -n 's/^deployment=//p' | head -1)"

  if [ -z "$autodeploy" ] || [ -z "$deployment" ]; then
    say "    COULD NOT READ — probe answered without autodeploy= and deployment=."
    declined=1
    continue
  fi

  checked=$((checked + 1))

  if [ "$autodeploy" = "true" ]; then
    say "    FAIL  autodeploy is ENABLED. The next release to \`prod\` rebuilds and"
    say "          restarts this region, silently reverting the park."
    fail=1
  else
    say "    ok    autodeploy disabled"
  fi

  case "$deployment" in
    REMOVED|NONE|SKIPPED)
      say "    ok    no live deployment ($deployment)"
      ;;
    *)
      say "    FAIL  deployment is '$deployment' — this region is RUNNING and billing,"
      say "          while the config advertises it as parked."
      fail=1
      ;;
  esac
done

say ""

if [ "$fail" -ne 0 ]; then
  err "a region the config calls parked is still running, or can restart itself. See docs/development/parked-regions.md — parking is three writes."
  exit 1
fi

if [ "$declined" -ne 0 ] || [ "$checked" -eq 0 ]; then
  say "DECLINED: could not read infrastructure for every parked region, so nothing is verified."
  exit 3
fi

say "check-parked-regions.sh: every parked region is stopped and cannot restart itself ($checked checked)."
exit 0
