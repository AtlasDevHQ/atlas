#!/bin/bash
# Adversarial fixture suite for scripts/check-docs-links.ts (#4480). Each
# fixture builds a throwaway three-tree content dir (docs / shared /
# self-hosted — the real mount layout) and runs the checker against it via
# --content-dir, exercising the real scan path, not a mocked one.
#
# Locks in: broken internal paths and broken anchors FAIL with file:line
# output; github-slugger parity holds for the double-dash (`A / B`) and
# duplicate-heading (`-1` suffix) cases; the tree-mounting rules are respected
# (shared pages dual-mount, /self-hosted links resolve only against the
# self-hosted mount); audience conditionals scope both link occurrences and
# anchor targets per mount; code fences and custom `[#id]` heading ids are
# honored; and relative links resolve file-style through the merged virtual
# namespace.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-docs-links.ts"

if [ ! -f "$SCRIPT" ]; then
  echo "::error::script under test not found at $SCRIPT" >&2
  exit 2
fi

PASS=0
FAIL=0

# run_case EXPECTED NAME SETUP_FN [GREP_PATTERN]
# SETUP_FN is called with the fixture content dir as $1 and must create
# docs/ shared/ self-hosted/ trees. When GREP_PATTERN is given, the checker's
# combined output must match it (used to pin the file:line violation format).
run_case() {
  local expected="$1" name="$2" setup_fn="$3" grep_pattern="${4:-}"
  local tmp out status=0
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/docs" "$tmp/shared" "$tmp/self-hosted"
  "$setup_fn" "$tmp"

  out="$(cd "$REPO_ROOT" && bun "$SCRIPT" --content-dir "$tmp" 2>&1)" || status=$?

  local ok=1
  if [ "$expected" = "pass" ] && [ "$status" -ne 0 ]; then ok=0; fi
  if [ "$expected" = "fail" ] && [ "$status" -ne 1 ]; then ok=0; fi
  if [ -n "$grep_pattern" ] && ! grep -qE "$grep_pattern" <<<"$out"; then ok=0; fi

  if [ "$ok" = 1 ]; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected $expected, got status=$status" >&2
    echo "$out" | sed 's/^/    | /' >&2
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

# ── clean content across all three trees passes ────────────────────────────
setup_clean() {
  cat > "$1/docs/index.mdx" <<'EOF'
# Intro

A [guide link](/guides/setup) and a [shared link](/concepts) and a
[shared anchor](/concepts#core-idea) and the [self-hosted docs](/self-hosted).
An [external link](https://example.com/x) is ignored.
EOF
  mkdir -p "$1/docs/guides"
  cat > "$1/docs/guides/setup.mdx" <<'EOF'
# Setup

## Core Steps

A [relative link](../index.mdx) and a [same-page anchor](#core-steps).

```bash
# not a heading, and [not a link](/nowhere) either
```
EOF
  cat > "$1/shared/concepts.mdx" <<'EOF'
# Concepts

## Core Idea

Dual-mounted: [root form](/guides/setup) and [sh form](/self-hosted/deploy).
EOF
  cat > "$1/self-hosted/index.mdx" <<'EOF'
# Self-Hosted

See [deploy](/self-hosted/deploy) and the shared [concepts](/self-hosted/concepts#core-idea).
A cross-mount jump to a [root-only page](/guides/setup) is legal.
EOF
  cat > "$1/self-hosted/deploy.mdx" <<'EOF'
# Deploy
EOF
}
run_case pass "clean three-tree content" setup_clean

# ── broken path fails with file:line ────────────────────────────────────────
setup_broken_path() {
  setup_clean "$1"
  cat > "$1/docs/broken.mdx" <<'EOF'
# Broken

Line three links [nowhere](/guides/nope).
EOF
}
run_case fail "broken internal path" setup_broken_path 'docs/broken\.mdx:3: broken link "/guides/nope"'

# ── broken anchor fails with file:line ──────────────────────────────────────
setup_broken_anchor() {
  setup_clean "$1"
  cat > "$1/docs/anchor.mdx" <<'EOF'
# Anchor

[reworded heading](/concepts#old-name)
EOF
}
run_case fail "broken cross-page anchor" setup_broken_anchor 'docs/anchor\.mdx:3: broken anchor "/concepts#old-name"'

# ── slugger parity: `A / B` → a--b (double dash), plus wrong form fails ─────
setup_double_dash_ok() {
  setup_clean "$1"
  cat > "$1/shared/dc.mdx" <<'EOF'
# DC

## Confluence Data Center / Server

[jump](#confluence-data-center--server)
EOF
}
run_case pass "double-dash anchor (Data Center / Server)" setup_double_dash_ok

setup_double_dash_bad() {
  setup_clean "$1"
  cat > "$1/shared/dc.mdx" <<'EOF'
# DC

## Confluence Data Center / Server

[single-dash is wrong](#confluence-data-center-server)
EOF
}
run_case fail "single-dash form of a double-dash anchor" setup_double_dash_bad

# ── slugger parity: duplicate headings get -1 suffixes ──────────────────────
setup_dup_ok() {
  setup_clean "$1"
  cat > "$1/docs/dup.mdx" <<'EOF'
# Dup

## Options

## Options

[first](#options) and [second](#options-1)
EOF
}
run_case pass "duplicate headings expose -1 suffix" setup_dup_ok

setup_dup_bad() {
  setup_clean "$1"
  cat > "$1/docs/dup.mdx" <<'EOF'
# Dup

## Options

[no third copy](#options-1)
EOF
}
run_case fail "anchor to a -1 suffix that does not exist" setup_dup_bad

# ── custom heading id `[#id]` is honored ────────────────────────────────────
setup_custom_id() {
  setup_clean "$1"
  cat > "$1/docs/custom.mdx" <<'EOF'
# Custom

## Some Long Heading [#short]

[by custom id](#short)
EOF
}
run_case pass "custom [#id] heading anchor" setup_custom_id

# ── mount partition: /self-hosted link must resolve on that mount ───────────
setup_wrong_mount() {
  setup_clean "$1"
  cat > "$1/self-hosted/leak.mdx" <<'EOF'
# Leak

[docs-only page addressed via self-hosted](/self-hosted/guides/setup)
EOF
}
run_case fail "docs-tree page addressed under /self-hosted" setup_wrong_mount

# ── audience conditionals: link + anchor scope per mount ────────────────────
# The /self-hosted target link only renders on the self-hosted mount (inside
# <WhenSelfHosted>) — and the heading inside the block only exists there.
setup_audience_ok() {
  setup_clean "$1"
  cat > "$1/shared/cond.mdx" <<'EOF'
# Cond

<WhenSelfHosted>

## Operator Setup

[self-hosted only link](/self-hosted/deploy) and [own anchor](#operator-setup)

</WhenSelfHosted>
EOF
}
run_case pass "links + anchors inside WhenSelfHosted check only that mount" setup_audience_ok

# A saas-mount link to a heading that only renders inside <WhenSelfHosted>
# must fail — the anchor does not exist on the root mount.
setup_audience_bad() {
  setup_clean "$1"
  cat > "$1/shared/cond.mdx" <<'EOF'
# Cond

<WhenSelfHosted>

## Operator Setup

</WhenSelfHosted>
EOF
  cat > "$1/docs/points-at-cond.mdx" <<'EOF'
# Pointer

[stripped on root mount](/cond#operator-setup)
EOF
}
run_case fail "anchor into a WhenSelfHosted block from the root mount" setup_audience_bad 'points-at-cond\.mdx:3'

# ── AudienceLink hrefs validate against their own mounts ────────────────────
setup_audiencelink_bad() {
  setup_clean "$1"
  cat > "$1/shared/al.mdx" <<'EOF'
# AL

<AudienceLink saas="/guides/setup" selfHosted="/self-hosted/nope">Setup</AudienceLink>
EOF
}
run_case fail "AudienceLink selfHosted href to a missing page" setup_audiencelink_bad 'al\.mdx:3'

# ── relative links resolve file-style in the merged namespace ───────────────
setup_relative_bad() {
  setup_clean "$1"
  mkdir -p "$1/self-hosted/contributing"
  cat > "$1/self-hosted/contributing/dev.mdx" <<'EOF'
# Dev

[not on this mount](../guides/setup)
EOF
}
run_case fail "relative link to a page absent from the mount" setup_relative_bad 'dev\.mdx:3'

# ── a ``` line inside a ```` fence stays fenced (CommonMark close rules) ────
setup_nested_fence() {
  setup_clean "$1"
  cat > "$1/docs/fence.mdx" <<'EOF'
# Fence

## Real Heading

````markdown
```
[not a link](/nowhere)
# not a heading
```
````

[real](#real-heading)
EOF
}
run_case pass "nested fence: inner \`\`\` does not close a \`\`\`\` block" setup_nested_fence

# ── empty content dir is a loud failure, not a vacuous pass ─────────────────
setup_empty() { :; }
run_case fail "empty content dir fails loudly" setup_empty 'no MDX pages found'

echo ""
echo "check-docs-links.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
