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
  grep -E '^COPY[[:space:]]' "$dockerfile" | while IFS= read -r line; do
    # Skip --from= (intra-image copy)
    if [[ "$line" == *"--from="* ]]; then
      continue
    fi
    # Drop the COPY keyword
    line="${line#COPY}"
    line="${line# }"
    # Drop --chown=...:... and any other --flag=value
    # shellcheck disable=SC2001
    line=$(echo "$line" | sed -E 's/--[a-zA-Z]+=[^[:space:]]+[[:space:]]+//g')
    # Last whitespace-separated word is the destination; drop it
    # shellcheck disable=SC2206
    words=($line)
    unset "words[${#words[@]}-1]"
    for src in "${words[@]}"; do
      # Skip broad-context copy
      if [ "$src" = "." ] || [ "$src" = "./" ]; then
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
has_broad_copy() {
  grep -qE '^COPY[[:space:]]+\.[[:space:]]+\.[[:space:]]*$' "$1"
}

# Repo paths the RUNTIME image contains, from the runner stage's
# `COPY --from=<stage> [--chown=…] /app/<path>` lines.
#
# These are intra-image copies, so the COPY-source arm skips them — correctly,
# it is asking a different question. Here they answer: what does the shipped
# image actually consist of? A change to any of it changes the image.
extract_image_paths() {
  local dockerfile="$1"
  grep -oE '^COPY --from=[A-Za-z0-9_-]+ (--chown=[^[:space:]]+ )?/app/[^[:space:]]+' "$dockerfile" \
    | sed -E 's#^.*/app/##' \
    | sed -E 's#/+$##' \
    | grep -v '^node_modules' \
    | sort -u
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
    echo "$svc: builder=${builder:-unknown} — skipping (only DOCKERFILE builds are checked)"
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
  missing_for_svc=0
  mapfile -t sources < <(extract_sources "$dockerfile_abs")
  for src in "${sources[@]}"; do
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

  if [ $missing_for_svc -eq 0 ]; then
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
    # ⚠️ NOT silent. A broad-COPY Dockerfile whose runner stage this cannot read
    # is a service where the closure arm verified NOTHING, and a gate unable to
    # look must say so rather than contribute a clean line.
    echo "::warning file=$rel_json::$svc does \`COPY . .\` but no \`COPY --from=<stage> /app/<path>\` lines were found — the workspace-closure arm verified nothing for this service"
    WARNINGS=$((WARNINGS + 1))
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
  if [ -n "$closure_roots" ]; then
    if ! closure_out=$(workspace_closure "$closure_roots" 2>&1); then
      echo "::error file=$rel_json::could not compute the workspace closure for $svc: $closure_out"
      ERRORS=$((ERRORS + 1))
      continue
    fi
    mapfile -t closure_dirs <<<"$closure_out"
    # ⚠️ A VACUITY FLOOR. A closure smaller than its own roots means the
    # traversal produced nothing and every check below would trivially agree.
    root_count=$(printf '%s' "$closure_roots" | grep -c . || true)
    if [ "${#closure_dirs[@]}" -lt "$root_count" ]; then
      echo "::error file=$rel_json::the workspace closure for $svc returned ${#closure_dirs[@]} dir(s) for $root_count root(s) — the traversal is broken, so this arm would verify nothing"
      ERRORS=$((ERRORS + 1))
      continue
    fi
    required+=("${closure_dirs[@]}")
  else
    echo "::warning file=$rel_json::$svc does \`COPY . .\` but none of its image paths resolve to a workspace package — only the exact image paths were verified"
    WARNINGS=$((WARNINGS + 1))
  fi
  required+=("${exact_paths[@]+"${exact_paths[@]}"}")

  missing_closure=0
  for dir in "${required[@]}"; do
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
  if [ $missing_closure -eq 0 ]; then
    echo "  All ${#required[@]} bundled workspace/image path(s) covered"
  fi
done

echo ""
if [ $ERRORS -gt 0 ]; then
  echo "FAIL: $ERRORS path(s) not covered by watchPatterns — see errors above"
  echo "Fix: add the missing paths to the corresponding deploy/<service>/railway.json watchPatterns array"
  echo "     A miss here does not fail a deploy — it SKIPS one, silently, which is worse."
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  echo "OK (with $WARNINGS warning(s)): every deploy Dockerfile COPY source and bundled workspace path is covered where watchPatterns are defined"
else
  echo "OK: every deploy Dockerfile COPY source and bundled workspace path is covered by its service's watchPatterns"
fi
