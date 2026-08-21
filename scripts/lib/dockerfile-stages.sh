#!/usr/bin/env bash
# Shared Dockerfile traversal for the image-scan gates.
#
# Two questions are asked of every Dockerfile in the tree, by two different
# scripts, and they must be asked of the SAME files and answered by the SAME
# parser:
#
#   scripts/list-runtime-base-images.sh      what external image does the
#                                            runtime stage sit on?
#   scripts/check-runtime-stage-upgrades.sh  does that runtime stage upgrade
#                                            its OS packages?
#
# The second is the premise the first one's baseline rests on (.trivyignore:
# "if a future Dockerfile adds a runtime stage WITHOUT an upgrade, these entries
# silently start lying"). If the two ever disagree about which files exist or
# which stage is the runtime stage, the gap between them is invisible and looks
# exactly like coverage — a Dockerfile scanned but never checked, or checked but
# never scanned.
#
# ⚠️ TWICE NOW this file has claimed to hold something "once" while a second
# copy lived elsewhere, so read that as the failure mode rather than as history:
#
#   1. `parse_stages` re-implemented `parse_froms`'s `--platform`/`AS` loop while
#      this header said the parser lived here once. They had already diverged.
#   2. With the parser shared, the ALIAS-CHAIN WALK was still written twice —
#      `list-runtime-base-images.sh` walking an `alias -> image` map and
#      `check-runtime-stage-upgrades.sh` walking an `alias -> index` map, each
#      with its own `hops > 32` cycle guard. Sharing the parser but not the
#      traversal left the two gates free to resolve DIFFERENT runtime stages for
#      the same Dockerfile, which is precisely the divergence this file exists to
#      prevent.
#
# So the unit shared here is the ANSWER — `resolve_runtime_stage` — not just the
# tokens. If you find yourself walking stages in a caller, that is the smell.
#
# Source it; do not execute it.

# Every Dockerfile in the tree, sorted, one per line on stdout.
#
# ⚠️ .github/fixtures is pruned on purpose: it holds the deliberately-vulnerable
# negative-control images for scripts/__tests__/scan-image.test.sh. Scanning
# those as if they were shipped bases would pin the gate red forever, and
# demanding they upgrade would defeat the point of a vulnerable fixture.
list_dockerfiles() {
  local root="$1"
  find "$root" \
    \( -path '*/node_modules' -o -path '*/.git' -o -path '*/.claude/worktrees' -o -path '*/.github/fixtures' \) -prune -o \
    -type f \( -name 'Dockerfile' -o -name 'Dockerfile.*' \) -print | sort
}

# One record per stage, in file order:
#
#   <index><TAB><image><TAB><alias><TAB><0|1 upgrades in THIS stage's own body>
#
# `alias` is empty for a stage with no `AS <name>`. Read records with
# read_stage_record, never with `IFS=$'\t' read` — see its comment.
#
# What counts as an upgrade, and why each restriction is here:
#
#   RUN only        `LABEL x="apk upgrade"` and `ENV NOTE="apt-get upgrade"`
#                   execute nothing. The first cut of this matched any line and
#                   passed both of them while its own header promised "never a
#                   false pass" — on the guard the whole #5361 narrowing rests
#                   on. Continuations are tracked, so the second line of a
#                   multi-line RUN still counts as RUN.
#   comments cut    both the whole-line form and a trailing `# …`. A `#` inside
#                   a quoted string is over-cut by this, which can only turn a
#                   REAL upgrade unmatched — a false red, loud, never a false
#                   pass.
#   this stage only the caller decides whether an ancestor stage's upgrade
#                   counts. It does for "does anything vulnerable ship"; it does
#                   NOT for `no-cache-filters`, which busts one named stage.
#
# POSIX awk only (no gawk IGNORECASE, no [[:space:]]) — GitHub runners ship mawk
# as /usr/bin/awk on some images and this must not depend on which.
parse_stages() {
  awk '
    function flush() { if (idx >= 0) print idx "\t" img "\t" alias "\t" up }
    BEGIN { idx = -1; img = ""; alias = ""; up = 0; in_run = 0; cont = 0 }
    /^[ \t]*#/ { next }                                  # a comment runs nothing
    /^[ \t]*[Ff][Rr][Oo][Mm][ \t]/ {
      flush()
      idx++; img = ""; alias = ""; up = 0; in_run = 0; cont = 0
      for (i = 2; i <= NF; i++) {
        if (substr($i, 1, 2) == "--") continue;          # --platform=, --chmod=
        if (tolower($i) == "as") { alias = $(i + 1); break }
        if (img == "") img = $i;
      }
      next
    }
    {
      line = $0
      sub(/[ \t]*#.*$/, "", line)                        # trailing comment
      line = tolower(line)
      if (!cont) in_run = (line ~ /^[ \t]*run[ \t]/)
      cont = (line ~ /\\[ \t]*$/)
      if (idx >= 0 && in_run && line ~ /(apt-get|apt|apk)([ \t]+-[^ \t]+)*[ \t]+(dist-)?upgrade/) up = 1
    }
    END { flush() }
  ' "$1"
}

# Split one parse_stages record into STAGE_IDX / STAGE_IMG / STAGE_ALIAS /
# STAGE_UP.
#
# ⚠️ NOT `IFS=$'\t' read -r a b c d`. Tab is an IFS *whitespace* character, so
# consecutive tabs COALESCE: the record for a stage with no alias, `0<TAB>img
# <TAB><TAB>1`, assigns alias=1 and up="". Measured — it made the guard report
# `FAIL … never runs apt-get upgrade` on a single-stage Dockerfile that does,
# with the chain printed as `chain: 1`. Every Dockerfile in the tree happens to
# name every stage today, which is the only reason it was latent.
read_stage_record() {
  local rest="$1"
  STAGE_IDX="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
  STAGE_IMG="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
  STAGE_ALIAS="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
  STAGE_UP="$rest"
}

# Resolve one Dockerfile's runtime stage — the single traversal both gates use.
#
# "Runtime stage" is the LAST stage in the file, which is Docker's default build
# target. Its `FROM` may name an earlier stage alias (`FROM base AS runner`), so
# aliases are walked transitively back to the external image reference.
#
# On success (exit 0) sets:
#
#   RUNTIME_BASE         external image ref the chain terminates at, or `scratch`
#   RUNTIME_CHAIN        stage labels, runtime-stage first, back to that image
#   RUNTIME_UPGRADES     1 if ANY stage on the chain upgrades. Inherited layers
#                        ship, so an ancestor's upgrade genuinely counts.
#   RUNTIME_FINAL_ALIAS  the last stage's `AS` name, empty if it has none
#   RUNTIME_FINAL_UPGRADES  1 if the LAST STAGE ITSELF upgrades. Distinct from
#                        RUNTIME_UPGRADES on purpose: `no-cache-filters` busts
#                        one named stage, so an upgrade that has moved into an
#                        ancestor still ships but is no longer being rebuilt.
#
# Exits 1 with a `::error file=…::` line on anything it cannot resolve — no FROM,
# a cycle, or a build-arg-interpolated reference. Fail closed rather than
# silently dropping it: a stage we cannot resolve is one neither gate can judge,
# and skipping it quietly leaves a hole that looks exactly like coverage.
resolve_runtime_stage() {
  local df="$1"
  local -A alias_idx=()
  local records=() i cur hops parent

  mapfile -t records < <(parse_stages "$df")
  if [ ${#records[@]} -eq 0 ]; then
    echo "::error file=$df::No FROM instruction found — cannot determine a runtime stage" >&2
    return 1
  fi

  local imgs=() aliases=() ups=()
  for i in "${!records[@]}"; do
    read_stage_record "${records[$i]}"
    imgs+=("$STAGE_IMG"); aliases+=("$STAGE_ALIAS"); ups+=("$STAGE_UP")
    [ -n "$STAGE_ALIAS" ] && alias_idx["$STAGE_ALIAS"]="$i"
  done

  cur=$(( ${#records[@]} - 1 ))          # last FROM wins — the default target
  RUNTIME_FINAL_ALIAS="${aliases[$cur]}"
  RUNTIME_FINAL_UPGRADES="${ups[$cur]}"
  RUNTIME_UPGRADES=0
  RUNTIME_CHAIN=()

  hops=0
  while :; do
    RUNTIME_CHAIN+=("${aliases[$cur]:-stage-$cur}")
    [ "${ups[$cur]}" = "1" ] && RUNTIME_UPGRADES=1
    parent="${imgs[$cur]}"
    [ -n "${alias_idx[$parent]+set}" ] || break
    cur="${alias_idx[$parent]}"
    hops=$((hops + 1))
    if [ "$hops" -gt 32 ]; then
      echo "::error file=$df::Stage alias chain did not terminate (cycle?)" >&2
      return 1
    fi
  done

  RUNTIME_BASE="${imgs[$cur]}"

  if [[ "$RUNTIME_BASE" == *'$'* ]]; then
    echo "::error file=$df::Runtime base image '$RUNTIME_BASE' interpolates a build arg — resolve it or add an explicit exclusion" >&2
    return 1
  fi
  return 0
}
