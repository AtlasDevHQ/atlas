#!/usr/bin/env bash
# check-runtime-stage-upgrades.sh — every runtime stage in the tree must upgrade
# its OS packages (#5361).
#
# ## Why this is the premise, not a nicety
#
# The image-scan gate stopped blocking on the absolute CVE state of an unchanged
# base image (#5361). That is only safe because of one measured fact:
#
#   every runtime stage runs `apt-get upgrade` / `apk upgrade`
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
# Not "the same thing scripts/list-runtime-base-images.sh means by it" — the
# SAME CODE. `resolve_runtime_stage` in scripts/lib/dockerfile-stages.sh is the
# one traversal both gates call, because a shared parser with two hand-written
# chain walks was still free to give two different answers for one Dockerfile.
#
# It is the LAST stage in the file, which is Docker's default build target, with
# `FROM base AS runner`-style aliases walked back to the external image. An
# upgrade ANYWHERE on that chain counts, because the runtime stage inherits
# those layers. A build-only stage that is not on the chain does not count and
# does not need one: nothing it installs ships.
#
# ## What counts as an upgrade
#
#   apt-get upgrade · apt upgrade · apk upgrade · apt-get dist-upgrade
#
# with any flags in between (`apk -U upgrade`, `apt-get -y upgrade`), inside a
# RUN instruction, with comments cut. The exact rule and the reason for each
# restriction live with the parser in scripts/lib/dockerfile-stages.sh — one
# copy, one place to keep true.
#
# ⚠️ This paragraph used to say a comment "cannot satisfy the guard" and that
# the error direction is "never a false pass". Both were false as written: only
# WHOLE-LINE comments were cut and any instruction matched, so
# `LABEL x="apk upgrade"` and `RUN echo hi   # apt-get upgrade later` both
# passed. On the guard the whole #5361 narrowing rests on, that is the one
# direction that matters. Fixed, with fixtures for both forms.
#
# There is deliberately NO in-file suppression marker. A base with no package
# manager (distroless, scratch-adjacent) genuinely cannot satisfy this, and the
# right response is a reviewed edit to this guard naming that base — not a
# comment any author can add to silence a security premise under time pressure.
# `scratch` itself is the one exception, and it is exempt by construction: it
# contains no packages to upgrade.
#
# ## The second mode
#
#   check-runtime-stage-upgrades.sh --assert-final-stage-upgrades <df> <alias>
#
# Same question as the sweep above — does the stage that ships upgrade? — asked
# of one file and one stage instead of the whole tree, which is why it lives
# here rather than in a script of its own. Asserts that <dockerfile>'s FINAL
# stage is named <alias> AND that that stage's OWN body runs the upgrade.
# image-scan.yml calls it per built-image leg before building, because both are
# load-bearing in a way nothing else would notice if either changed:
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
#   The fix is `no-cache-filters: runner` on those builds. That busts exactly ONE
#   named stage, which makes two edits silently restore the staleness:
#
#     renaming the final stage        `runner` then matches nothing
#     moving the upgrade UP a stage   e.g. into `base`. The main guard still
#                                     passes — an ancestor's upgrade genuinely
#                                     does reach the artifact — but the busted
#                                     stage no longer contains it, so the
#                                     upgrade layer cache-hits again.
#
#   Either one leaves the gate of record scanning an artifact nobody shipped and
#   reporting it GREEN. This mode is what makes both fail loudly instead, which
#   is why it asserts the upgrade's LOCATION and not just the name.
#
# Exit codes: 0 every runtime stage upgrades (or the assertion holds) ·
#             1 one or more does not (or the assertion fails) ·
#             2 this gate could not look (no Dockerfiles, unparseable file).
#
# Env: BASE_IMAGE_ROOT — tree to check (default: repo root). Same seam name and
#      same meaning as list-runtime-base-images.sh; used by the fixtures.
#
# Adversarial fixtures: scripts/__tests__/scan-image.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BASE_IMAGE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# list_dockerfiles + resolve_runtime_stage — shared with
# list-runtime-base-images.sh on purpose, so the set of files scanned and the
# set of files checked can never diverge, and so both resolve the same runtime
# stage for the same Dockerfile.
# shellcheck source=lib/dockerfile-stages.sh
. "$SCRIPT_DIR/lib/dockerfile-stages.sh"

die() { echo "::error::[runtime-stage-upgrades] $1" >&2; exit 2; }

if [ "${1:-}" = "--assert-final-stage-upgrades" ]; then
  df="${2:-}"; expected="${3:-}"
  [ -n "$df" ] && [ -n "$expected" ] \
    || die "usage: check-runtime-stage-upgrades.sh --assert-final-stage-upgrades <dockerfile> <alias>"
  [ -f "$df" ] || die "no such Dockerfile: $df"

  resolve_runtime_stage "$df" || exit 1

  problems=()
  [ "$RUNTIME_FINAL_ALIAS" = "$expected" ] \
    || problems+=("final stage is named '${RUNTIME_FINAL_ALIAS:-<unnamed>}', not '$expected'")
  # RUNTIME_FINAL_UPGRADES, not RUNTIME_UPGRADES: an ancestor's upgrade ships,
  # but it is not in the stage no-cache-filters rebuilds.
  [ "$RUNTIME_FINAL_UPGRADES" = "1" ] \
    || problems+=("the '${RUNTIME_FINAL_ALIAS:-<unnamed>}' stage does not itself run apt-get upgrade / apk upgrade")

  if [ "${#problems[@]}" -eq 0 ]; then
    echo "ok   $df — final stage '$expected' runs the upgrade itself"
    exit 0
  fi

  for problem in "${problems[@]}"; do
    echo "::error file=$df::$problem" >&2
  done
  cat >&2 <<EOF

image-scan.yml passes '$expected' to the built-image build's \`no-cache-filters\`,
which busts exactly that one stage so its apt-get upgrade / apk upgrade REBUILDS
rather than restoring from the gha cache. Both halves matter:

  the NAME     a name matching no stage busts nothing.
  the UPGRADE  an upgrade that has moved into an ancestor stage still reaches
               the artifact — so the sweep above stays green — but it is no
               longer in the stage being busted, so its layer cache-hits again.

Either way the built-image scan silently starts reading an artifact nobody
ships, and reports GREEN while doing it. That is why this is an error.

Fix: keep the upgrade in the final stage and keep that stage named '$expected',
or update the \`runtime-stage\` value for this image in
.github/workflows/image-scan.yml's built-images matrix.
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

  # One traversal, shared with list-runtime-base-images.sh, so the set of images
  # scanned and the set of stages checked can never disagree about which stage
  # is the runtime stage. Fails closed and has already said why.
  resolve_runtime_stage "$df" || exit 1

  # `scratch` holds no packages, so there is nothing to upgrade and nothing a
  # CVE could live in. Exempt by construction rather than by exception.
  if [ "$RUNTIME_BASE" = "scratch" ]; then
    printf '  --   %-52s %s\n' "$rel" "scratch — no packages to upgrade"
    continue
  fi

  CHECKED=$((CHECKED + 1))
  if [ "$RUNTIME_UPGRADES" = "1" ]; then
    printf '  ok   %-52s %s\n' "$rel" "$RUNTIME_BASE"
  else
    printf '  FAIL %-52s %s\n' "$rel" "$RUNTIME_BASE"
    echo "::error file=$rel::runtime stage (chain: ${RUNTIME_CHAIN[*]}) on '$RUNTIME_BASE' never runs apt-get upgrade / apk upgrade — a base-layer CVE in it SHIPS." >&2
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
