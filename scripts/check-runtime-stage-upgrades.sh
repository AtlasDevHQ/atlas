#!/usr/bin/env bash
# check-runtime-stage-upgrades.sh — every runtime stage in the tree must upgrade
# its OS packages (#5361).
#
# ## Why this is the premise, not a nicety
#
# The image-scan gate stopped blocking on the absolute CVE state of an unchanged
# base image (#5361). That is only safe because of one measured fact:
#
#   all 8 runtime stages run `apt-get upgrade` / `apk upgrade`
#
# so no base-layer CVE reaches a shipped artifact, and the built-image tier —
# which reads the finished artifact — is the gate of record. `.trivyignore` has
# said the same thing since 2026-08-12:
#
#   "If a future Dockerfile adds a runtime stage WITHOUT an upgrade, these
#    entries silently start lying."
#
# Until now that was caught by luck. Under the #5361 change it was caught by
# NOTHING, and the hole is specific and silent:
#
#   a new Dockerfile on an EXISTING base with no upgrade is invisible. Its base
#   ref did not change, so the base tier does not gate it; it is not one of the
#   three images in the built-images matrix, so it never gets an artifact scan.
#
# That is the one property the #5361 design makes WEAKER rather than stronger,
# which is why this guard ships in the same change. Deleting it re-opens the
# hole in a way no scan will report.
#
# ## What counts as a runtime stage
#
# The same thing scripts/list-runtime-base-images.sh means by it: the LAST stage
# in the file, which is Docker's default build target. Its `FROM` may name an
# earlier stage alias, so the chain is walked back to the external image — and
# an upgrade ANYWHERE on that chain counts, because the runtime stage inherits
# those layers. A build-only stage that is not on the chain does not count and
# does not need one: nothing it installs ships.
#
# ## What counts as an upgrade
#
#   apt-get upgrade · apt upgrade · apk upgrade
#
# with any flags in between (`apk -U upgrade`, `apt-get -y upgrade`). Matched
# line-by-line with comments stripped, so a `# apt-get upgrade` in prose cannot
# satisfy the guard. A continuation-split `apt-get \<newline> upgrade` would NOT
# match — that error direction is loud (a false red on a real upgrade), never a
# false pass.
#
# There is deliberately NO in-file suppression marker. A base with no package
# manager (distroless, scratch-adjacent) genuinely cannot satisfy this, and the
# right response is a reviewed edit to this guard naming that base — not a
# comment any author can add to silence a security premise under time pressure.
# `scratch` itself is the one exception, and it is exempt by construction: it
# contains no packages to upgrade.
#
# Exit codes: 0 every runtime stage upgrades · 1 one or more does not ·
#             2 this gate could not look (no Dockerfiles, unparseable file).
#
# Env: BASE_IMAGE_ROOT — tree to check (default: repo root). Same seam name and
#      same meaning as list-runtime-base-images.sh; used by the fixtures.
#
# Adversarial fixtures: scripts/__tests__/scan-image.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BASE_IMAGE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# list_dockerfiles — shared with list-runtime-base-images.sh on purpose, so the
# set of files scanned and the set of files checked can never diverge.
# shellcheck source=scripts/lib/dockerfile-stages.sh
. "$SCRIPT_DIR/lib/dockerfile-stages.sh"

die() { echo "::error::[runtime-stage-upgrades] $1" >&2; exit 2; }

# Emit one "<idx>\t<image>\t<alias>\t<0|1 upgrades>" record per stage, in file
# order. POSIX awk only — GitHub runners ship mawk as /usr/bin/awk on some
# images and this must not depend on which.
parse_stages() {
  awk '
    function flush() { if (idx >= 0) print idx "\t" img "\t" alias "\t" up }
    BEGIN { idx = -1; img = ""; alias = ""; up = 0 }
    /^[ \t]*#/ { next }                                  # a comment runs nothing
    /^[ \t]*[Ff][Rr][Oo][Mm][ \t]/ {
      flush()
      idx++; img = ""; alias = ""; up = 0
      for (i = 2; i <= NF; i++) {
        if (substr($i, 1, 2) == "--") continue;          # --platform=, --chmod=
        if (tolower($i) == "as") { alias = $(i + 1); break }
        if (img == "") img = $i;
      }
      next
    }
    {
      line = tolower($0)
      if (idx >= 0 && line ~ /(apt-get|apt|apk)([ \t]+-[^ \t]+)*[ \t]+upgrade/) up = 1
    }
    END { flush() }
  ' "$1"
}

dockerfiles=()
while IFS= read -r df; do
  dockerfiles+=("$df")
done < <(list_dockerfiles "$ROOT")

# ⚠️ VACUITY FLOOR. A gate whose product is the negative "every runtime stage
# upgrades" must not emit it after finding no Dockerfiles. That is the failure
# this whole family of guards exists to refuse.
if [ ${#dockerfiles[@]} -eq 0 ]; then
  die "no Dockerfiles found under $ROOT — the discovery glob has rotted, so this gate verified NOTHING."
fi

echo "check-runtime-stage-upgrades.sh — ${#dockerfiles[@]} Dockerfile(s) under $ROOT"

MISSING=()
CHECKED=0

for df in "${dockerfiles[@]}"; do
  rel="${df#"$ROOT"/}"

  idxs=() imgs=() aliases=() ups=()
  while IFS=$'\t' read -r idx img alias up; do
    idxs+=("$idx"); imgs+=("$img"); aliases+=("$alias"); ups+=("$up")
  done < <(parse_stages "$df")

  if [ ${#idxs[@]} -eq 0 ]; then
    die "no FROM instruction in $rel — cannot identify its runtime stage."
  fi

  # alias -> stage index, so the runtime stage's ancestry can be walked.
  declare -A alias_idx=()
  for i in "${!idxs[@]}"; do
    [ -n "${aliases[$i]}" ] && alias_idx["${aliases[$i]}"]="$i"
  done

  cur=$(( ${#idxs[@]} - 1 ))   # last stage = Docker's default build target
  upgrades=0
  chain=()
  hops=0
  while :; do
    chain+=("${aliases[$cur]:-stage-$cur}")
    [ "${ups[$cur]}" = "1" ] && upgrades=1
    parent="${imgs[$cur]}"
    [ -n "${alias_idx[$parent]+set}" ] || break
    cur="${alias_idx[$parent]}"
    hops=$((hops + 1))
    if [ "$hops" -gt 32 ]; then
      die "stage alias chain in $rel did not terminate (cycle?)."
    fi
  done
  base="${imgs[$cur]}"

  unset alias_idx

  # `scratch` holds no packages, so there is nothing to upgrade and nothing a
  # CVE could live in. Exempt by construction rather than by exception.
  if [ "$base" = "scratch" ]; then
    printf '  --   %-52s %s\n' "$rel" "scratch — no packages to upgrade"
    continue
  fi

  CHECKED=$((CHECKED + 1))
  if [ "$upgrades" = "1" ]; then
    printf '  ok   %-52s %s\n' "$rel" "$base"
  else
    printf '  FAIL %-52s %s\n' "$rel" "$base"
    echo "::error file=$rel::runtime stage (chain: ${chain[*]}) on '$base' never runs apt-get upgrade / apk upgrade — a base-layer CVE in it SHIPS." >&2
    MISSING+=("$rel")
  fi
done

echo ""

# ⚠️ Second vacuity floor. Every Dockerfile resolving to `scratch` would print a
# clean run having verified nothing about any package.
if [ "$CHECKED" -eq 0 ]; then
  die "found ${#dockerfiles[@]} Dockerfile(s) but every runtime stage resolved to 'scratch' — this gate verified NOTHING."
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "FAIL: ${#MISSING[@]} runtime stage(s) do not upgrade their OS packages:" >&2
  for f in "${MISSING[@]}"; do echo "  - $f" >&2; done
  cat >&2 <<'EOF'

Why this blocks: the image-scan gate no longer blocks on the absolute CVE state
of an unchanged base image (#5361), because every runtime stage upgrades and so
no base-layer CVE reaches a shipped artifact. A runtime stage without an upgrade
falsifies that premise AND is invisible to both scan tiers — its base ref did not
change, so the base tier does not gate it, and it is not in the built-images
matrix, so it never gets an artifact scan.

Fix: add an upgrade to the runtime stage, e.g.

  RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
  RUN apk upgrade --no-cache

If the base genuinely has no package manager, that needs a reviewed exemption in
scripts/check-runtime-stage-upgrades.sh naming the base — not a silencing
comment in the Dockerfile. Read that script's header for why.
EOF
  exit 1
fi

echo "check-runtime-stage-upgrades.sh: all $CHECKED runtime stage(s) upgrade their OS packages."
