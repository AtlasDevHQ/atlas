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
# ⚠️ This file shipped with the parser duplicated: `parse_stages` re-implemented
# `parse_froms`'s `--platform`/`AS` loop while this header claimed the parser
# lived here "once". They had already diverged on one rule. There is now ONE
# parser, `parse_stages`, and `list-runtime-base-images.sh` reads its records
# too. Do not add a second.
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
