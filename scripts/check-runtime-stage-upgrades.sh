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
# ## The second mode, and why it lives here
#
#   check-runtime-stage-upgrades.sh --assert-runtime-stage <dockerfile> <alias>
#
# Asserts that <dockerfile>'s FINAL stage is named <alias>. image-scan.yml calls
# it per built-image leg before building, because that name is load-bearing in a
# way nothing else would notice if it changed:
#
#   The built-image builds restore layers from a gha cache. `RUN apt-get update
#   && apt-get upgrade -y` has a stable command string and a stable parent, so
#   it CACHE-HITS forever — the scan then reads a runner stage upgraded against
#   whatever the security repo held the day that layer was first built.
#
#   Measured 2026-08-20 on this branch's first CI run: `#68 [runner 2/6] RUN
#   apt-get update && apt-get upgrade -y … CACHED`, and the built web image
#   carried CVE-2026-53612/-53613/-53614/-53615 that a fresh local build of the
#   same commit did not. The `.trivyignore` entries had been masking it, so the
#   "ZERO gate-blocking findings in all three built images" measurement was true
#   of a fresh build and not of the artifact CI actually scanned.
#
#   The fix is `no-cache-filters: runner` on those builds. That targets the
#   stage BY NAME, so renaming the final stage would silently restore the
#   staleness — a scan that reads an artifact nobody shipped, reporting green.
#   This mode is what makes that rename fail loudly instead.
#
# Exit codes: 0 every runtime stage upgrades (or the asserted name matches) ·
#             1 one or more does not (or the name does not match) ·
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

if [ "${1:-}" = "--assert-runtime-stage" ]; then
  df="${2:-}"; expected="${3:-}"
  [ -n "$df" ] && [ -n "$expected" ] \
    || die "usage: check-runtime-stage-upgrades.sh --assert-runtime-stage <dockerfile> <alias>"
  [ -f "$df" ] || die "no such Dockerfile: $df"

  actual=""
  while IFS=$'\t' read -r _idx _img alias _up; do actual="$alias"; done < <(parse_stages "$df")

  if [ "$actual" = "$expected" ]; then
    echo "ok   $df final stage is '$expected'"
    exit 0
  fi
  echo "::error file=$df::final stage is named '${actual:-<unnamed>}', not '$expected'." >&2
  cat >&2 <<EOF

image-scan.yml passes '$expected' to the built-image build's \`no-cache-filters\`,
which is what forces the runner stage — and therefore its apt-get upgrade / apk
upgrade — to REBUILD rather than restore from the gha cache. A name that does not
match matches no stage, the upgrade layer cache-hits again, and the built-image
scan silently starts reading an artifact nobody ships. It reports GREEN while
doing it, which is why this is an error and not a warning.

Fix: rename the final stage back to '$expected', or update the \`runtime-stage\`
value for this image in .github/workflows/image-scan.yml's built-images matrix.
EOF
  exit 1
fi

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
