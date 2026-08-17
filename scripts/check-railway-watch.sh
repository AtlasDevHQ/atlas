#!/usr/bin/env bash
# Verify every repo-relative COPY source in each deploy Dockerfile — AND every
# directory the resulting image actually contains, including the workspace
# dependency closure the broad `COPY . .` drags in — is covered by that
# service's railway.json watchPatterns.
#
# The F-10 / PR #1758 incident: a bun.lock change went unshipped because
# api / api-eu / api-apac / web did not list "bun.lock" in watchPatterns,
# so Railway didn't redeploy on the merge. PR #1760 added the missing
# entries. This check keeps a future service from drifting the same way.
#
# ## The second half of that class, and why the first half could not see it (#4738)
#
# `watchPatterns` is a HAND-MAINTAINED list, and a change confined to a
# bundled-but-unwatched package produces `skippedReason: "No changes to watched
# files"` on the `prod` push and SILENTLY NEVER DEPLOYS. Measured on
# `packages/mcp/**` while shipping v0.0.63 (#4733/#4734, fixed in #4737): all
# four tag-gated services skipped the prod push because the only changes were in
# a package nobody had listed.
#
# The COPY-source arm above cannot catch that, and the reason is structural: the
# api Dockerfile's builder stage does `COPY . .`, which this script SKIPS as a
# "broad-context copy, not useful to match". That one line bundles every package
# in the repo, so the set of files that can change the image is not the set of
# COPY sources — it is the workspace dependency closure of whatever the runtime
# image ships. Measured at the time of writing: `packages/okf-bundle` is copied
# into the api runtime image by name and appeared in NO region's watchPatterns.
#
# So a broad-COPY service gets two extra assertions, both DERIVED rather than
# enumerated:
#
#   IMAGE CONTENT   — every `COPY --from=<stage> /app/<path>` path is a thing the
#                     runtime image contains, so a change to it changes the
#                     image and must trigger a redeploy.
#   WORKSPACE CLOSURE — every runner-copied path that IS a workspace package root
#                     contributes its transitive `workspace:*` runtime closure.
#                     This is the arm that catches a dependency ADDED to
#                     `packages/api` before anyone remembers the deploy config,
#                     which is the shape #4737 fixed by hand.
#
# ⚠️ Coverage is tested with a SYNTHETIC PROBE FILE under each required
# directory, not with the bare directory path. `packages/**/package.json` matches
# the manifest and nothing else, and a bare `packages/foo` entry matches the
# directory while watching none of its source — both would read as coverage
# against a directory-path test. The probe asks the question that matters: would
# a change to a SOURCE FILE in here redeploy?
#
# Pass conditions:
#   - Every `COPY <src> <dst>` source in the Dockerfile is covered by a
#     watchPatterns entry (exact match, X/** prefix, or X* prefix).
#   - `COPY --from=<stage>` lines are skipped BY THE COPY-SOURCE ARM (they are
#     intra-image) and read by the image-content arm instead.
#   - `COPY . .` is skipped by the COPY-source arm — and is the TRIGGER for the
#     two arms below, because it is what bundles unwatched source.
#   - Services without watchPatterns warn (Railway rebuilds on every push —
#     wasteful but not broken). Services without a Dockerfile builder
#     (NIXPACKS etc.) are skipped entirely.
#
# Adversarial fixtures: scripts/__tests__/check-railway-watch.test.sh

set -euo pipefail

# ⚠️ A SEAM, so `scripts/__tests__/check-railway-watch.test.sh` can point this at
# a throwaway tree. Without it the new closure arm would only ever be runnable
# against the real repo, where it currently passes — and a drift detector nobody
# can make fail is not a detector.
ROOT="${RAILWAY_WATCH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
ERRORS=0
WARNINGS=0
# ⚠️ **HOW MANY SERVICES THIS RUN ACTUALLY EXAMINED, because without it the
# script prints its clean NEGATIVE after reading nothing.** `nullglob` is not set,
# so an empty `deploy/*/railway.json` glob runs the loop once with the literal
# unexpanded pattern, `[ -f ]` fails, `continue` fires, and execution falls
# straight to `OK: every deploy Dockerfile COPY source and bundled workspace path
# is covered` — the exact sentence a reviewer greps for, on a run that verified
# zero services.
#
# Reachable by: a typo'd or stale `RAILWAY_WATCH_ROOT` (which this change
# introduces — before it, `ROOT` was computed and could not be wrong), `deploy/`
# moving, a sparse checkout, or every service switching off DOCKERFILE. A green
# row for a gate that read no file is strictly worse than no gate, because it
# retires the reviewer's suspicion. Both sibling gates in this change have this
# floor (`check-lighthouse-report-paths.sh` dies on a missing input,
# `check-mutation-tables.sh` exits 1 with "did the directory move?"); this one
# shipped without.
SERVICES=0
# "I could not look" is a THIRD outcome, distinct from "a path is unwatched".
# Counted separately so the final message does not send an operator to edit a
# watchPatterns array that is fine — the same reason `BaselineProblem.kind` exists
# one directory over.
CANNOT_LOOK=0
# Non-DOCKERFILE services this run did not examine. Counted so the final verdict
# cannot understate what it looked at: the skip printed an honest per-service
# disclosure and touched no counter, so `OK: all $SERVICES service(s)` named a
# number smaller than the services on disk with no hint that others existed.
UNVERIFIED_SVCS=0

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

  # Build a regex: escape specials, then handle glob wildcards.
  # Sentinels disambiguate pattern classes during substitution so they
  # don't interact — §§§ for middle /**/ (zero-or-more segments), §§ for
  # other **, § for single * (single segment).
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
  # Middle /**/ must match zero OR more segments between the slashes,
  # matching micromatch. packages/**/package.json therefore matches
  # packages/package.json as well as packages/api/package.json.
  re="${re//\/\*\*\//§§§}"
  re="${re//\*\*/§§}"
  re="${re//\*/§}"
  re="${re//§§§/(\/|\/.*\/)}"
  re="${re//§§/.*}"
  re="${re//§/[^/]*}"
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
  copy_source_tokens "$dockerfile" | while IFS= read -r src; do
    # Skip the broad-context copy — via the SHARED predicate, so this arm and
    # `has_broad_copy` cannot disagree about what "broad" means.
    if is_broad_copy_token "$src"; then
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
}

# Every SOURCE token of every non-`--from` COPY, one per line, broad ones
# INCLUDED.
#
# ⚠️ **THE ACTUAL SHARED READING, and it exists because the previous attempt at
# sharing was a comment rather than a mechanism.** `is_broad_copy_token` was
# introduced to be "ONE PREDICATE, read by BOTH arms" — and was called from
# `extract_sources` only, while `has_broad_copy` kept an independent grep. The two
# then disagreed on the DESTINATION spelling: that regex accepted only `.`, `./`,
# `/` or empty as a destination, so `COPY . /app` (with `WORKDIR /app` — the more
# common Docker idiom, and semantically identical to `COPY . .`) was skipped by
# this arm as broad AND reported by the other as "no broad `COPY . .`". Both arms
# stood down, with a stated negative telling the next reader not to look: #4738
# reopened by a one-token edit.
#
# Tokenising once and letting both arms consume the tokens makes the sharing
# structural. Broadness is now a property of a SOURCE token, which is what it
# always was — the destination never mattered.
copy_source_tokens() {
  local dockerfile="$1"
  grep -E '^COPY[[:space:]]' "$dockerfile" | while IFS= read -r line; do
    # Skip --from= (intra-image copy); the image-content arm reads those.
    if [[ "$line" == *"--from="* ]]; then
      continue
    fi
    line="${line#COPY}"
    line="${line# }"
    # Drop --chown=...:... and any other flag — WITH OR WITHOUT a value.
    # ⚠️ The `=value` was mandatory here, so a VALUELESS flag survived and became
    # a "COPY source": `COPY --link . .` reported `'--link' is not covered by any
    # watchPattern`, a false positive naming a flag as a file. BuildKit flags are
    # available today — `deploy/docs/Dockerfile` opts into
    # `# syntax=docker/dockerfile:1.7`.
    # shellcheck disable=SC2001
    line=$(echo "$line" | sed -E 's/--[a-zA-Z-]+(=[^[:space:]]+)?[[:space:]]+//g')
    # Last whitespace-separated word is the destination; drop it.
    # shellcheck disable=SC2206
    local words=($line)
    [ "${#words[@]}" -ge 2 ] || continue
    unset "words[${#words[@]}-1]"
    local src
    for src in "${words[@]}"; do
      [ -n "$src" ] && echo "$src"
    done
  done
}

# Extract watchPatterns entries from a railway.json, one per line.
# Uses a simple awk pass since we know the JSON layout — no jq dependency.
extract_watch_patterns() {
  local railway_json="$1"
  # Capture everything between "watchPatterns": [ and the matching ]
  # then pull out every quoted string on each line. Looping on match() —
  # a single `if (match(...))` only captures the first string per line,
  # which would silently drop coverage if a formatter collapsed the
  # array onto one line.
  awk '
    /"watchPatterns"/,/]/ {
      line = $0
      while (match(line, /"[^"]+"/)) {
        s = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
        if (s == "\"watchPatterns\"") continue
        gsub(/"/, "", s)
        print s
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

# Extract dockerfileContext from railway.json. Empty string if absent —
# callers should default to the railway.json's own directory.
extract_dockerfile_context() {
  local railway_json="$1"
  awk '
    /"dockerfileContext"/ {
      if (match($0, /"dockerfileContext"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        s = substr($0, RSTART, RLENGTH)
        sub(/^"dockerfileContext"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        print s
        exit
      }
    }
  ' "$railway_json"
}

# Whether a Dockerfile carries the broad `COPY . .` that bundles every package
# in the repo. That line is the TRIGGER for the two arms below: it is what makes
# the set of change-relevant files bigger than the set of COPY sources, and the
# COPY-source arm skips it by design.
# ⚠️ ONE PREDICATE, read by BOTH arms, because two spellings of "the broad copy"
# is a live false negative. `extract_sources` skips a source token of `.` OR `./`;
# this recognised only the bare `COPY . .`. So `COPY ./ ./`, `COPY . ./`, or
# `COPY --link . .` was skipped by the COPY-source arm (nothing to check) AND
# reported "no broad `COPY . .` — the workspace-closure arm does not apply" — both
# arms standing down while the broad copy sat there bundling every package in the
# repo, with a STATED NEGATIVE telling the next reader not to look. That is the
# #4737 silent-skip class reopened by a whitespace or flag edit to a Dockerfile.
#
# `deploy/docs/Dockerfile` already opts into `# syntax=docker/dockerfile:1.7`, so
# `--link` is available today.
is_broad_copy_token() { # is_broad_copy_token TOKEN
  case "${1%/}" in
    "." | "") return 0 ;;
    *) return 1 ;;
  esac
}

has_broad_copy() {
  local src
  while IFS= read -r src; do
    if is_broad_copy_token "$src"; then return 0; fi
  done < <(copy_source_tokens "$1")
  return 1
}

# Repo paths the RUNTIME image contains, from the runner stage's
# `COPY --from=<stage> [--chown=…] /app/<path>` lines.
#
# These are intra-image copies, so the COPY-source arm skips them — correctly,
# it is asking a different question. Here they answer: what does the shipped
# image actually consist of? A change to any of it changes the image.
extract_image_paths() {
  local dockerfile="$1"
  # ⚠️ TOLERANT OF FLAG ORDER, EXTRA FLAGS, AND MULTIPLE SOURCES, because the
  # narrow pattern DROPPED lines silently and nothing knew how long the list
  # should have been. MEASURED against the real Dockerfiles: `COPY --from=deps
  # /app ./` and `COPY --from=node:24-trixie-slim@sha256:… /usr/local/bin/node`
  # were both missed — the second because a digest-pinned stage name contains `:`
  # and `.`. One reordering to `--chown=… --from=…`, or a BuildKit `--link`, and a
  # whole package drops out of `closure_roots`, taking its entire transitive
  # closure with it, while the gate prints `All N … covered`.
  #
  # The floor in the caller is what makes that non-silent: a shorter list than the
  # Dockerfile declares is an ERROR, not a shorter answer.
  runner_copy_lines "$dockerfile" \
    | grep -oE '(^|[[:space:]])(--[a-zA-Z-]+(=[^[:space:]]+)?[[:space:]]+)*/app/[^[:space:]]+' \
    | grep -oE '/app/[^[:space:]]+' \
    | sed -E 's#^/app/##' \
    | sed -E 's#/+$##' \
    | grep -v '^node_modules' \
    | sort -u
}

# Every line that copies FROM ANOTHER STAGE. Deliberately loose — the loosest
# thing that is still unambiguously a runner copy — and SHARED by the extractor
# and the counter, so the floor below compares two readings of the same line set
# rather than two guesses at which lines exist.
#
# ⚠️ A LINE CONTINUATION (`COPY --from=x \` then the paths on the next line)
# defeats BOTH, because grep is line-based. That is a shared blind spot the floor
# cannot see, and it is recorded rather than papered over: no Dockerfile here uses
# one for a COPY, and closing it needs a real parser.
runner_copy_lines() {
  grep -E '^[[:space:]]*COPY[[:space:]].*--from=' "$1" || true
}

# How many `/app/…` SOURCE TOKENS the runner copies declare, counted loosely.
#
# ⚠️ TOKENS, not lines, and the difference is a real dropped path. The extractor's
# pipeline truncates each line at its FIRST `/app/` token, so
# `COPY --from=x /app/a /app/b ./dst` yielded only `/app/a` — and a line-based
# floor counted that line once on both sides, agreed, and stayed silent while
# `/app/b` and its whole transitive closure vanished. Comparing token counts makes
# the two readings commensurable.
count_declared_image_tokens() {
  # ⚠️ NORMALISED AND DEDUPED, matching `extract_image_paths`' own `sed`+`sort -u`.
  # Comparing a deduped set against a RAW count made a duplicated token — the same
  # `/app/x` copied from two stages, or `/app/x` beside `/app/x/` — read as a
  # shortfall, so a healthy Dockerfile got `exit 2` and "Fix the extractor, not
  # the Dockerfile": a false red pointing at a working gate. Not live today (every
  # `/app/…` token in the four deploy Dockerfiles is distinct), but the floor's
  # value is that it fires only on a real under-read.
  runner_copy_lines "$1" \
    | grep -oE '[[:space:]]/app/[^[:space:]]+' \
    | sed -E 's#^[[:space:]]*##; s#/+$##' \
    | LC_ALL=C sort -u \
    | grep -c . || true
}

# The transitive workspace closure of a set of package directories.
#
# ⚠️ MEMBERSHIP IS BY NAME, not by the `workspace:*` protocol, and that is the
# correction that makes this arm complete rather than nearly so. Every plugin
# declares `"@useatlas/plugin-sdk": ">=0.0.1"` in peerDependencies — a RANGE, not
# a protocol — while the image copies `packages/plugin-sdk` in and the boot graph
# hard-fails without it. A closure built by grepping `workspace:*` misses it.
# bun links by name and ignores range satisfaction (`packages/react` asks for
# `@useatlas/types@^0.1.0` against a workspace at 0.10.0 and still gets the
# workspace), so name membership is the rule bun itself applies.
#
# `peerDependencies` and `optionalDependencies` are therefore read alongside
# `dependencies`. `devDependencies` are NOT: they do not ship.
#
# The workspace set comes from the root `package.json`'s own `workspaces` globs,
# so adding a workspace directory needs no edit here.
workspace_closure() {
  local roots="$1"
  ROOTS="$roots" WS_ROOT="$ROOT" bun -e '
    import { readdirSync, existsSync, readFileSync } from "node:fs";
    const root = process.env.WS_ROOT;
    const rootPkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    const globs = rootPkg.workspaces ?? [];
    if (globs.length === 0) {
      process.stderr.write("root package.json declares no workspaces — the closure would be empty\n");
      process.exit(1);
    }
    /** dir (repo-relative) for every workspace package, keyed by package name. */
    const byName = new Map();
    for (const g of globs) {
      const dirs = g.endsWith("/*")
        ? readdirSync(`${root}/${g.slice(0, -2)}`, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => `${g.slice(0, -2)}/${e.name}`)
        : [g];
      for (const d of dirs) {
        const p = `${root}/${d}/package.json`;
        if (!existsSync(p)) continue;
        const name = JSON.parse(readFileSync(p, "utf8")).name;
        if (typeof name === "string" && !byName.has(name)) byName.set(name, d);
      }
    }
    const depsOf = (dir) => {
      const p = `${root}/${dir}/package.json`;
      if (!existsSync(p)) return [];
      const j = JSON.parse(readFileSync(p, "utf8"));
      const out = new Set();
      for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const name of Object.keys(j[key] ?? {})) {
          const d = byName.get(name);
          if (d !== undefined) out.add(d);
        }
      }
      return [...out];
    };
    const seen = new Set();
    const frontier = (process.env.ROOTS ?? "").split("\n").filter((s) => s !== "");
    for (const r of frontier) seen.add(r);
    while (frontier.length > 0) {
      for (const d of depsOf(frontier.pop())) {
        if (!seen.has(d)) { seen.add(d); frontier.push(d); }
      }
    }
    process.stdout.write([...seen].sort().join("\n"));
  '
}

# --- main ---
for railway_json in "$ROOT"/deploy/*/railway.json; do
  [ -f "$railway_json" ] || continue
  svc="$(basename "$(dirname "$railway_json")")"
  rel_json="${railway_json#"$ROOT"/}"

  builder=$(extract_builder "$railway_json")
  if [ "$builder" != "DOCKERFILE" ]; then
    # ⚠️ Say what is UNVERIFIED, not merely that we skipped. `www` is NIXPACKS
    # with `buildCommand: "bun install && bun run --filter '@atlas/www' build"` —
    # and that `bun install` makes the image's inputs the dependency closure in
    # exactly the way `COPY . .` does, so the closure argument applies to it
    # verbatim. It has no workspace dependency TODAY (checked), which is why this
    # is a disclosure rather than a gap; the moment it gains one, nothing here
    # notices.
    echo "$svc: builder=${builder:-unknown} — SKIPPED; only DOCKERFILE builds are checked, so its"
    echo "  watchPatterns are UNVERIFIED. A NIXPACKS buildCommand that installs the workspace has the"
    echo "  same #4738 exposure as a broad COPY."
    UNVERIFIED_SVCS=$((UNVERIFIED_SVCS + 1))
    continue
  fi

  dockerfile_rel=$(extract_dockerfile_path "$railway_json")
  if [ -z "$dockerfile_rel" ]; then
    echo "::error file=$rel_json::dockerfilePath missing for DOCKERFILE builder"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Railway resolves dockerfilePath relative to dockerfileContext. Resolve
  # the same way: context (default = railway.json's directory) → Dockerfile.
  # Fall back to repo-root-relative if the context-relative resolution
  # doesn't exist, because Atlas's historical configs use both shapes
  # interchangeably (context="../.." + root-relative dockerfilePath works
  # either way, but a future service may not).
  svc_dir="$(dirname "$railway_json")"
  context_raw=$(extract_dockerfile_context "$railway_json")
  if [ -n "$context_raw" ]; then
    context_abs="$(cd "$svc_dir" 2>/dev/null && cd "$context_raw" 2>/dev/null && pwd)" || context_abs=""
  else
    context_abs="$svc_dir"
  fi

  dockerfile_abs=""
  if [ -n "$context_abs" ] && [ -f "$context_abs/$dockerfile_rel" ]; then
    dockerfile_abs="$context_abs/$dockerfile_rel"
  elif [ -f "$ROOT/$dockerfile_rel" ]; then
    dockerfile_abs="$ROOT/$dockerfile_rel"
  fi

  if [ -z "$dockerfile_abs" ]; then
    echo "::error file=$rel_json::dockerfilePath '$dockerfile_rel' not found relative to context '${context_raw:-<default>}' or repo root"
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
  SERVICES=$((SERVICES + 1))
  missing_for_svc=0
  mapfile -t sources < <(extract_sources "$dockerfile_abs")
  # ⚠️ A VACUITY FLOOR on the OLDER arm too. `All 0 COPY sources covered` is a
  # clean line for zero assertions, reachable by anything that defeats the
  # `^COPY` anchor — leading whitespace after a reformat, a heredoc `COPY <<EOF`.
  # The new arm got a floor; the arm it sits beside in the same loop did not.
  if [ "${#sources[@]}" -eq 0 ]; then
    echo "::error file=$rel_json::no COPY sources parsed from $dockerfile_rel — the COPY-source arm verified NOTHING for this service."
    CANNOT_LOOK=$((CANNOT_LOOK + 1))
  fi
  for src in ${sources[@]+"${sources[@]}"}; do
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

  # ⚠️ **GATED ON HAVING READ SOMETHING, not just on having found no miss.** The
  # floor above DETECTED the vacuity and counted it — and then fell through to
  # here with `missing_for_svc` still 0 and printed `All 0 COPY sources covered`:
  # the exact string its own comment quotes as the defect. Counting a vacuity is
  # not suppressing the negative it produces, and every OTHER floor in this loop
  # ends in `continue`, which is what keeps them from doing the same. This one was
  # extending the pattern to the older arm and inherited the counter without the
  # suppression.
  #
  # It stays a suppression rather than a `continue` on purpose: the closure arm
  # reads the same Dockerfile differently and may well succeed, so skipping it
  # would trade a false clean line for lost coverage.
  if [ "${#sources[@]}" -eq 0 ]; then
    echo "  (no COPY sources read — nothing verified by this arm)"
  elif [ $missing_for_svc -eq 0 ]; then
    echo "  All ${#sources[@]} COPY sources covered"
  fi

  # --- The image-content + workspace-closure arms (#4738) ------------------
  #
  # Only for a service whose builder does `COPY . .`. Without that line the
  # image's inputs really are just the COPY sources, and the arm above is
  # complete.
  if ! has_broad_copy "$dockerfile_abs"; then
    echo "  (no broad \`COPY . .\` — the workspace-closure arm does not apply)"
    continue
  fi

  mapfile -t image_paths < <(extract_image_paths "$dockerfile_abs")
  if [ ${#image_paths[@]} -eq 0 ]; then
    # ⚠️ AN ERROR, NOT A WARNING, and that correction is the point. A GH
    # annotation on a PASSING job is a clean line to every consumer that matters
    # — `ci.yml`'s step status, `ci-local.sh`'s PASS row, `gh pr checks`. This
    # repo has already paid for that distinction, in a file this same change
    # touches: `lighthouse.yml` records that "#4899 survived three months
    # precisely because a polite annotation under a green check goes unread."
    # Same reasoning; the first cut of this arm reached the opposite conclusion
    # three files apart.
    echo "::error file=$rel_json::$svc does \`COPY . .\` but no \`COPY --from=<stage> /app/<path>\` lines were found — the workspace-closure arm CANNOT RUN for this service, so nothing here is verified."
    CANNOT_LOOK=$((CANNOT_LOOK + 1))
    continue
  fi

  # ⚠️ THE COMPLETENESS FLOOR. The extractor pins one spelling; the counter uses a
  # looser one. A shorter list is not a shorter answer — it is a package dropped
  # out of `closure_roots` along with its whole transitive closure, while the gate
  # prints `All N … covered`. MEASURED: the first pattern missed
  # `COPY --from=node:24-trixie-slim@sha256:… /usr/local/bin/node` because a
  # digest-pinned stage name contains `:` and `.`.
  declared_tokens=$(count_declared_image_tokens "$dockerfile_abs")
  dropped_node_modules=$(runner_copy_lines "$dockerfile_abs" | grep -oE '[[:space:]]/app/node_modules[^[:space:]]*' | grep -c . || true)
  read_tokens=$(( ${#image_paths[@]} + dropped_node_modules ))
  if [ "$read_tokens" -lt "$declared_tokens" ]; then
    echo "::error file=$rel_json::read $read_tokens of $declared_tokens \`/app/…\` source token(s) from the runner copies in $dockerfile_rel — the image-content arm did not see them all, so the closure below would be a SUBSET. Fix the extractor, not the Dockerfile."
    CANNOT_LOOK=$((CANNOT_LOOK + 1))
    continue
  fi

  # Split the image paths two ways.
  #
  # ⚠️ A path naming a specific FILE (its basename carries an extension) is
  # covered on its own terms; a path naming a DIRECTORY contributes the whole
  # workspace package that produces it. That distinction is not fussiness, it is
  # the difference between two measured outcomes: `packages/react/dist` is a
  # BUILD OUTPUT, so every source file in `packages/react` — and everything
  # `packages/react` depends on — can change it, which is how `packages/sdk`
  # reaches the api image at all. Whereas
  # `packages/cli/data/seeds/ecommerce/seed.sql` is the input itself, and
  # demanding all of `packages/cli` be watched for it would report a gap that
  # does not exist (`packages/cli/data/**` is the correct, narrow pattern).
  # Measured both ways before choosing: the whole-package rule reports
  # `packages/cli` as missing, and it is not.
  closure_roots=""
  exact_paths=()
  for p in "${image_paths[@]}"; do
    base="${p##*/}"
    if [[ "$base" == *.* ]]; then
      exact_paths+=("$p")
      continue
    fi
    # Nearest ancestor (including the path itself) that is a package directory.
    pkg_dir=""
    probe="$p"
    while [ -n "$probe" ] && [ "$probe" != "." ]; do
      if [ -f "$ROOT/$probe/package.json" ]; then pkg_dir="$probe"; break; fi
      [[ "$probe" == */* ]] || break
      probe="${probe%/*}"
    done
    if [ -n "$pkg_dir" ]; then
      closure_roots="${closure_roots}${pkg_dir}"$'\n'
    else
      # `semantic`, `plugins` — real image content, no package manifest.
      exact_paths+=("$p")
    fi
  done

  required=()
  # 1 once the workspace-closure arm has actually produced a closure.
  closure_checked=0
  # ⚠️ DEDUPED AND EMPTY-STRIPPED BEFORE THE FLOOR READS IT. Two arithmetic
  # mismatches lived in these four lines, and one is live on `web` today:
  #
  #   `closure_roots` accumulated ONE LINE PER IMAGE PATH with no dedup, while the
  #   closure returns a SET. MEASURED: `web`'s three image paths
  #   (`.next/standalone`, `.next/static`, `public`) all resolve to
  #   `packages/web`, so `root_count` is 3 against a 5-element closure. It passes
  #   only because 5 > 3; one Dockerfile line more and a healthy tree reports
  #   "the traversal is broken".
  #
  #   And a here-string always carries a newline, so `mapfile` from "" yields ONE
  #   EMPTY ELEMENT — inflating the count the floor reads, which is the same shape
  #   `check-lighthouse-report-paths.sh` neutralises with its `-lt 2`.
  closure_roots=$(printf '%s' "$closure_roots" | grep . | LC_ALL=C sort -u || true)
  if [ -n "$closure_roots" ]; then
    # ⚠️ STDERR SEPARATE, not merged. `closure_out` is PARSED as a directory list,
    # so one line bun writes to stderr on the success path becomes a data element
    # — and it would inflate `${#closure_dirs[@]}`, which is precisely the
    # quantity the vacuity floor below compares. Noise could carry a broken
    # traversal past the floor that exists to catch it.
    closure_err=$(mktemp)
    if ! closure_out=$(workspace_closure "$closure_roots" 2>"$closure_err"); then
      echo "::error file=$rel_json::could not compute the workspace closure for $svc: $(cat "$closure_err")"
      rm -f "$closure_err"
      CANNOT_LOOK=$((CANNOT_LOOK + 1))
      continue
    fi
    if [ -s "$closure_err" ]; then
      # ⚠️ A WARNING, not a verdict, and the earlier `::error::` + exit 2 carried a
      # FALSE claim with it — "its parsed output may be polluted". Round 1
      # redirected stderr to a separate file precisely so it CANNOT reach
      # `closure_out`, so pollution is impossible by construction. The sibling gate
      # in this same change (`check-lighthouse-report-paths.sh`) already treats
      # this shape as a warning and explains why; two gates landing in one PR with
      # opposite readings of one shape is worth resolving now rather than leaving
      # for a reader to reconcile. The per-entry directory check below is the
      # residue guard, and it runs regardless.
      echo "::warning file=$rel_json::workspace_closure wrote to stderr on success for $svc: $(cat "$closure_err")"
      WARNINGS=$((WARNINGS + 1))
    fi
    if false; then :; fi
    rm -f "$closure_err"
    # ⚠️ `grep .` strips the phantom empty element a here-string's trailing
    # newline would produce, which otherwise inflates the count the floor below
    # reads. NO FIXTURE PINS THIS ARM, and that is stated rather than implied:
    # `workspace_closure` always returns at least its own roots, and the two
    # checks above (a non-empty stderr, a non-directory entry) intercept every way
    # its output could be empty-but-successful. So the strip is unreachable today
    # and exists to keep the floor's arithmetic correct if it stops being.
    # MEASURED: reverting it to `mapfile <<<"$closure_out"` leaves all 25 fixtures
    # green, which is why it is documented here instead of claimed as covered.
    mapfile -t closure_dirs < <(printf '%s' "$closure_out" | grep . || true)
    # A closure smaller than its own (deduped) roots means the traversal produced
    # nothing and every check below would trivially agree.
    #
    # ⚠️ NO FIXTURE MAKES THIS ARM FIRE, and that is honest rather than an
    # omission — the same disclosure `check-mutation-tables.sh` carries for its
    # structurally identical `SHARD_OWNED -eq 0` arm. `workspace_closure` seeds its
    # `seen` set with every root before traversing, so |closure| >= |roots| always;
    # once the roots are deduped above, no input can invert that, and the stderr
    # and is-a-directory checks intercept every pollution path. MEASURED: deleting
    # this arm leaves all 28 fixtures green. It stays as a backstop against a future
    # edit to that bun script, which is exactly the edit that would otherwise make
    # every service agree with a reading of nothing. The fixture that DOES exist
    # (four image paths under one package) pins the DEDUP, not this floor.
    root_count=$(printf '%s\n' "$closure_roots" | grep -c . || true)
    if [ "${#closure_dirs[@]}" -lt "$root_count" ]; then
      echo "::error file=$rel_json::the workspace closure for $svc returned ${#closure_dirs[@]} dir(s) for $root_count root(s) — the traversal is broken, so this arm would verify nothing"
      CANNOT_LOOK=$((CANNOT_LOOK + 1))
      continue
    fi
    # ⚠️ Every returned dir must actually BE one, or the parse was polluted after
    # all. Cheap, and it closes the residue of the stderr class above.
    for d in "${closure_dirs[@]}"; do
      if [ ! -d "$ROOT/$d" ]; then
        echo "::error file=$rel_json::the workspace closure for $svc returned '$d', which is not a directory — its output was polluted"
        CANNOT_LOOK=$((CANNOT_LOOK + 1))
        continue 2
      fi
    done
    required+=("${closure_dirs[@]}")
    closure_checked=1
  else
    # ⚠️ An ERROR for the same reason as the arm above: a broad-COPY service whose
    # image paths resolve to no workspace package got the closure arm verifying
    # NOTHING, announced in an annotation under a green check.
    echo "::error file=$rel_json::$svc does \`COPY . .\` but none of its image paths resolve to a workspace package — the workspace-closure arm verified nothing for this service, only the exact image paths."
    CANNOT_LOOK=$((CANNOT_LOOK + 1))
  fi
  required+=("${exact_paths[@]+"${exact_paths[@]}"}")

  missing_closure=0
  for dir in ${required[@]+"${required[@]}"}; do
    [ -n "$dir" ] || continue
    [ "$dir" = "package.json" ] && continue
    # ⚠️ PROBE A SOURCE FILE, not the bare directory.
    #
    # `packages/**/package.json` matches the manifest and nothing else, and a
    # bare `packages/foo` entry matches the directory while watching none of its
    # source — BOTH would read as coverage against a directory-path test, and
    # both leave every source change unwatched. `packages/okf-bundle` was
    # matched by `packages/**/package.json` alone, which is exactly the #4737
    # signature. The probe asks the question that decides a deploy: would a
    # change to a source file in here trigger one?
    if [ -f "$ROOT/$dir" ]; then
      probe_path="$dir"          # the image path is a file; ask about it directly
    else
      probe_path="$dir/__watch_probe__/file.ts"
    fi
    covered=0
    for pat in "${patterns[@]}"; do
      if matches_pattern "$probe_path" "$pat"; then covered=1; break; fi
    done
    if [ $covered -eq 0 ]; then
      echo "::error file=$rel_json::'$dir' is bundled into the $svc image but no watchPattern covers its source — a change confined to it yields Railway's \`skippedReason: \"No changes to watched files\"\` and SILENTLY NEVER DEPLOYS (#4738). Add '$dir/**'."
      missing_closure=$((missing_closure + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done
  # ⚠️ NAMES WHAT IT ACTUALLY COVERED. When `closure_roots` was empty the arm
  # above already errored, but this line still said "bundled workspace/image
  # path(s)" over a set containing NO workspace closure at all — an honest count
  # with a misleading scope, which is the same defect as a vacuous count one
  # degree weaker. `$closure_checked` says which of the two arms actually ran.
  if [ $missing_closure -eq 0 ]; then
    if [ "$closure_checked" -eq 1 ]; then
      echo "  All ${#required[@]} bundled workspace/image path(s) covered"
    else
      echo "  All ${#required[@]} exact image path(s) covered — NO workspace closure was computed"
    fi
  fi
done

echo ""
# ⚠️ **BEFORE ANY VERDICT: did this run examine a single service?** With
# `nullglob` unset an empty `deploy/*/railway.json` glob leaves the loop having
# read nothing, and every counter at zero renders the clean NEGATIVE below — the
# exact sentence a reviewer greps for. The `RAILWAY_WATCH_ROOT` seam this change
# adds is what makes "pointed at the wrong tree" reachable at all.
if [ "$SERVICES" -eq 0 ]; then
  echo "::error::no DOCKERFILE-built deploy/*/railway.json examined under $ROOT — this gate verified NOTHING." >&2
  echo "  RAILWAY_WATCH_ROOT=${RAILWAY_WATCH_ROOT:-<unset>}. Did deploy/ move, or is every service on a non-DOCKERFILE builder?" >&2
  exit 2
fi

# ⚠️ "I COULD NOT LOOK" IS ITS OWN VERDICT, and it must not borrow the other's
# remediation. Counting it as a coverage gap sent an operator to edit a
# watchPatterns array that was fine when the real fault was an unreadable runner
# stage or a broken traversal — the misdirecting-diagnostic class
# `BaselineProblem.kind` was split to prevent, one directory over.
if [ "$CANNOT_LOOK" -gt 0 ]; then
  echo "FAIL: $CANNOT_LOOK service(s)/arm(s) could not be verified at all — see the errors above." >&2
  echo "Fix: the GATE or the Dockerfile it reads, NOT watchPatterns." >&2
  # ⚠️ CONDITIONAL, because the unconditional version asserted "Nothing here says
  # a path is unwatched" while `ERRORS` could be non-zero in the same run — and
  # this arm exits BEFORE the ERRORS block, so that count was never printed at
  # all. Two distinct faults, one of them a real silent-deploy gap, and the
  # summary denied it existed. `ci-local.sh` quotes only the last 40 log lines, so
  # across five services the per-path errors can be off-screen entirely, leaving
  # "fix the GATE, NOT watchPatterns" as the only thing the reader sees.
  if [ "$ERRORS" -gt 0 ]; then
    echo "ALSO: $ERRORS path(s) ARE genuinely uncovered by watchPatterns (#4738) — fix those in" >&2
    echo "      deploy/<service>/railway.json. TWO distinct faults in this run." >&2
  else
    echo "     Nothing here says a path is unwatched; it says the check did not run," >&2
    echo "     which is the one outcome a drift gate must never render as clean." >&2
  fi
  exit 2
fi

if [ $ERRORS -gt 0 ]; then
  echo "FAIL: $ERRORS path(s) not covered by watchPatterns — see errors above"
  echo "Fix: add the missing paths to the corresponding deploy/<service>/railway.json watchPatterns array"
  echo "     A miss here does not fail a deploy — it SKIPS one, silently, which is worse."
  exit 1
fi

UNVERIFIED_NOTE=""
if [ "$UNVERIFIED_SVCS" -gt 0 ]; then
  UNVERIFIED_NOTE="; $UNVERIFIED_SVCS non-DOCKERFILE service(s) UNVERIFIED"
fi
if [ $WARNINGS -gt 0 ]; then
  echo "OK (with $WARNINGS warning(s)): all $SERVICES DOCKERFILE service(s)' COPY sources and bundled workspace paths covered where watchPatterns are defined$UNVERIFIED_NOTE"
else
  echo "OK: all $SERVICES DOCKERFILE service(s)' COPY sources and bundled workspace paths covered$UNVERIFIED_NOTE"
fi
