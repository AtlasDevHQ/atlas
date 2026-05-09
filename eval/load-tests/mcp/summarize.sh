#!/usr/bin/env bash
# Render a markdown summary from one or more k6 `--summary-export` files.
# Used by `.github/workflows/load-test-mcp.yml` to populate
# $GITHUB_STEP_SUMMARY, and runnable locally on `results/*.json` to
# reproduce the same view without re-piecing it together by hand.
#
# Usage:
#   ./eval/load-tests/mcp/summarize.sh results/*.json
#   ./eval/load-tests/mcp/summarize.sh results/cold-start-20260507T040308Z.json
#
# Output: markdown to stdout. The CI step appends it to
# $GITHUB_STEP_SUMMARY; locally pipe it through `glow` or read it raw.
#
# Exit codes:
#   0 — at least one file rendered successfully.
#   2 — every input file was missing or unparseable. The CLI still emits
#       per-file warnings on stderr so a partial run (one scenario
#       failed mid-way, two succeeded) renders the surviving two and
#       returns 0.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <summary.json> [<summary.json>...]" >&2
  exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not on PATH. Install via your package manager or use the loadtest.sh README." >&2
  exit 127
fi

emit_scenario() {
  local file="$1"
  if [ ! -r "$file" ]; then
    echo "::warning::summarize.sh: cannot read $file — skipping" >&2
    return 1
  fi

  # File names are `<scenario>-<UTC>.json` per `loadtest.sh` (see the
  # SUMMARY_PATH derivation there). Strip the trailing timestamp so the
  # heading is `cold-start`, not `cold-start-20260507T040308Z`.
  local base scenario
  base="$(basename "$file" .json)"
  scenario="$(echo "$base" | sed -E 's/-[0-9]{8}T[0-9]{6}Z$//')"

  printf '\n### %s\n\n_Source: `%s`_\n\n' "$scenario" "$base.json"

  # Build the per-scenario markdown via a single jq invocation. Doing
  # this in jq (vs shelling out per metric) keeps the math + null
  # handling co-located with the data — partial summaries from a
  # k6-aborted run still render, with `—` standing in for missing
  # series rather than the script crashing on a `null * 100`.
  if ! jq -r '
    def fmt_ms($v): if $v == null then "—" else "\($v | floor) ms" end;
    def fmt_pct($v): if $v == null then "—" else "\(($v * 10000 | floor) / 100)%" end;
    def fmt_rate($v): if $v == null then "—" else "\(($v * 10 | floor) / 10) rps" end;
    def num($v): if $v == null then "—" else ($v | tostring) end;

    "| Counter | Value |\n| --- | --- |\n" +
    "| Iterations | \(num(.metrics.iterations.count)) |\n" +
    "| HTTP requests | \(num(.metrics.http_reqs.count)) (\(fmt_rate(.metrics.http_reqs.rate))) |\n" +
    "| Failure rate | \(fmt_pct(.metrics.http_req_failed.value)) |\n" +
    "| Checks pass rate | \(fmt_pct(.metrics.checks.value)) |\n\n" +
    "| Frame | P50 | P95 | P99 | max |\n| --- | --- | --- | --- | --- |\n" +
    (
      [
        ["initialize",        .metrics["http_req_duration{rpc:initialize}"]],
        ["tools/list",        .metrics["http_req_duration{rpc:tools/list}"]],
        ["tools/call",        .metrics["http_req_duration{rpc:tools/call}"]],
        ["http_req_duration", .metrics.http_req_duration]
      ]
      | map(select(.[1] != null))
      | map("| `\(.[0])` | \(fmt_ms(.[1]["p(50)"])) | \(fmt_ms(.[1]["p(95)"])) | \(fmt_ms(.[1]["p(99)"])) | \(fmt_ms(.[1].max)) |")
      | join("\n")
    ) + "\n"
  ' "$file"; then
    echo "::warning::summarize.sh: jq failed on $file — skipping" >&2
    return 1
  fi
}

printf '## MCP load test\n'

rendered=0
for f in "$@"; do
  if emit_scenario "$f"; then
    rendered=$((rendered + 1))
  fi
done

if [ "$rendered" -eq 0 ]; then
  echo "::error::summarize.sh: no input files rendered" >&2
  exit 2
fi
