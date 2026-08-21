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
# external image reference — by `resolve_runtime_stage` in
# scripts/lib/dockerfile-stages.sh, which is the one traversal both image-scan
# gates use.
#
# This is discovery, not enumeration: a new Dockerfile anywhere in the tree
# enters the scan matrix automatically. That is the point — the failure mode
# this guards against is someone adding an image nobody remembered to scan.
#
# Usage: list-runtime-base-images.sh
# Env:   BASE_IMAGE_ROOT — tree to scan (default: repo root). Used by the tests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BASE_IMAGE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# list_dockerfiles + resolve_runtime_stage. Shared with
# check-runtime-stage-upgrades.sh so the two gates can never enumerate different
# file sets, or resolve the same Dockerfile to different runtime stages — read
# that file's header for why either would be silent.
# shellcheck source=lib/dockerfile-stages.sh
. "$SCRIPT_DIR/lib/dockerfile-stages.sh"

dockerfiles=()
while IFS= read -r df; do
  dockerfiles+=("$df")
done < <(list_dockerfiles "$ROOT")

if [ ${#dockerfiles[@]} -eq 0 ]; then
  echo "::error::No Dockerfiles found under $ROOT — the discovery glob has rotted" >&2
  exit 1
fi

images=()
for df in "${dockerfiles[@]}"; do
  # The traversal lives in the lib so this gate and check-runtime-stage-upgrades.sh
  # can never resolve different runtime stages for the same Dockerfile. It fails
  # closed on an unresolvable reference and has already said why.
  resolve_runtime_stage "$df" || exit 1
  # `scratch` is not a real image — nothing to pull, nothing to scan.
  [ "$RUNTIME_BASE" = "scratch" ] && continue
  images+=("$RUNTIME_BASE")
done

if [ ${#images[@]} -eq 0 ]; then
  echo "::error::Found ${#dockerfiles[@]} Dockerfile(s) but resolved zero runtime base images" >&2
  exit 1
fi

printf '%s\n' "${images[@]}" | sort -u
