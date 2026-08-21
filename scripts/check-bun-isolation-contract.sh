#!/usr/bin/env bash
# check-bun-isolation-contract.sh — the isolation that makes 9 allowlist
# entries safe is a MEASURED property of bun, not a documented contract (#5368).
#
# ## Why this exists
#
# `scripts/test-discipline-allowlist.txt` permits 9 files to write
# `process.env.X` at module top level. That is only safe because
# `bun test --parallel` (which implies `--isolate`) gives every test FILE its own
# env, cwd and globals — even when bun packs 17 of them into one worker process.
#
# Nothing in bun's docs promises that. It is behaviour, measured on 1.4.0. If a
# bun upgrade regressed it, those 9 files would silently start corrupting
# whatever file the scheduler happened to place next in the same worker — the
# hardest class of failure to attribute, and nothing in CI would notice.
#
# This gate is what notices. It is a runtime contract test, not a source scan:
# `check-test-discipline.sh` reads the tree, this one reads BUN.
#
# ## The positive control is the point
#
# A probe that reports "no leaks" because it cannot detect leaks at all is worse
# than no gate. So the same probe runs twice:
#
#   --parallel  → leaks MUST be 0   (the contract the allowlist depends on)
#   bare        → leaks MUST be > 0 (proof the probe can see a leak when there is one)
#
# Bare `bun test` shares one process across files with no isolation — CLAUDE.md
# forbids it for multi-file runs precisely because of this. Here that failure
# mode is the instrument: if the bare arm ever reports zero leaks, the probe has
# stopped measuring and this gate fails as "cannot measure" rather than passing.
#
# Fixtures are built in a temp dir OUTSIDE the repo on purpose — they contain
# exactly the top-level `process.env` writes that `check-test-discipline.sh`
# forbids, and generating them at runtime keeps them from tripping that gate or
# needing an allowlist entry of their own.
#
# Exit codes: 0 contract holds · 1 contract regressed · 2 could not measure.

set -uo pipefail

command -v bun >/dev/null 2>&1 || { echo "::error::[bun-isolation] bun not on PATH — cannot measure." >&2; exit 2; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

PROBE_DIR="$TMPROOT/probe"
mkdir -p "$PROBE_DIR"

# 6 files: enough that bun packs several into a shared worker, which is the
# only condition under which cross-file leakage is even possible.
PROBE_N=6
for n in $(seq 1 "$PROBE_N"); do
  cat > "$PROBE_DIR/probe$n.test.ts" <<EOF
import { test, expect } from "bun:test";
import * as fs from "fs";
// Observe INHERITED state BEFORE mutating anything.
fs.appendFileSync(process.env.PROBE_OUT!, JSON.stringify({
  self: "probe$n",
  pid: process.pid,
  sawEnv: process.env.PROBE_LEAK ?? null,
  sawCwd: process.cwd(),
}) + "\n");
// Now mutate, exactly as the allowlisted files do.
process.env.PROBE_LEAK = "probe$n";
process.chdir("/tmp");
test("probe$n", () => { expect(1).toBe(1); });
EOF
done

BASE_CWD="$PROBE_DIR"

# Prints "<files> <pids> <envLeaks> <cwdLeaks>" for one invocation mode.
run_arm() {
  local out="$TMPROOT/$1.jsonl"; shift
  : >"$out"
  ( cd "$BASE_CWD" && PROBE_OUT="$out" bun test "$@" ) >/dev/null 2>&1
  [ -s "$out" ] || { echo "EMPTY"; return; }
  awk -v base="$BASE_CWD" '
    { files++
      if (match($0, /"pid":[0-9]+/)) { p = substr($0, RSTART+6, RLENGTH-6); pids[p] = 1 }
      if (index($0, "\"sawEnv\":null") == 0) envleak++
      if (index($0, "\"sawCwd\":\"" base "\"") == 0) cwdleak++
    }
    END { n = 0; for (p in pids) n++; printf "%d %d %d %d", files, n, envleak+0, cwdleak+0 }
  ' "$out"
}

echo "[bun-isolation] bun $(bun --version), $PROBE_N probe files"

read -r P_FILES P_PIDS P_ENV P_CWD <<<"$(run_arm parallel --parallel)"
read -r B_FILES B_PIDS B_ENV B_CWD <<<"$(run_arm bare)"

for v in "$P_FILES" "$B_FILES"; do
  case "$v" in ''|*[!0-9]*) echo "::error::[bun-isolation] a probe arm produced no output — cannot measure." >&2; exit 2;; esac
done

printf '  %-12s files=%s pids=%s envLeaks=%s cwdLeaks=%s\n' "--parallel" "$P_FILES" "$P_PIDS" "$P_ENV" "$P_CWD"
printf '  %-12s files=%s pids=%s envLeaks=%s cwdLeaks=%s\n' "bare" "$B_FILES" "$B_PIDS" "$B_ENV" "$B_CWD"

RC=0

# --- Vacuity floors: refuse to pass if the instrument is not working ---
if [ "$P_FILES" -ne "$PROBE_N" ] || [ "$B_FILES" -ne "$PROBE_N" ]; then
  echo "::error::[bun-isolation] expected $PROBE_N observations per arm; the probe did not run every file." >&2
  exit 2
fi
if [ "$B_ENV" -eq 0 ]; then
  echo "::error::[bun-isolation] POSITIVE CONTROL FAILED: bare \`bun test\` leaked nothing." >&2
  echo "::error::  The probe can no longer detect a leak, so the --parallel result below proves nothing." >&2
  exit 2
fi

# --- The contract itself ---
if [ "$P_ENV" -ne 0 ] || [ "$P_CWD" -ne 0 ]; then
  echo "::error::[bun-isolation] CONTRACT REGRESSED: \`bun test --parallel\` leaked across files" >&2
  echo "::error::  (env=$P_ENV cwd=$P_CWD). The $(grep -c $'^env\t' "$(dirname "$0")/test-discipline-allowlist.txt" 2>/dev/null || echo '9') env entries in" >&2
  echo "::error::  scripts/test-discipline-allowlist.txt are only safe while this is 0. See #5368." >&2
  RC=1
fi

if [ "$RC" -eq 0 ]; then
  echo "[bun-isolation] OK — --parallel isolates env and cwd across files;" \
       "bare bun test leaked $B_ENV (positive control intact)."
fi
exit "$RC"
