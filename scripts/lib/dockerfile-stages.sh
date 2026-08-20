#!/usr/bin/env bash
# Shared Dockerfile traversal for the image-scan gates.
#
# Two questions are asked of every Dockerfile in the tree, by two different
# scripts, and they must be asked of the SAME set of files:
#
#   scripts/list-runtime-base-images.sh      what external image does the
#                                            runtime stage sit on?
#   scripts/check-runtime-stage-upgrades.sh  does that runtime stage upgrade
#                                            its OS packages?
#
# The second is the premise the first one's baseline rests on (.trivyignore:
# "if a future Dockerfile adds a runtime stage WITHOUT an upgrade, these entries
# silently start lying"). If the two scripts ever enumerate different file sets,
# the gap between them is invisible and looks exactly like coverage — a
# Dockerfile scanned but never checked, or checked but never scanned. So the
# enumeration and the FROM parser live here, once, rather than in two copies
# that can drift apart without anything noticing.
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

# Emit "image<TAB>alias" for every FROM in one Dockerfile, in file order.
#
# POSIX awk only (no gawk IGNORECASE, no [[:space:]]) — GitHub runners ship
# mawk as /usr/bin/awk on some images and this must not depend on which.
parse_froms() {
  awk '
    /^[ \t]*[Ff][Rr][Oo][Mm][ \t]/ {
      img = ""; alias = "";
      for (i = 2; i <= NF; i++) {
        if (substr($i, 1, 2) == "--") continue;      # --platform=, --chmod=
        if (tolower($i) == "as") { alias = $(i + 1); break }
        if (img == "") img = $i;
      }
      print img "\t" alias
    }
  ' "$1"
}
