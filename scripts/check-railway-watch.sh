#!/usr/bin/env bash
# Verify every repo-relative COPY source in each deploy Dockerfile is
# covered by its service's railway.json watchPatterns.
#
# The F-10 / PR #1758 incident: a bun.lock change went unshipped because
# api / api-eu / api-apac / web did not list "bun.lock" in watchPatterns,
# so Railway didn't redeploy on the merge. PR #1760 added the missing
# entries. This check keeps a future service from drifting the same way.
#
# Pass conditions:
#   - Every `COPY <src> <dst>` source in the Dockerfile is covered by a
#     watchPatterns entry (exact match, X/** prefix, or X* prefix).
#   - `COPY --from=<stage>` lines are skipped (intra-image).
#   - `COPY . .` is skipped (broad-context copy, not useful to match).
#   - Services without watchPatterns warn (Railway rebuilds on every push —
#     wasteful but not broken). Services without a Dockerfile builder
#     (NIXPACKS etc.) are skipped entirely.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0
WARNINGS=0

# Match a source path against a glob-style watchPattern.
# Supports:
#   - Exact match (bun.lock)
#   - Trailing /** — prefix match (packages/api/**)
#   - Middle ** — any-depth wildcard (packages/**/package.json)
#   - Single * — single-segment wildcard (not commonly used but correct)
#
# Conversion rules: ** → .*, * → [^/]*. Regex specials are escaped first.
matches_pattern() {
  local src="$1"
  local pat="$2"

  # Fast path: exact match
  if [ "$src" = "$pat" ]; then
    return 0
  fi

  # X/** also matches X itself (bare directory), which the regex wouldn't.
  if [[ "$pat" == *"/**" ]]; then
    local prefix="${pat%/**}"
    if [ "$src" = "$prefix" ]; then
      return 0
    fi
  fi

  # Build a regex: escape specials, ** → .*, * → [^/]*.
  # The §§ placeholder prevents collapsing ** into a double [^/]*.
  local re="$pat"
  re="${re//\\/\\\\}"
  re="${re//./\\.}"
  re="${re//+/\\+}"
  re="${re//\?/\\?}"
  re="${re//^/\\^}"
  re="${re//\$/\\\$}"
  re="${re//(/\\(}"
  re="${re//)/\\)}"
  re="${re//\{/\\\{}"
  re="${re//\}/\\\}}"
  re="${re//[/\\[}"
  re="${re//]/\\]}"
  re="${re//|/\\|}"
  re="${re//\*\*/§§}"
  re="${re//\*/[^/]*}"
  re="${re//§§/.*}"
  if [[ "$src" =~ ^${re}$ ]]; then
    return 0
  fi
  return 1
}

# Extract COPY sources from a Dockerfile, one per line.
# Skips --from= copies (intra-image) and the broad `COPY . .`.
# Normalizes trailing glob (bun.lock* → bun.lock) since watchPatterns
# list the base filename.
extract_sources() {
  local dockerfile="$1"
  # Normalize: strip trailing whitespace/CR, drop blank lines, collapse to
  # lines starting with COPY (case-insensitive would be wrong — Dockerfile
  # keywords are uppercase by convention).
  grep -E '^COPY[[:space:]]' "$dockerfile" | while IFS= read -r line; do
    # Skip --from= (intra-image copy)
    if [[ "$line" == *"--from="* ]]; then
      continue
    fi
    # Drop the COPY keyword
    line="${line#COPY}"
    line="${line# }"
    # Drop --chown=...:... and any other --flag=value
    # shellcheck disable=SC2001
    line=$(echo "$line" | sed -E 's/--[a-zA-Z]+=[^[:space:]]+[[:space:]]+//g')
    # Last whitespace-separated word is the destination; drop it
    # shellcheck disable=SC2206
    words=($line)
    unset "words[${#words[@]}-1]"
    for src in "${words[@]}"; do
      # Skip broad-context copy
      if [ "$src" = "." ] || [ "$src" = "./" ]; then
        continue
      fi
      # Normalize trailing glob (bun.lock* → bun.lock)
      src="${src%\*}"
      # Normalize trailing slash
      src="${src%/}"
      if [ -n "$src" ]; then
        echo "$src"
      fi
    done
  done
}

# Extract watchPatterns entries from a railway.json, one per line.
# Uses a simple awk pass since we know the JSON layout — no jq dependency.
extract_watch_patterns() {
  local railway_json="$1"
  # Capture everything between "watchPatterns": [ and the matching ]
  # then pull out quoted strings.
  awk '
    /"watchPatterns"/,/]/ {
      if (match($0, /"[^"]+"/)) {
        s = substr($0, RSTART, RLENGTH)
        # Skip the key itself
        if (s != "\"watchPatterns\"") {
          gsub(/"/, "", s)
          print s
        }
      }
    }
  ' "$railway_json"
}

# Extract dockerfilePath from railway.json (awk, no jq)
extract_dockerfile_path() {
  local railway_json="$1"
  awk '
    /"dockerfilePath"/ {
      if (match($0, /"dockerfilePath"[[:space:]]*:[[:space:]]*"[^"]+"/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/^"dockerfilePath"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        print s
        exit
      }
    }
  ' "$railway_json"
}

# Extract builder type (DOCKERFILE, NIXPACKS, etc.)
extract_builder() {
  local railway_json="$1"
  awk '
    /"builder"/ {
      if (match($0, /"builder"[[:space:]]*:[[:space:]]*"[^"]+"/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/^"builder"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        print s
        exit
      }
    }
  ' "$railway_json"
}

# --- main ---
for railway_json in "$ROOT"/deploy/*/railway.json; do
  [ -f "$railway_json" ] || continue
  svc="$(basename "$(dirname "$railway_json")")"
  rel_json="${railway_json#"$ROOT"/}"

  builder=$(extract_builder "$railway_json")
  if [ "$builder" != "DOCKERFILE" ]; then
    echo "$svc: builder=${builder:-unknown} — skipping (only DOCKERFILE builds are checked)"
    continue
  fi

  dockerfile_rel=$(extract_dockerfile_path "$railway_json")
  if [ -z "$dockerfile_rel" ]; then
    echo "::error file=$rel_json::dockerfilePath missing for DOCKERFILE builder"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  dockerfile_abs="$ROOT/$dockerfile_rel"
  if [ ! -f "$dockerfile_abs" ]; then
    echo "::error file=$rel_json::dockerfilePath $dockerfile_rel does not exist"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Read watchPatterns into an array
  mapfile -t patterns < <(extract_watch_patterns "$railway_json")
  if [ ${#patterns[@]} -eq 0 ]; then
    echo "::warning file=$rel_json::$svc has no watchPatterns — Railway rebuilds on every push (wasteful; add narrow patterns to reduce noise)"
    WARNINGS=$((WARNINGS + 1))
    continue
  fi

  # Check each COPY source is covered
  echo "--- $svc (Dockerfile: $dockerfile_rel, ${#patterns[@]} watchPatterns) ---"
  missing_for_svc=0
  mapfile -t sources < <(extract_sources "$dockerfile_abs")
  for src in "${sources[@]}"; do
    [ -n "$src" ] || continue
    covered=0
    for pat in "${patterns[@]}"; do
      if matches_pattern "$src" "$pat"; then
        covered=1
        break
      fi
    done
    if [ $covered -eq 0 ]; then
      echo "::error file=$rel_json::COPY source '$src' in $dockerfile_rel is not covered by any watchPattern — a change to this file will not trigger a Railway redeploy"
      missing_for_svc=$((missing_for_svc + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done

  if [ $missing_for_svc -eq 0 ]; then
    echo "  All ${#sources[@]} COPY sources covered"
  fi
done

echo ""
if [ $ERRORS -gt 0 ]; then
  echo "FAIL: $ERRORS COPY source(s) not covered by watchPatterns — see errors above"
  echo "Fix: add the missing paths to the corresponding deploy/<service>/railway.json watchPatterns array"
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  echo "OK (with $WARNINGS warning(s)): all deploy Dockerfile COPY sources are covered where watchPatterns are defined"
else
  echo "OK: all deploy Dockerfile COPY sources are covered by their service's watchPatterns"
fi
