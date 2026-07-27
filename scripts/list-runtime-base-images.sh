#!/usr/bin/env bash
# Print the unique set of external base images that reach a *runtime* stage,
# across every Dockerfile in the tree.
#
# Why "runtime stage" and not "every FROM": a multi-stage Dockerfile's build
# stages are thrown away. deploy/api builds nsjail in a `debian:trixie-slim`
# stage and copies out a single binary — Debian's CVEs never ship. Gating on
# them would make the scan red for something that cannot reach a customer,
# which is exactly the kind of unactionable red that trains people to ignore a
# security gate.
#
# Docker's default build target is the LAST stage in the file, so that stage is
# the runtime stage. Its `FROM` may name an earlier stage alias
# (`FROM base AS runner`), so aliases are resolved transitively back to the
# external image reference.
#
# This is discovery, not enumeration: a new Dockerfile anywhere in the tree
# enters the scan matrix automatically. That is the point — the failure mode
# this guards against is someone adding an image nobody remembered to scan.
#
# Usage: list-runtime-base-images.sh
# Env:   BASE_IMAGE_ROOT — tree to scan (default: repo root). Used by the tests.

set -euo pipefail

ROOT="${BASE_IMAGE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Emit "image<TAB>alias" for every FROM, in file order.
#
# POSIX awk only (no gawk IGNORECASE, no [[:space:]]) — GitHub runners ship
# mawk as /usr/bin/awk on some images and this must not depend on which.
parse_froms() {
  awk '
    /^[ \t]*[Ff][Rr][Oo][Mm][ \t]/ {
      img = ""; alias = "";
      for (i = 2; i <= NF; i++) {
        if (substr($i, 1, 2) == "--") continue;      # --platform=, --chmod=
        if (tolower($i) == "as") { alias = $(i + 1); break }
        if (img == "") img = $i;
      }
      print img "\t" alias
    }
  ' "$1"
}

runtime_base_of() {
  local df="$1"
  local -A alias_map=()
  local froms=() entry img alias runtime hops

  mapfile -t froms < <(parse_froms "$df")
  if [ ${#froms[@]} -eq 0 ]; then
    echo "::error file=$df::No FROM instruction found — cannot determine a runtime base image" >&2
    return 1
  fi

  runtime=""
  for entry in "${froms[@]}"; do
    img="${entry%%$'\t'*}"
    alias="${entry#*$'\t'}"
    runtime="$img" # the last FROM wins — that is the default build target
    [ -n "$alias" ] && alias_map["$alias"]="$img"
  done

  # Walk alias -> alias -> ... -> external image reference.
  hops=0
  while [ -n "${alias_map[$runtime]+set}" ]; do
    runtime="${alias_map[$runtime]}"
    hops=$((hops + 1))
    if [ "$hops" -gt 32 ]; then
      echo "::error file=$df::Stage alias chain did not terminate (cycle?)" >&2
      return 1
    fi
  done

  # `scratch` is not a real image — nothing to pull, nothing to scan.
  [ "$runtime" = "scratch" ] && return 0

  # Fail closed rather than silently dropping an unresolvable reference: an
  # image we cannot name is an image we cannot scan, and skipping it quietly
  # would leave a hole that looks like coverage.
  if [[ "$runtime" == *'$'* ]]; then
    echo "::error file=$df::Runtime base image '$runtime' interpolates a build arg — resolve it or add an explicit exclusion" >&2
    return 1
  fi

  printf '%s\n' "$runtime"
}

dockerfiles=()
while IFS= read -r df; do
  dockerfiles+=("$df")
done < <(
  find "$ROOT" \
    \( -path '*/node_modules' -o -path '*/.git' -o -path '*/.claude/worktrees' -o -path '*/.github/fixtures' \) -prune -o \
    -type f \( -name 'Dockerfile' -o -name 'Dockerfile.*' \) -print | sort
)
# .github/fixtures is pruned on purpose: it holds the deliberately-vulnerable
# negative-control image for scripts/__tests__/scan-image.test.sh. Scanning it
# as if it were a shipped base would pin the gate red forever.

if [ ${#dockerfiles[@]} -eq 0 ]; then
  echo "::error::No Dockerfiles found under $ROOT — the discovery glob has rotted" >&2
  exit 1
fi

images=()
for df in "${dockerfiles[@]}"; do
  base="$(runtime_base_of "$df")"
  [ -n "$base" ] && images+=("$base")
done

if [ ${#images[@]} -eq 0 ]; then
  echo "::error::Found ${#dockerfiles[@]} Dockerfile(s) but resolved zero runtime base images" >&2
  exit 1
fi

printf '%s\n' "${images[@]}" | sort -u
