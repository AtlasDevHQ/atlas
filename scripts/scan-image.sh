#!/usr/bin/env bash
# Scan one container image for known vulnerabilities and gate on the fixable ones.
#
# ── Policy ────────────────────────────────────────────────────────────────────
#
# BLOCKING   fixable HIGH and CRITICAL vulnerabilities. "Fixable" means the
#            vendor has published a fixed version, so a red gate here always
#            has an action attached to it: bump the pin.
#
# REPORTING  everything else — every severity, including vulnerabilities with
#            no fix available. Emitted as SARIF for GitHub code scanning, where
#            it is triageable alongside CodeQL. Never fails the job.
#
# Unfixed CVEs do not block, deliberately. A gate that goes red for something
# nobody can action teaches people to ignore it, and an ignored gate is worse
# than no gate at all: it reads as coverage while providing none. They are
# still reported, so an unfixed CRITICAL is visible — it just does not stop a
# merge that had nothing to do with it.
#
# SCOPE      The gate looks at OS packages only (--pkg-types os). Language
#            dependencies found inside the image — npm, Go modules — are
#            REPORTED but do not block.
#
#            That split follows who can act. A vulnerable OS package baked into
#            a runtime layer is the gap nothing else covers: CodeQL analyses
#            source, Dependabot reads manifests, and neither one sees it. That
#            is the gap #4822 exists to close, and it is what this gate blocks
#            on. Library findings already have an owner — Dependabot watches the
#            manifests and opens the fix PR — so gating on them here would
#            create two red surfaces for one problem and block unrelated PRs on
#            a dependency bump somebody else's PR is already making. #4822
#            scoped dependency scanning out for exactly this reason.
#
#            They are still reported, because the image's resolved node_modules
#            is not identical to the manifest Dependabot reads, and a finding
#            visible in code scanning is worth having even when this gate is not
#            the right place to enforce it.
#
# BASELINE   .trivyignore holds the fixable HIGH/CRITICAL findings that already
#            existed in the third-party base images when this gate was added.
#            It is applied to the GATE pass only — never to the report pass — so
#            code scanning always shows the true picture while pre-existing debt
#            in an image Atlas does not build cannot block an unrelated PR. Read
#            .trivyignore itself for why each entry is there and when it expires.
#
# The practical effect of that split: this gate blocks *regressions*. A newly
# disclosed CVE, or one introduced by a dependency or base-image change, goes
# red on the PR that introduces it. Debt inherited from upstream is visible in
# code scanning and dated in .trivyignore instead of silently red forever.
#
# Only the `vuln` scanner runs. Trivy's secret and misconfiguration scanners
# overlap with tooling Atlas already has (GitHub secret scanning with push
# protection, and the check-*.sh drift gates), and their findings would arrive
# without an owner.
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#
#   scan-image.sh <image-ref> <category> [sarif-out-dir]
#
#     image-ref      image to scan; must already be present locally or pullable
#     category       stable slug identifying this target. Becomes the SARIF
#                    category, which is how GitHub code scanning keeps results
#                    from different images from overwriting each other.
#     sarif-out-dir  where to write <category>.sarif (default: ./trivy-results)
#
# Env:
#   TRIVY_BASELINE   path to the gate-pass ignorefile
#                    (default: <repo-root>/.trivyignore). Set to /dev/null to
#                    scan with no baseline at all — the adversarial fixtures do
#                    this so a fixture CVE can never be masked by the baseline.
#
# Exit: 0 clean (by the blocking policy above), 1 fixable HIGH/CRITICAL found.

set -euo pipefail

IMAGE="${1:-}"
CATEGORY="${2:-}"
OUT_DIR="${3:-./trivy-results}"

if [ -z "$IMAGE" ] || [ -z "$CATEGORY" ]; then
  echo "usage: scan-image.sh <image-ref> <category> [sarif-out-dir]" >&2
  exit 2
fi

if ! command -v trivy >/dev/null 2>&1; then
  echo "::error::trivy not found on PATH — the workflow must install it before calling this script" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="${TRIVY_BASELINE:-$REPO_ROOT/.trivyignore}"
if [ ! -f "$BASELINE" ] && [ "$BASELINE" != "/dev/null" ]; then
  echo "::error::baseline ignorefile not found at $BASELINE" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
SARIF="$OUT_DIR/$CATEGORY.sarif"

echo "──── scanning $IMAGE (category: $CATEGORY) ────"
echo "     gate baseline: $BASELINE"

# Report pass FIRST, and with NO baseline. Two reasons for the ordering and the
# empty ignorefile:
#   - first, because if the gate ran first it would exit non-zero under `set -e`
#     and the SARIF would never be written — findings would fail the build and
#     then vanish, which is the worst of both worlds;
#   - with no baseline, because code scanning is the reporting surface and must
#     show every finding. Suppressing baselined CVEs here would turn a
#     merge-gate exemption into an invisibility cloak.
trivy image \
  --scanners vuln \
  --format sarif \
  --output "$SARIF" \
  --ignorefile /dev/null \
  --exit-code 0 \
  "$IMAGE"

echo "SARIF written to $SARIF (unfiltered — all severities, baseline not applied)"

# Gate pass. --skip-db-update reuses the DB the report pass just fetched, so
# this is a second pass over cached data rather than a second download.
rc=0
trivy image \
  --scanners vuln \
  --pkg-types os \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --ignorefile "$BASELINE" \
  --skip-db-update \
  --format table \
  --exit-code 1 \
  "$IMAGE" || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "PASS: no fixable HIGH/CRITICAL OS-package vulnerabilities in $IMAGE"
  echo "      (library findings, if any, are in the SARIF report and are Dependabot's remit — see the SCOPE note above)"
  exit 0
fi

if [ "$rc" -ne 1 ]; then
  # Trivy reserves exit 1 for "vulnerabilities found" (that is what --exit-code
  # sets). Anything else is the scanner itself failing — a DB fetch error, an
  # unreadable image. Surface it as a distinct failure instead of reporting a
  # tool outage as a clean or dirty scan.
  echo "::error::trivy exited $rc scanning $IMAGE — scanner failure, not a vulnerability verdict" >&2
  exit "$rc"
fi

echo "::error::Fixable HIGH/CRITICAL OS-package vulnerabilities found in $IMAGE ($CATEGORY)"
echo "::error::A fixed package version exists upstream. Bump the base-image pin, rebuild against a refreshed base, or upgrade the package in the runner stage."
exit 1
