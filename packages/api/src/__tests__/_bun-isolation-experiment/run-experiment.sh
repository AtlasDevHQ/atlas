#!/bin/bash
# Empirical experiment for `bun test --parallel` / `--isolate` isolation
# semantics (#2801, slice 5a).
#
# Forces all 10 fixture files into ONE worker (--max-workers=1) so leaker
# files share state with their observer counterpart. Each pair documents
# what it measures + what verdict pass/fail means in the file header.
#
# Requires bun >= 1.3.13 (`--parallel` / `--isolate` added there). On older
# bun (this repo's container is 1.3.11), the script exits 2 with a clear
# message — the experiment cannot run on a version that doesn't have the
# flags it's measuring.

set -euo pipefail

cd "$(dirname "$0")/../../.."  # → packages/api

if ! bun --version | grep -qE '^1\.3\.(1[3-9]|[2-9][0-9])'; then
  echo "::error::This experiment requires bun >= 1.3.13 (--parallel / --isolate were added there)." >&2
  echo "       Current bun: $(bun --version)" >&2
  echo "       Run on a host with 1.3.14 (matches .env pin) and re-execute." >&2
  exit 2
fi

EXPERIMENT_DIR="src/__tests__/_bun-isolation-experiment"

echo "─────────────────────────────────────────────────────────────────"
echo "  bun --isolate empirical experiment (#2801, slice 5a)"
echo "  bun: $(bun --version)"
echo "  fixture dir: $EXPERIMENT_DIR"
echo "─────────────────────────────────────────────────────────────────"
echo ""
echo "Running with --parallel --max-workers=1 (forces all files into one worker)..."
echo ""

# Run with --parallel --max-workers=1 to force shared worker. --pass-with-no-tests
# guards against the glob coming up empty (e.g. files renamed).
# Note: `bun test` matches `**/*.test.{ts,tsx,js,jsx}` by default; fixtures use
# `.experiment.ts` so they're skipped — invoke explicitly by directory.
set +e
bun test --parallel --max-workers=1 --pass-with-no-tests "$EXPERIMENT_DIR"
EXIT=$?
set -e

echo ""
echo "─────────────────────────────────────────────────────────────────"
echo "  Interpretation"
echo "─────────────────────────────────────────────────────────────────"
echo ""
echo "Pair 2 (env) should FAIL — confirms --max-workers=1 actually shares"
echo "the worker. If pair 2 passes, the harness is broken (files ran in"
echo "separate workers); ignore all other verdicts and investigate why."
echo ""
echo "Pair 4 (chdir) is the documented OS-state leak — expected to FAIL,"
echo "confirms the check-test-discipline.sh chdir rule is real."
echo ""
echo "Pairs 1, 3, 5 are the real questions. Their pass/fail decides slice 5b:"
echo "  - all pass → --isolate resets module mocks + globalThis; slice 5b"
echo "               is essentially a no-op (drop the rule, no codemod)"
echo "  - 1 fails  → mock.module() survives; slice 5b needs the mechanical"
echo "               afterAll(mock.restore) sweep across 365 files"
echo "  - 3 or 5 fails → globalThis leaks; tests storing spies/state at"
echo "               module scope need targeted patches"
echo ""
echo "Copy the verdict matrix above into a comment on issue #2801, then"
echo "5b can proceed with the right plan."

exit "$EXIT"
