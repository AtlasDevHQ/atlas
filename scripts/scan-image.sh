#!/usr/bin/env bash
# Scan one container image for known vulnerabilities and gate on the fixable ones.
#
# ── Policy ────────────────────────────────────────────────────────────────────
#
# BLOCKING   fixable HIGH and CRITICAL vulnerabilities. "Fixable" means the
#            vendor has published a fixed version, so a red gate here always
#            has an action attached to it: bump the pin.
#
# REPORTING  every FIXABLE finding, at every severity and every package type.
#            Emitted as SARIF for GitHub code scanning, where it is triageable
#            alongside CodeQL. Never fails the job.
#
# CENSUS     everything, unfixed included, printed to the job log. Not uploaded.
#
# Unfixed CVEs neither block nor raise an alert, deliberately, and it is the
# same reasoning at both surfaces: a signal nobody can action teaches people to
# ignore the surface carrying it. For the gate that means a red merge button
# with no fix behind it; for code scanning it meant 116 of 272 unique CVEs
# parked open forever, which is what buried a genuinely fixable 4-CRITICAL base
# image for weeks. An unfixed CRITICAL stays visible in the census above — that
# relocation is the point, and it is what makes dropping the alert honest
# rather than a suppression.
#
# SCOPE      The gate looks at OS packages only (--pkg-types os). Language
#            dependencies found inside the image — npm, Go modules — are
#            REPORTED but do not block.
#
#            That split follows who can act. A vulnerable OS package baked into
#            a runtime layer is the gap nothing else covers: CodeQL analyses
#            source, Dependabot reads manifests, and neither one sees it. That
#            is the gap #4822 exists to close, and it is what this gate blocks
#            on.
#
#            Library findings do NOT block, but the reason #4822 gave for that
#            was wrong and is corrected here (#4878): it said "Dependabot
#            watches the manifests and opens the fix PR." Atlas uses bun, and
#            `bun` is a separate Dependabot ecosystem from `npm` that does not
#            support security updates — no configuration makes Dependabot open
#            an npm advisory fix PR in this repo. For the whole window between
#            #4822 and #4878 this scanner was the only thing looking, while its
#            own header said something else owned it.
#
#            They still do not block, for a different reason: remediation is
#            manual (hand-authored `overrides` in the root package.json, plus
#            parent bumps), and part of the residual set has no expressible fix
#            at all, because bun honours only TOP-LEVEL overrides. Gating on
#            findings nobody can action is the same trap as gating on unfixed
#            CVEs. The full handoff — detection, visibility, remediation,
#            freshness — is documented in .github/workflows/image-scan.yml;
#            keep this note in sync with it rather than restating it.
#
#            They are still reported, because the image's resolved node_modules
#            is the surface that actually ships, and a finding visible in code
#            scanning is worth having even when this gate is not the right
#            place to enforce it.
#
# BASELINE   .trivyignore holds dated exemptions for fixable HIGH/CRITICAL OS
#            findings that cannot yet be cleared in a shipped image. It is
#            applied to the GATE pass only — never to the report pass — so a
#            merge-gate exemption can never become an invisibility cloak in code
#            scanning.
#
#            ⚠️ It is NOT empty. This header claimed "currently EMPTY: the
#            2026-08-12 runner-stage upgrades cleared all 11 original entries"
#            for the whole window in which the file carried first 10 and then 14
#            entries. No count is stated here now, deliberately — a number in
#            prose is a second thing to keep true and this one was not. Read
#            .trivyignore itself, which is where the entries and the rule for
#            adding one live.
#
#            ⚠️ "Applied to the gate only" is a statement about the BASELINE,
#            not a claim that the report pass shows everything — since
#            2026-08-12 it also drops unfixed findings. Those two filters have
#            different reasons and different compensating controls; do not
#            collapse them when editing this header.
#
# The practical effect of that split: this gate blocks *regressions*. A newly
# disclosed CVE, or one introduced by a dependency or base-image change, goes
# red on the PR that introduces it. Debt inherited from upstream is visible in
# code scanning and dated in .trivyignore instead of silently red forever.
#
# ⚠️ CALLERS. This script answers one question — "does THIS image carry a
# fixable HIGH/CRITICAL OS package" — and its exit code is that answer, nothing
# more. Whether the answer should BLOCK is a separate decision and does not
# live here:
#
#   built images   the verdict is the gate, on every trigger. image-scan.yml
#                  calls this script directly.
#   base images    the verdict is report-only unless the PR introduced or
#                  changed that base reference (#5361). image-scan.yml goes
#                  through scripts/base-image-gate.sh, which owns that policy.
#
# Keep it that way. Folding the base tier's report-only mode in here would put
# two different questions behind one exit code.
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
  --ignore-unfixed \
  --exit-code 0 \
  "$IMAGE"

echo "SARIF written to $SARIF (all severities, baseline not applied, FIXABLE only)"

# ── Why --ignore-unfixed landed on the REPORT pass too (2026-08-12) ───────────
#
# It was deliberately absent here until now, on the reasoning that "an unfixed
# CRITICAL is visible — it just does not stop a merge." The visibility half of
# that is worth keeping. The alert half stopped working:
#
#   Of 272 unique CVEs open across the images, 116 had no published fix. They
#   are not triageable — there is no version to move to, no override to write,
#   no decision to record. They sat in code scanning as permanent open alerts,
#   and their volume is what made the whole surface unreadable: a stale
#   caddy:2.10-alpine pin carrying 4 CRITICAL and 43 HIGH FIXABLE CVEs went
#   unnoticed for weeks underneath them.
#
# An alert nobody can action is not coverage, and at this ratio it actively
# buries the alerts that are. Same reasoning the gate pass already used — this
# just applies it one surface over.
#
# ⚠️ Unfixed findings are NOT dropped, they are relocated. The census pass below
# prints every one of them, unfiltered, into the job log on every run. That is
# the compensating control for what this flag removes, so if you ever delete the
# census, put --ignore-unfixed back under review at the same time.
echo
echo "──── census: ALL findings including unfixed (informational, never fails) ────"
echo "     Not uploaded to code scanning — see the note in this script for why."
trivy image \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --ignorefile /dev/null \
  --skip-db-update \
  --format table \
  --exit-code 0 \
  "$IMAGE"

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
  echo "      (library findings, if any, are in the SARIF report and are remediated by hand — see the SCOPE note above)"
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
