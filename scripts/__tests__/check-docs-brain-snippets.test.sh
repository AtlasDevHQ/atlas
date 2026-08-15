#!/bin/bash
# Adversarial fixture suite for scripts/check-docs-brain-snippets.ts (#5165).
#
# The gate compares published `Brain*` contract snippets in apps/docs against the
# real declarations under packages/*/src and ee/src. This suite proves it can
# actually FAIL — the guard exists because the drift it catches (a required
# `audience` member missing from a page that calls itself "the contract") sat in
# the tree unnoticed, so a green-but-vacuous guard would be worse than none.
#
# ## Every fixture builds a THROWAWAY tree; nothing tracked is written (#5172)
#
# Each case gets a `mktemp -d` mirroring the repo layout — `packages/*/src/**`
# and `apps/docs/content/**` — and runs the guard against it via `--root`. The
# previous version had no such seam: both roots were module constants, so the
# only way to regress the guard was to REWRITE TRACKED SOURCE in place
# (`apps/docs/content/shared/guides/atlas-connector-authoring.mdx` and
# `packages/api/src/lib/brain/ingest/types.ts`) and restore it on exit. That
# bought a `restore()` with a trap, an idempotence guard, git-object
# verification and an `|| exit 2` escalation — two of whose defects were found in
# review — a start-of-run baseline check, a probe page written into a tracked
# content dir, and a stage constraint in `ci-local.sh`. It still had one residual
# it could not close: `restore()` wrote the START-OF-RUN backup at the END, so a
# concurrent edit made during the run was reverted and reported as a successful
# restore. All of that is deleted here, because none of it has anything left to
# protect. `scripts/__tests__/check-docs-links.test.sh` has worked this way since
# #4480.
#
# `assert_tree_clean` pins it: `git status --porcelain` is compared against its
# start-of-run value after EVERY case, and the final fixture asserts both that
# nothing diverged AND that the checkpoint count equals the number of fixtures —
# the second half because without it, deleting every checkpoint call leaves that
# fixture reporting `ok` against an empty set of checkpoints.
#
# ## The failure fixtures each assert a MARKER, not just a non-zero exit
#
# `bun` exits 1 on an uncaught exception too, so an exit code alone cannot tell
# "the arm I meant reported a violation" from "the guard crashed" or "a DIFFERENT
# arm fired". Each `check fail` below names a substring only its own arm prints,
# on `scripts/__tests__/check-docs-links.test.sh`'s precedent. Without this, a
# review measured nine of the then-eleven fixtures satisfied by `process.exit(3)`
# at the top of the guard — and it is load-bearing beyond that: three of the
# refusal-arm mutations still exit 1, so ONLY the marker distinguishes them.
#
# ⚠️ A marker that PREFIXES a longer message is the weak version of this, and it
# was measured: `"…compared for: BrainSourceConnector"` also matches
# `"…compared for: BrainSourceConnector, BrainSourceAudience."`, so two fixtures
# stayed green against a docs side that read NOTHING. The floor markers end in
# the message's own full stop for that reason.
#
# The `check pass` fixtures assert exit 0 and structurally cannot name a marker —
# `check()` refuses one, and refuses an EMPTY one on a `fail` fixture for the
# mirror reason. `check_refuse` does too, and there it is not merely a skip:
# `grep -qF -- ""` matches any non-empty output.
#
# The `pass` fixtures are the ones a no-op guard would satisfy, which is exactly
# what the failure fixtures exist to rule out. `--root` is pinned by nearly all
# of them at once: ignore the flag and the guard scans the REAL repo, which
# passes, so almost every `fail` fixture goes red on that single mutation.
#
# ## Coverage: three directions, the arms only a fixture can reach, and the roots
#
#   • doc side  — the page drifts while the code moves on (the #5165 defect);
#   • code side — the interface grows a member or an arm and the page is not
#                 updated (the same defect from the other direction, and the one a
#                 feature PR actually produces);
#   • vacuity   — the page stops publishing a floored contract, or the fence
#                 scanner stops reading it, which is the failure mode a
#                 discovered-both-sides guard is uniquely exposed to;
#   • refusal   — branches whose design claim is "loud, never a skip" (an opaque
#                 real declaration, an opaque published snippet, an
#                 interface/union mismatch, a name published twice on one page),
#                 each of which could be turned into a bare `continue` with the
#                 suite still green;
#   • correct prose that must NOT fail — `doc_elided_fence` carries an elided
#                 snippet and a commented-out declaration, and every page that is
#                 REBUILT for a fence fixture carries it too (except the
#                 unterminated one, where a later fence would close the fence the
#                 fixture needs open). So the parse-error rule's NEGATIVE
#                 direction is covered. That was the one thing the synthetic tree
#                 would otherwise have lost: the previous suite scanned the real
#                 `apps/docs`, where 75 of 407 `ts` fences carry parse
#                 diagnostics for perfectly good reasons;
#   • roots     — both globs, their repeatability, the empty-source and
#                 duplicate-declaration arms, and the six exit-2 argv refusals,
#                 none of which was reachable while the roots were constants;
#   • environment — an unreadable input is exit 2 and must NOT print the drift
#                 banner. `check_die` pins both `readOrDie` paths.
#
# ## Exactly two arms are NOT fixtured, and both are unreachable by construction
#
# `scan.fences.length !== scan.openedTsFences`: the only way to open a `ts` fence
# and not extract it is to leave it unterminated, which sets `unterminatedAt` and
# is reported first. `aliasShape`'s `token === null`: `discriminantOf` already
# required non-null tokens for the name it returned. Each says so at its site.
#
# ⚠️ An earlier version of this list also named the `__tests__`/`__mocks__`
# filter, on the claim that "no input in either tree reaches it". Measured false —
# it fires 1,376 times on a real CI run — and injectable roots make it trivially
# fixturable, which it now is.
#
# ## One thing this suite cannot fixture without a non-root uid
#
# `readOrDie`'s catch needs an input the glob YIELDS and the read then fails on.
# Measured: `Glob.scanSync` yields neither a directory named `types.ts` nor a
# broken symlink, so those breakages remove the file from the scan and reach a
# different arm entirely. `chmod 000` is what remains, and root ignores it — so
# `unreadable()` asserts its own precondition and fails LOUD rather than let the
# fixture quietly stop covering anything.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-docs-brain-snippets.ts"

if [ ! -f "$GUARD" ]; then
  echo "::error::guard under test not found at $GUARD" >&2
  exit 2
fi

PASS=0
FAIL=0

# Repo-relative paths the seeded tree mirrors. The docs one is the real contract
# page's path and the source one is the real declaration's, so a reader can map a
# fixture onto the tree it models — but nothing here reads or writes either.
TYPES_REL="packages/api/src/lib/brain/ingest/types.ts"
TOOLS_REL="packages/api/src/lib/tools/search-brain.ts"
DOC_REL="apps/docs/content/shared/guides/atlas-connector-authoring.mdx"

# ── the clean tree every fixture regresses FROM ──────────────────────────────
#
# Deliberately synthetic rather than copied from the tree. The REAL page's
# agreement with the REAL declarations is what the gate itself asserts in CI
# (`bun scripts/check-docs-brain-snippets.ts`); this suite's job is the
# orthogonal one of proving the gate can fail. Copying would re-assert the
# former and make every fixture's anchor drift with an unrelated prose edit —
# which is exactly what the line-number anchors in the previous version did.
seed_tree() {
  local dir="$1"
  mkdir -p "$dir/$(dirname "$TYPES_REL")" "$dir/$(dirname "$TOOLS_REL")" \
           "$dir/$(dirname "$DOC_REL")" || return 2

  # ⚠️ `|| return 2` on every write — RETURN, not exit. On a full or read-only
  # TMPDIR `mktemp -d` and
  # `mkdir -p` both succeed and only the `cat` fails, leaving a docs page with no
  # declarations behind it — at which point the empty-source fixture below
  # reports `ok` for a reason that has nothing to do with `--source-glob`. This
  # is the hazard the deleted backup-verification block reasoned about, one
  # command over: the `cat` inherited the `cp`'s failure mode, not its check.
  #
  # The RETURN half is what makes the caller's diagnosis reachable. Spelled
  # `exit 2`, every one of these kills the script before `check()` can say WHICH
  # fixture died or add "(TMPDIR full or read-only?)" — so the check fired and
  # the message that makes it actionable never printed.
  cat > "$dir/$TYPES_REL" <<'TYPES_EOF' || return 2
export type EpisodeSource = "chat" | "meeting";

interface AudienceReverifier {
  readonly reverifiedAt: string;
}

export interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}

export type BrainSourceAudience =
  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }
  | { readonly kind: "externally-synced" };

// Conditional, so this one is opaque to the gate — as the real declaration is.
// Nothing publishes it, so opaque is a skip rather than a failure.
export type BrainSourceAudienceFor<S extends EpisodeSource> = S extends "chat"
  ? BrainSourceAudience
  : BrainSourceAudience;

export interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
TYPES_EOF

  # A `Brain*` contract OUTSIDE `lib/brain/**`, at the LOCATION of the real
  # `BrainToolReason` — the load-bearing half. Its shape differs deliberately:
  # the real one is an indexed-access type this gate calls opaque, which no
  # fixture could compare. The source glob is wider than `lib/brain`, and the
  # location is what pins that.
  #
  # ⚠️ The shared `mode` property is load-bearing and is the ONLY thing covering
  # `discriminantOf`'s distinctness rule. That rule is measured in the guard —
  # requiring only non-null tokens picked the first string-literal-typed property
  # in every arm, which here is `mode`, collapsing both arms to one token and
  # reporting a perfectly good union as uncomparable. Drop the distinctness test
  # and this declaration becomes opaque, so the second-doc-file fixture's marker
  # (a DRIFT message) stops matching and that fixture goes red.
  cat > "$dir/$TOOLS_REL" <<'TOOLS_EOF' || return 2
export type BrainToolReason =
  | { readonly mode: "shared"; readonly kind: "grounded" }
  | { readonly mode: "shared"; readonly kind: "speculative" };
TOOLS_EOF

  write_doc "$dir/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence \
    doc_elided_fence || return 2

  # An exported `Brain*` name inside `__tests__`, which the source scan must SKIP.
  # Delete that filter and this fixture's own declaration collides with the real
  # one, so the duplicate-source arm fires and the tree stops passing.
  mkdir -p "$dir/packages/api/src/lib/brain/__tests__" || return 2
  cat > "$dir/packages/api/src/lib/brain/__tests__/fixture-types.ts" <<'MOCK_EOF' || return 2
export interface BrainSourceVendorClient {
  readonly nothingLikeTheRealOne: string;
}
MOCK_EOF

  # An UNEXPORTED `Brain*` declaration. The source side is `exported-only`, so
  # this must not enter the compared set — widen the scope to `all` and the
  # unexported-snippet fixture below stops reporting "not an exported Brain*
  # declaration" and goes red.
  cat >> "$dir/$TYPES_REL" <<'HIDDEN_EOF' || return 2

interface BrainSourceHidden {
  readonly notPublished: string;
}
HIDDEN_EOF
}

# ── the contract page, emitted fence by fence ────────────────────────────────
#
# Composed rather than written whole so the fence-scanner fixtures can swap ONE
# fence for a variant and leave the rest identical. The previous version had to
# resolve fence lines in a tracked page by content-relative position — every
# fence line there is exactly "```", carrying no anchor of its own — and three of
# those resolutions silently applied file-wide when the anchor drifted. A fence
# that is *emitted* by name cannot drift.
#
# write_doc <file> <emitter>... — frontmatter, then each emitter in order.
write_doc() {
  local file="$1"; shift
  # ⚠️ Validate the names BEFORE the redirect, and check each call.
  #
  # `{ …; } > file || exit 2` guards the REDIRECT, not the emitters: a group's
  # status is its last command's, so a typo in any earlier emitter exits 127,
  # bash writes `command not found` to stderr rather than into the page, and the
  # fence is silently absent. Measured, and it is not harmless — the
  # relabelled-fence fixture's marker is the vacuity floor, which an ABSENT
  # connector fence reproduces exactly, so that fixture would report `ok`
  # whichever way its emitter resolved. The validation loop is outside the
  # redirect because inside it the error message would land in the fixture page.
  local emitter
  for emitter in "$@"; do
    # `declare -F` alone answers "is a function", which every helper in this file
    # satisfies — `write_doc "$f" report` would pass validation and then run
    # `report` INTO the page. The `doc_*` prefix is what makes this a check on
    # being a fence emitter.
    case "$emitter" in
      doc_*) ;;
      *)
        echo "::error::write_doc: \`$emitter\` is not a fence emitter (emitters are named doc_*)" >&2
        return 2
        ;;
    esac
    declare -F "$emitter" >/dev/null || {
      echo "::error::write_doc: no such fence emitter \`$emitter\`" >&2
      echo "::error::The fixture below would assert against a page missing that fence, which several markers match for the wrong reason. Fix the name." >&2
      return 2
    }
  done
  # The frontmatter `cat` is checked too: same group, same failure mode. A page
  # missing only its frontmatter still parses for this guard, so the fixture
  # would otherwise assert against a page it did not finish writing.
  {
    cat <<'HEAD_EOF' || return 2
---
title: Authoring a brain connector
description: Fixture page built by scripts/__tests__/check-docs-brain-snippets.test.sh.
---

# Authoring a brain connector

This page is the contract.
HEAD_EOF
    for emitter in "$@"; do "$emitter" || return 2; done
  } > "$file" || return 2
}

doc_connector_fence() { cat <<'EOF'

```ts
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
```
EOF
}

# Indented three spaces, the convention inside a numbered step or a JSX child,
# and DRIFTED in the same emitter — see the fixture for why both at once.
doc_connector_fence_indented() { cat <<'EOF'

1. Declare the connector:

   ```ts
   interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
     readonly source: S;
     readonly catalogId: string;
   }
   ```
EOF
}

# The closing fence is missing, so the prose that follows lands in the body.
doc_connector_fence_unclosed() { cat <<'EOF'

```ts
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
EOF
}

# Tagged `text`, so the fence scanner does not read it as TypeScript at all.
doc_connector_fence_text() { cat <<'EOF'

```text
interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {
  readonly source: S;
  readonly catalogId: string;
  readonly audience: BrainSourceAudienceFor<S>;
}
```
EOF
}

doc_audience_fence() { cat <<'EOF'

The audiences a connector may mint:

```ts
type BrainSourceAudience =
  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }
  | { readonly kind: "externally-synced" };
```
EOF
}

doc_vendor_fence() { cat <<'EOF'

And the vendor client it wraps:

```ts
interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
```
EOF
}

# Opened and never closed, with nothing after it — a malformed page.
doc_vendor_fence_unclosed() { cat <<'EOF'

And the vendor client it wraps:

```ts
interface BrainSourceVendorClient {
  readonly fetchEpisodes: () => Promise<readonly string[]>;
  readonly close: () => void;
}
EOF
}

# ⚠️ CORRECT PROSE THAT MUST NOT FAIL — carried on the DEFAULT page, so every
# fixture's tree contains it and fixture 1 is the sentinel.
#
# This is the only coverage of the parse-error rule's negative direction, and it
# is the one thing the synthetic seed would otherwise have lost: the previous
# suite scanned the real `apps/docs` on every fixture, where 75 of 407 `ts`
# fences carry parse diagnostics because they are legitimately elided. Relax the
# guard's rule from `errors && spelled` to `errors` alone and the real tree
# reports 75 problems — but a synthetic tree with no unparseable fence reports
# none, so the mutation would be invisible here.
#
# Two fences, one for each measured false positive:
#   • an ELIDED snippet — does not parse, spells no `Brain*` name;
#   • a commented-out `Brain*` declaration in a fence that DOES parse, which the
#     parser correctly ignores and a regex would not (the shape that failed a
#     page keeping an "old shape, for reference" comment).
doc_elided_fence() { cat <<'EOF'

Eliding for brevity is normal prose, not a contract:

```ts
const connector = { source: "chat", … };
```

The old shape, kept for reference:

```ts
// interface BrainSourceConnectorLegacy {
//   readonly source: EpisodeSource;
// }
const migrated = true;
```
EOF
}

# A `ts` fence NESTED in a 4-backtick `md` block: that block's content, not
# published contract. Its body declares a `BrainSourceConnector` that agrees with
# nothing.
doc_nested_md_block() { cat <<'EOF'

How to write one of these blocks:

````md
```ts
interface BrainSourceConnector {
  readonly nothingLikeTheRealOne: string;
}
```
````
EOF
}

# tweak <file> <sed-script> — apply and prove it landed.
#
# The target is always a file this suite wrote seconds earlier, so an anchor
# cannot drift with an unrelated repo edit. It is still checked, because a sed
# that matches nothing would leave the fixture asserting that the guard fails on
# the CLEAN tree — a green fixture testing nothing.
tweak() {
  local file="$1" script="$2" before
  before="$(cat "$file")" || return 2
  sed -i "$script" "$file" || return 2
  if [ "$before" = "$(cat "$file")" ]; then
    echo "::error::fixture sed matched nothing: $script" >&2
    echo "::error::The pattern has drifted from seed_tree()'s text, so the fixture below would assert that the guard fails on the CLEAN tree. Update the pattern." >&2
    return 2
  fi
}

# ── the tracked tree must be untouched at every checkpoint ───────────────────
#
# The whole point of #5172: no fixture may write a tracked file. Re-snapshotting
# after a divergence means one report per divergence rather than one per
# remaining case.
#
# A mismatch is not proof this suite wrote something — a concurrent session
# editing the shared checkout produces the same reading — so the message names
# both. It fails LOUD either way, which is the direction that matters: the shape
# this replaces reverted a concurrent edit silently and printed "17 passed".
#
# Two boundaries worth stating rather than leaving to be over-read. It is what
# `git status --porcelain` sees, so a write to a GITIGNORED path or to anywhere
# outside `$ROOT` is invisible to it; and it is a CHECKPOINT comparison, so a
# fixture that wrote a tracked file and restored it within one `check()` would
# also pass. That second one is the shape #5172 deleted — this assertion catches
# a regression that leaves RESIDUE, not one that cleans up after itself.
TREE_SNAPSHOT="$(git -C "$ROOT" status --porcelain)" || exit 2
CHECKPOINTS=0
DIRTIED=0
assert_tree_clean() {
  local now
  now="$(git -C "$ROOT" status --porcelain)" || exit 2
  CHECKPOINTS=$((CHECKPOINTS + 1))
  if [ "$now" != "$TREE_SNAPSHOT" ]; then
    echo "::error::the working tree changed while running fixture: $1" >&2
    echo "::error::Either this suite wrote a tracked file (a regression — it must only write under mktemp -d), or a concurrent session edited the checkout." >&2
    diff <(printf '%s\n' "$TREE_SNAPSHOT") <(printf '%s\n' "$now") | sed 's/^/::error::  /' >&2
    TREE_SNAPSHOT="$now"
    DIRTIED=$((DIRTIED + 1))
  fi
}

# ── one throwaway root for the whole run, cleaned up on every exit path ──────
#
# Not a restore trap — nothing tracked is written, so there is nothing to put
# back. It exists because a per-case dir can outlive an abort, and because SIGINT
# and SIGTERM leave one behind too. Removing the RESTORE trap was the point of
# #5172; removing all cleanup with it was collateral, and its only signal would
# have been disk usage.
#
# ⚠️ IT MUST NOT DELETE A TREE `report` SAID IT KEPT. `$TMPROOT` is the parent of
# every per-case dir, so a bare `rm -rf "$TMPROOT"` removes the evidence the
# failure message just pointed at. Measured.
TMPROOT="$(mktemp -d)" || exit 2
KEPT=0
cleanup() {
  if [ "$KEPT" -gt 0 ]; then
    echo "::notice::$KEPT failing fixture tree(s) kept for inspection under $TMPROOT — remove with: rm -rf '$TMPROOT'" >&2
    return 0
  fi
  rm -rf "$TMPROOT"
}
# ⚠️ INT/TERM must EXIT, not just clean up. A signal handler that returns
# normally resumes the script at the next command — so a Ctrl-C would delete
# `$TMPROOT`, let the run continue, fail the next `mktemp -d` inside it, and
# report an interrupt as a setup fault with status 2 instead of 130.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# report <ok> <name> <expected> <status> <marker> <tmp> <out> <argv...>
report() {
  local ok="$1" name="$2" expected="$3" status="$4" marker="$5" tmp="$6" out="$7"
  shift 7
  if [ "$ok" -eq 1 ]; then
    echo "  ok   $name (expected $expected)"
    PASS=$((PASS + 1))
    [ -z "$tmp" ] || rm -rf "$tmp"
    return
  fi
  echo "  FAIL $name — expected $expected, got status=$status" >&2
  if [ -n "$marker" ]; then echo "       marker sought: $marker" >&2; fi
  # The argv and the tree are the INPUT that produced this output, and the
  # previous shape deleted the tree three lines before deciding the fixture had
  # failed — leaving "expected fail, got status=0" with nothing to inspect and,
  # for the glob fixtures, not even a record of which globs were passed. The
  # sibling `check-scripts-typecheck.test.sh` carries the same lesson about
  # destroying evidence before reporting it.
  # `%q` per argument, and the full command, so the line is a runnable
  # reproduction: `$*` word-joins unquoted, which is ambiguous for a glob
  # containing a space or a `*`, and the `cd` matters because the `--root`-ignored
  # mutation is only visible when the cwd is the repo.
  printf '       repro: (cd %q && bun %q' "$ROOT" "$GUARD" >&2
  printf ' %q' "$@" >&2
  printf ')\n' >&2
  if [ -n "$tmp" ]; then
    echo "       tree KEPT for inspection: $tmp" >&2
    KEPT=$((KEPT + 1))
  fi
  # `\n`, not `%s` bare: without the trailing newline the NEXT fixture's `FAIL`
  # line is appended to this one's last output line, so a run with several
  # failures reads as one greppable `FAIL`. Inherited, and measured here.
  printf '%s\n' "$out" | sed 's/^/       | /' >&2
  FAIL=$((FAIL + 1))
}

# check <pass|fail> <name> <setup-fn> <marker> [extra guard args...]
#
# `fail` asserts exit status 1 — the guard's own violation code — AND that the
# output contains `marker`. Anything else (a crash, a different arm firing, the
# exit-2 argument parser) is a fixture failure, and the guard's output is printed
# so the reason is visible instead of a bare `got status=1`.
#
# The guard runs from `$ROOT`, not from the fixture dir, so a `--root` the guard
# ignored would scan the real repo — which passes — and every `fail` fixture
# would go red. Measured: 23 of 24 die on that one mutation.
check() {
  local expected="$1" name="$2" setup_fn="$3" marker="$4"
  shift 4
  # A `pass` fixture cannot assert a marker — the `pass` branch never reads one —
  # so accepting a non-empty one would let a future fixture read as if it did.
  if [ "$expected" = "pass" ] && [ -n "$marker" ]; then
    echo "::error::a \`pass\` fixture cannot assert a marker (it only checks exit 0): $name" >&2
    exit 2
  fi
  # …and the mirror, which the first version left open: a `fail` fixture with an
  # EMPTY marker silently degrades to exit-code-only, which this suite's own
  # header says is insufficient because bun exits 1 on an uncaught exception too.
  if [ "$expected" != "pass" ] && [ -z "$marker" ]; then
    echo "::error::a \`$expected\` fixture MUST name a marker — exit status alone cannot tell 'the arm I meant fired' from 'the guard crashed': $name" >&2
    exit 2
  fi
  local tmp out status=0
  tmp="$(mktemp -d "$TMPROOT/case.XXXXXX")" || exit 2
  seed_tree "$tmp" || {
    echo "::error::could not seed the fixture tree at $tmp (TMPDIR full or read-only?)" >&2
    exit 2
  }
  "$setup_fn" "$tmp" || { echo "::error::fixture setup failed: $name" >&2; exit 2; }

  out="$(cd "$ROOT" && bun "$GUARD" --root "$tmp" "$@" 2>&1)" || status=$?

  local ok=1
  if [ "$expected" = "pass" ]; then
    [ "$status" -eq 0 ] || ok=0
  else
    [ "$status" -eq 1 ] || ok=0
    printf '%s' "$out" | grep -qF '[docs-brain-snippets] FAIL' || ok=0
    if [ -n "$marker" ]; then
      printf '%s' "$out" | grep -qF -- "$marker" || ok=0
    fi
  fi

  report "$ok" "$name" "$expected" "$status" "$marker" "$tmp" "$out" --root "$tmp" "$@"
  assert_tree_clean "$name"
}

# check_refuse <name> <marker> <guard args...> — exit 2 on a malformed argv.
#
# ⚠️ Its own root is whatever the args say, INCLUDING nothing, so a relaxed
# parser falls through to the real repo — which passes — and the fixture goes
# red on the status. That is the point: `parseArgs`'s strictness is what stops a
# fixture with a typo'd flag from asserting against a tree it never built, and
# without these fixtures the mechanism against fixtures-that-cannot-fail was
# itself a mechanism that could not fail. Measured: relaxing any of the four
# parser arms killed nothing in the suite.
check_refuse() {
  local name="$1" marker="$2"
  shift 2
  # ⚠️ `grep -qF -- ""` matches ANY non-empty output, so an empty marker here is
  # not merely skipped — it is structurally vacuous. And exit 2 is now SHARED
  # with `die()`: three of the parser mutations this suite kills leave the status
  # at exactly 2, so only the marker tells the refusal from the environment fault.
  if [ -z "$marker" ]; then
    echo "::error::a \`check_refuse\` fixture MUST name a marker — exit 2 alone cannot tell parseArgs' refusal from die(): $name" >&2
    exit 2
  fi
  local out status=0
  out="$(cd "$ROOT" && bun "$GUARD" "$@" 2>&1)" || status=$?
  local ok=1
  [ "$status" -eq 2 ] || ok=0
  printf '%s' "$out" | grep -qF -- "$marker" || ok=0
  report "$ok" "$name" "exit 2" "$status" "$marker" "" "$out" "$@"
  assert_tree_clean "$name"
}

# check_die <name> <setup-fn> <marker> — an unreadable INPUT is exit 2, not 1.
#
# `check_refuse`'s twin for the environment half of the taxonomy: it seeds a tree
# and passes `--root` like `check`, then breaks one input.
#
# It pins `readOrDie`'s catch — the one of `die`'s three I/O paths a fixture can
# reach. The stat and scan catches need a directory the process cannot enter, so
# deleting either `try` still reds nothing; the guard header names them.
#
# The breakage is `chmod 000`, and it is uid-dependent. EISDIR and a broken
# symlink were tried first and measured not to work: `Glob.scanSync` yields
# neither, so the file simply leaves the scan and a different arm fires. See
# `unreadable()`, which asserts its own precondition rather than degrade to
# covering nothing under root.
check_die() {
  local name="$1" setup_fn="$2" marker="$3"
  local tmp out status=0
  tmp="$(mktemp -d "$TMPROOT/case.XXXXXX")" || exit 2
  seed_tree "$tmp" || {
    echo "::error::could not seed the fixture tree at $tmp (TMPDIR full or read-only?)" >&2
    exit 2
  }
  "$setup_fn" "$tmp" || { echo "::error::fixture setup failed: $name" >&2; exit 2; }
  out="$(cd "$ROOT" && bun "$GUARD" --root "$tmp" 2>&1)" || status=$?
  local ok=1
  [ "$status" -eq 2 ] || ok=0
  printf '%s' "$out" | grep -qF -- "$marker" || ok=0
  # An environment fault must NOT print the gate's drift banner — that is the
  # whole point of the exit-1/exit-2 split, and it is what a CI operator reads.
  printf '%s' "$out" | grep -qF '[docs-brain-snippets] FAIL' && ok=0
  report "$ok" "$name" "exit 2" "$status" "$marker" "$tmp" "$out" --root "$tmp"
  assert_tree_clean "$name"
}

noop() { :; }

# --- the seeded tree is in sync ---------------------------------------------
check pass "seeded snippets match their declarations" noop ""

# --- doc side: the #5165 defect, reproduced ---------------------------------
# Delete the `audience` line from the published interface snippet. This
# reproduces main's MEMBER SET exactly — the axis this gate compares.
doc_drop_audience() {
  tweak "$1/$DOC_REL" '/^  readonly audience: BrainSourceAudienceFor<S>;$/d'
}
check fail "a snippet missing the required \`audience\` member trips the gate" \
  doc_drop_audience "MISSING from the snippet (member the real declaration has): readonly audience"

# Show a required member as OPTIONAL. A membership-only comparison would pass
# this, and "you may omit audience" is the same lie as not mentioning it.
doc_audience_optional() {
  tweak "$1/$DOC_REL" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  readonly audience?: BrainSourceAudienceFor<S>;/'
}
# The marker names the CLASSIFICATION, not just the token. `readonly audience?`
# alone is also printed by the `page:` echo line, so it would pass without the
# guard ever deciding the member was invented.
check fail "a required member published as optional trips the gate" \
  doc_audience_optional "NOT IN the real declaration (member the snippet invents): readonly audience?"

# Drop the `readonly` modifier. A snippet that says a field is mutable is the
# same class of lie as one that says it is optional.
doc_audience_mutable() {
  tweak "$1/$DOC_REL" 's/^  readonly audience: BrainSourceAudienceFor<S>;$/  audience: BrainSourceAudienceFor<S>;/'
}
check fail "a readonly member published as mutable trips the gate" \
  doc_audience_mutable "MISSING from the snippet (member the real declaration has): readonly audience"

# Rename a member in the snippet. An author copying the page writes a connector
# that does not compile.
doc_rename_member() {
  tweak "$1/$DOC_REL" 's/^  readonly catalogId: string;$/  readonly catalogID: string;/'
}
check fail "a misspelled member name in a snippet trips the gate" \
  doc_rename_member "readonly catalogID"

# INVENT a member while keeping every real one. This is the only fixture that
# exercises the `extra` direction ALONE — every other one produces `missing` at
# the same time, so without this, deleting the `extra.length === 0` arm of the
# guard leaves the suite green (measured).
doc_invent_member() {
  tweak "$1/$DOC_REL" 's/^  readonly source: S;$/  readonly source: S;\n  readonly retriesInventedByFixture: number;/'
}
check fail "a snippet inventing a member the real declaration lacks trips the gate" \
  doc_invent_member "NOT IN the real declaration (member the snippet invents): readonly retriesInventedByFixture"

# Drop one arm of the published `BrainSourceAudience` union — the second half of
# the #5165 finding, which the member comparison alone cannot see.
doc_drop_arm() {
  tweak "$1/$DOC_REL" '/^  | { readonly kind: "externally-synced" };$/d'
}
check fail "a published union missing an arm trips the gate" \
  doc_drop_arm 'MISSING from the snippet (arm the real declaration has): readonly kind:"externally-synced"'

# The ARM-level twin of the optional-member fixture above, and the only one of the
# pair that guards a FLOORED declaration. `armToken` carries the discriminant's
# own `readonly` and `?` for a measured reason — without them a snippet
# publishing `{ kind?: "reverified" }` compared EQUAL to a real
# `{ readonly kind: "reverified" }` — and dropping the `?` half killed no fixture.
doc_arm_optional_discriminant() {
  tweak "$1/$DOC_REL" 's/^  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }$/  | { readonly kind?: "reverified"; readonly reverifier: AudienceReverifier }/'
}
check fail "a union arm whose discriminant is published as OPTIONAL trips the gate" \
  doc_arm_optional_discriminant 'NOT IN the real declaration (arm the snippet invents): readonly kind?:"reverified"'

# --- code side: the interface moves, the page does not -----------------------
# The direction a feature PR actually produces.
code_add_member() {
  tweak "$1/$TYPES_REL" 's#^  readonly audience: BrainSourceAudienceFor<S>;$#  readonly audience: BrainSourceAudienceFor<S>;\n  readonly probeAddedByFixture: string;#'
}
check fail "a new member on the real interface with no page update trips the gate" \
  code_add_member "MISSING from the snippet (member the real declaration has): readonly probeAddedByFixture"

# Add a third arm to the real union and leave the page alone.
code_add_arm() {
  tweak "$1/$TYPES_REL" 's#^  | { readonly kind: "externally-synced" };$#  | { readonly kind: "externally-synced" }\n  | { readonly kind: "probe-added-by-fixture" };#'
}
check fail "a new union arm on the real declaration with no page update trips the gate" \
  code_add_arm 'MISSING from the snippet (arm the real declaration has): readonly kind:"probe-added-by-fixture"'

# --- the REFUSAL arms: "loud, never a skip" is the guard's design claim ------
# The REAL declaration becomes a shape the gate cannot read, while the page still
# publishes a snippet for it. Replacing all three refusal bodies with `continue`
# left the suite green before these three fixtures existed.
# ⚠️ The marker must name THIS arm. `"is a shape this gate cannot compare"` appears
# in the declared-opaque message too, so it could not tell the two apart — and a
# fixture that passes on the wrong arm asserts something false.
code_opaque_union() {
  tweak "$1/$TYPES_REL" 's#^  | { readonly kind: "externally-synced" };$#  | AudienceReverifier;#'
}
check fail "an opaque REAL declaration behind a published snippet trips the gate" \
  code_opaque_union "whose real declaration in"

# The PAGE rewrites its union into a form the gate cannot read, so the published
# arms silently stop being checked.
doc_opaque_union() {
  tweak "$1/$DOC_REL" 's/^  | { readonly kind: "reverified"; readonly reverifier: AudienceReverifier }$/  | ReverifiedAudienceAlias/'
}
check fail "an opaque published snippet trips the gate" \
  doc_opaque_union "snippet is a shape this gate cannot compare"

# The page publishes an INTERFACE where the real declaration is a union. The
# leftover arms are re-homed onto a NON-`Brain*` alias so this fixture reports
# only the arm it names.
doc_interface_for_union() {
  tweak "$1/$DOC_REL" 's/^type BrainSourceAudience =$/interface BrainSourceAudience {}\ntype AudienceUnusedByFixture =/'
}
check fail "an interface published against a real union trips the gate" \
  doc_interface_for_union "is declared as an interface, but"

# A snippet for a declaration that does not exist in source must FAIL rather
# than be skipped — a page documenting a deleted interface is still wrong.
doc_nonexistent() {
  tweak "$1/$DOC_REL" 's/^interface BrainSourceVendorClient {$/interface BrainSourceGoneClient {/'
}
check fail "a snippet for a nonexistent Brain* declaration trips the gate" \
  doc_nonexistent "is not an exported Brain* declaration"

# The same declaration published TWICE on one page. Its own comment calls a
# before/after pair a normal docs idiom, so last-write-wins would make the WRONG
# half invisible — yet replacing the arm with a silent skip killed no fixture.
# It was reachable only INCIDENTALLY, as the failure mode of the nested-`md` pass
# fixture below: an assertion nobody had written down.
doc_duplicate_declaration() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence \
    doc_elided_fence doc_connector_fence
}
check fail "the same declaration published twice on one page is refused" \
  doc_duplicate_declaration "declares \`BrainSourceConnector\` more than once"

# --- the roots: both globs, and the two arms only they can reach -------------
# ⚠️ ONE fixture pins BOTH default globs, and the choice of declaration is what
# does it. A second doc FILE pins the docs glob. Declaring `BrainToolReason` —
# which the seeded tree puts OUTSIDE `lib/brain/**`, exactly as the real tree
# does — pins the source glob: narrow the source side back to `lib/brain` and this
# snippet stops resolving, so the gate reports "not an exported Brain*
# declaration" instead of a drift and the marker below no longer matches.
second_doc_file() {
  cat > "$1/apps/docs/content/shared/guides/tool-reason.mdx" <<'PROBE_EOF' || return 2
---
title: Tool reasons
---

```ts
type BrainToolReason =
  | { readonly kind: "grounded" };
```
PROBE_EOF
}
# ⚠️ A RED HERE HAS THREE CAUSES, and the name and marker only name two:
#   1. the docs glob stopped reading a second file;
#   2. the source glob narrowed back to `lib/brain`;
#   3. `discriminantOf` lost its distinctness rule, which makes the real
#      `BrainToolReason` opaque so the message becomes "cannot compare" instead
#      of a drift.
# All three are worth pinning and all three are genuinely load-bearing, but a
# marker is supposed to say which arm fired — so check the guard's actual output
# before assuming this is a glob problem.
check fail "a snippet in a SECOND doc file, for a declaration OUTSIDE lib/brain, trips the gate" \
  second_doc_file "has drifted from packages/api/src/lib/tools/search-brain.ts"

# Two doc pages may legitimately publish the SAME declaration — a reference page
# and a guide. `seenInFile` is per-file for that reason; hoist it out of the docs
# loop and this ordinary case fails with a "publish one canonical snippet"
# remedy the author cannot follow.
second_doc_file_agreeing() {
  { echo '---'; echo 'title: Connector reference'; echo '---'; doc_connector_fence; } \
    > "$1/apps/docs/content/shared/guides/connector-reference.mdx" || return 2
}
check pass "the same snippet republished on a SECOND page is not a duplicate" \
  second_doc_file_agreeing ""

# The source side is `exported-only`. Widen it to `all` and this unexported
# declaration — seeded into types.ts — starts resolving, so the page stops being
# told its snippet names nothing.
doc_publishes_unexported() {
  cat >> "$1/$DOC_REL" <<'HIDDEN_EOF' || return 2

An internal shape, which is NOT exported and so is not a published contract:

```ts
interface BrainSourceHidden {
  readonly notPublished: string;
}
```
HIDDEN_EOF
}
check fail "a snippet for an UNEXPORTED Brain* declaration trips the gate" \
  doc_publishes_unexported "publishes a snippet for \`BrainSourceHidden\`, which is not an exported Brain* declaration"

# A degenerate union — two identical arms — is the only input that still reaches
# the `two arms share` refusal now that `discriminantOf` requires distinct
# tokens. Its remedy used to say "extend discriminantOf()/armToken()", which for
# this input is advice the author cannot act on; the fixture pins the remedy that
# replaced it.
code_duplicate_literal_arm() {
  tweak "$1/$TYPES_REL" 's#^export type BrainSourceAudience =$#export type BrainSourceAudience =\n  | "reverified"\n  | "reverified"; type UnusedByFixture =#'
}
check fail "a real union with two IDENTICAL arms is refused, with a followable remedy" \
  code_duplicate_literal_arm "Two arms of that union are identical, so one of them is dead."

# The source side reading NOTHING must be loud. Unreachable while the roots were
# constants: the real tree always has exported `Brain*` declarations.
check fail "a source glob that matches nothing is refused, not passed vacuously" \
  noop "no exported Brain* declarations found under" --source-glob 'packages/*/src/**/*.tsx'

# The docs side must be glob-scoped, not "every .mdx anywhere". Pointing the docs
# glob at a subtree with no contract page leaves the gate with nothing compared,
# which is the vacuity floor's job.
check fail "a docs glob that excludes the contract page trips the vacuity floor" \
  noop "no published snippet was compared for: BrainSourceConnector, BrainSourceAudience." \
  --docs-glob 'apps/docs/content/shared/reference/**/*.mdx'

# Two source files exporting one name make the comparison depend on scan order,
# so the gate refuses rather than picking one. Also unreachable while the roots
# were constants — it needs a second declaration of a real contract name.
duplicate_source() {
  mkdir -p "$1/packages/other/src" || return 2
  cat > "$1/packages/other/src/dup.ts" <<'DUP_EOF' || return 2
export interface BrainSourceVendorClient {
  readonly close: () => void;
}
DUP_EOF
}
check fail "the same Brain* name exported from two source files is refused" \
  duplicate_source "is exported from BOTH packages/api/src/lib/brain/ingest/types.ts and packages/other/src/dup.ts"

# Overlapping globs must not make a file collide with ITSELF. `scanFiles`
# de-duplicates for exactly this reason, and it is new in #5172 because the globs
# only became caller-supplied here — remove the `Set` and this reports
# `BrainSourceConnector` "exported from BOTH types.ts and types.ts", the same
# file named twice, with a rename attached as the remedy. This is also the suite's
# only proof that the glob flags are REPEATABLE.
check pass "overlapping source globs do not make a file collide with itself" noop "" \
  --source-glob 'packages/*/src/**/*.ts' --source-glob 'packages/api/src/**/*.ts'

# The `__tests__`/`__mocks__` filter. `seed_tree` puts an exported
# `BrainSourceVendorClient` under `__tests__`, so deleting the filter makes it
# collide with the real declaration and the duplicate-source arm fires — this
# `pass` goes red. The filter fires 1,376 times on a real CI run; the previous
# note claiming "no input in either tree reaches it" was measured false.
check pass "an exported Brain* name under __tests__ does not shadow the real one" noop ""

# --- the strict parser: exit 2, never a fall-back to the real repo -----------
# These have no `--root` of their own on purpose. Relax any of the arms and the
# guard falls through to the repo it is running in, which PASSES — so the fixture
# goes red on the status. That is the property `parseArgs`'s docstring claims,
# and until these existed all four arms could be deleted with the suite green.
check_refuse "an unknown argument is exit 2, not a silent fall-back to the real repo" \
  "unknown argument" --bogus x
check_refuse "a bare positional argument is refused" \
  "unknown argument" apps/docs
# The empty string is the sharp case: it is neither absent nor `-`-prefixed, and
# `resolve("")` is the process cwd — the real repo, which passes.
check_refuse "an EMPTY --root is exit 2, not the process cwd" \
  "requires a non-empty value" --root ""
check_refuse "a flag whose value is another flag is exit 2" \
  "requires a non-empty value" --source-glob --docs-glob 'x'
# `$TMPROOT`, not `/tmp`: under the mutation this kills, the guard scans the
# named root with the default globs, so the fixture's reasoning would otherwise
# depend on `/tmp/packages` not existing — a property of the machine.
check_refuse "--root given twice is exit 2, not last-wins" \
  "may be given at most once" --root "$TMPROOT" --root "$TMPROOT"
# `$GUARD` is a file that always exists, so this reaches the isDirectory() arm
# rather than the ENOENT one. The marker carries the message's own full stop:
# with that arm deleted the guard falls through to `scanFiles`, which dies with
# `ENOTDIR: not a directory` — three characters away from matching.
check_refuse "a --root that is not a directory is exit 2" \
  "is not a directory." --root "$GUARD"

# --- the environment half of the taxonomy: exit 2, never the drift code -------
#
# These two pin `readOrDie`'s catch: an input that the glob YIELDS and the read
# then fails on. Both halves matter, and the obvious breakages do not satisfy the
# first — measured: `Glob.scanSync` yields neither a directory named `types.ts`
# nor a broken symlink, so replacing the file with either simply removes it from
# the scan and the guard reports drift, which is a different arm.
#
# `chmod 000` is what remains, and it is uid-dependent. Rather than let that
# degrade into silent coverage loss under root — a fixture that cannot fail,
# which is this suite's entire subject — `unreadable` asserts its own
# precondition and fails LOUD with the reason.
unreadable() {
  chmod 000 "$1" || return 2
  if [ -r "$1" ]; then
    echo "::error::could not make $1 unreadable — this fixture needs a non-root uid (id -u = $(id -u))." >&2
    echo "::error::Refusing to report coverage of readOrDie()'s catch that this run cannot actually exercise." >&2
    return 2
  fi
}
docs_file_unreadable()   { unreadable "$1/$DOC_REL"; }
source_file_unreadable() { unreadable "$1/$TYPES_REL"; }

check_die "an unreadable DOCS file is exit 2, not drift" \
  docs_file_unreadable "could not read the docs file"
check_die "an unreadable SOURCE file is exit 2, not drift" \
  source_file_unreadable "could not read the source file"

# ── the process-wide boundary (#5243) ───────────────────────────────────────
#
# `die` covers the three I/O boundaries that route through it. Everything else
# ran at module top level with no handler, so an unexpected throw exited 1 — the
# DRIFT code — under a raw stack trace, and a CI operator reading that goes to
# `apps/docs`. `installGuardBoundary` closes it.
#
# ## Why this fixture runs a COPY of the guard rather than the guard
#
# The throw has to come from inside the guard, and no INPUT produces one: every
# I/O path is already caught, and the failure classes the issue names — a
# `RangeError` from a pathological fence, a `TypeError` from a future edit to
# `collect`/`armToken`/`describe` — are edits, not inputs. The alternative is a
# test-only escape hatch in shipped code, which is worse: it is a branch nothing
# in production reaches, sitting in the guard forever.
#
# So the mutation is applied to a copy under `mktemp -d`. That keeps #5172's rule
# intact — this suite still writes no tracked file — at the cost of one wrinkle:
# a copy outside the repo cannot resolve `typescript` or `bun`, so the case
# symlinks the real `node_modules` beside it. Measured working; without the
# symlink the copy dies on the import and the case would "pass" on the wrong
# exit code, which is why the boundary-absent run below is what decides it.
#
# ## The second run is the point
#
# Asserting "a throw exits 2" alone would pass against a guard where something
# ELSE happened to produce a 2. The case therefore runs the SAME injected throw
# with `installGuardBoundary()`'s CALL deleted and requires exit 1 — the old
# behaviour, reproduced on demand. The boundary is load-bearing exactly when
# those two runs disagree.
#
# ## What each regression looks like from here, measured
#
#   - GUT the handler (say it exits 1 instead of 2): a clean `FAIL` on this
#     case, since the first run's status is no longer 2.
#   - DELETE `installGuardBoundary()`'s call: the suite exits **2** with
#     `the installGuardBoundary() call did not appear EXACTLY once`, because the
#     second copy can no longer be built. That is a fixture-setup fault rather
#     than a case failure, and it is the right shape — the message names the
#     edit — but do not expect a `FAIL` line for it.
BOUNDARY_ANCHOR='  const found: (readonly [string, Declared])[] = [];'
BOUNDARY_THROW='  throw new TypeError("zz-boundary-probe: a future edit to collect()");'
BOUNDARY_INSTALL='installGuardBoundary();'

check_boundary() {
  local tmp guard_dir out status=0 out_off status_off=0 ok=1
  tmp="$(mktemp -d "$TMPROOT/case.XXXXXX")" || exit 2
  seed_tree "$tmp" || {
    echo "::error::could not seed the fixture tree at $tmp" >&2
    exit 2
  }

  guard_dir="$tmp/guard"
  mkdir -p "$guard_dir" || exit 2
  # Bare imports resolve by walking up from the importing FILE, so the symlink
  # has to sit beside the copy rather than at `$tmp`.
  ln -s "$ROOT/node_modules" "$guard_dir/node_modules" || exit 2

  # ⚠️ Both substitutions are checked. A silently-unmatched anchor would leave
  # the copy identical to the guard, which exits 0 on the seeded tree — and a
  # case asserting "not 0" would then pass having injected nothing.
  awk -v anchor="$BOUNDARY_ANCHOR" -v inject="$BOUNDARY_THROW" \
    'BEGIN{n=0} $0==anchor{print inject; n++} {print} END{exit n==1?0:1}' \
    "$GUARD" > "$guard_dir/probe.ts" || {
    echo "::error::the collect() anchor did not match EXACTLY once in $GUARD — update BOUNDARY_ANCHOR." >&2
    exit 2
  }
  awk -v install="$BOUNDARY_INSTALL" \
    'BEGIN{n=0} $0==install{n++; next} {print} END{exit n==1?0:1}' \
    "$guard_dir/probe.ts" > "$guard_dir/probe-no-boundary.ts" || {
    echo "::error::the installGuardBoundary() call did not appear EXACTLY once — update BOUNDARY_INSTALL." >&2
    exit 2
  }

  out="$(cd "$ROOT" && bun "$guard_dir/probe.ts" --root "$tmp" 2>&1)" || status=$?
  [ "$status" -eq 2 ] || ok=0
  printf '%s' "$out" | grep -qF 'INTERNAL ERROR (uncaught exception)' || ok=0
  printf '%s' "$out" | grep -qF 'zz-boundary-probe' || ok=0
  # An internal error must NOT print the drift banner — that split is the whole
  # taxonomy, and it is what a CI operator reads.
  printf '%s' "$out" | grep -qF '[docs-brain-snippets] FAIL' && ok=0

  # …and without the boundary the SAME throw exits 1.
  #
  # ⚠️ MARKER-CHECKED, not exit-code-only, for this file's own stated reason:
  # `bun` exits 1 on an uncaught exception, on a parse error, AND on an
  # unresolved import. Asserting only the status would let a boundary-less copy
  # that cannot even parse — a future edit interacting badly with the awk line
  # deletion, or a `node_modules` layout change on that side — satisfy "the old
  # behaviour, reproduced on demand" while reproducing nothing. This is the run
  # the case's whole argument rests on, so it gets the same discipline every
  # other failure fixture here gets.
  out_off="$(cd "$ROOT" && bun "$guard_dir/probe-no-boundary.ts" --root "$tmp" 2>&1)" || status_off=$?
  [ "$status_off" -eq 1 ] || ok=0
  # The SAME throw got out…
  printf '%s' "$out_off" | grep -qF 'zz-boundary-probe' || ok=0
  # …and nothing caught it.
  printf '%s' "$out_off" | grep -qF 'INTERNAL ERROR' && ok=0

  report "$ok" \
    "an unexpected THROW is exit 2 with an INTERNAL ERROR banner (exit 1 without the boundary; got $status_off)" \
    "exit 2" "$status" "INTERNAL ERROR (uncaught exception)" "$tmp" \
    "$out
--- boundary-ABSENT run (expected exit 1, uncaught, no banner) — status $status_off ---
$out_off" --root "$tmp"
  assert_tree_clean "boundary"
}

check_boundary

# --- the fence scanner: every silent-skip hole gets a fixture ---------------
# An INDENTED fence (the convention inside a numbered step or a JSX child) was
# skipped entirely by the first cut's column-anchored regex — the guard printed
# PASS with a drifted union live on the page.
#
# The indented emitter is also DRIFTED, and both at once is the point: asserting
# `fail` with the drift marker proves the indented fence is still both READ and
# COMPARED, where an indent-only variant would be satisfied by the vacuity floor
# and so could not tell "read" from "floored".
doc_indented_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_indented doc_audience_fence doc_vendor_fence \
    doc_elided_fence
}
check fail "an INDENTED contract fence is still read and compared" \
  doc_indented_fence "MISSING from the snippet (member the real declaration has): readonly audience"

# A MERGED fenced block — the connector fence's closing line missing, so the
# prose that follows lands inside the body. TypeScript error-recovers past it, so
# this used to drop a declaration from the comparison with the gate printing
# PASS, and the per-file fence COUNT still agreed so the arithmetic floor could
# not see it either. Caught now by reconciling the parser's output against the
# body text.
doc_merged_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_unclosed doc_audience_fence doc_vendor_fence \
    doc_elided_fence
}
check fail "a MERGED fenced block does not silently drop a declaration" \
  doc_merged_fence "and does not parse"

# A genuinely UNTERMINATED fence — the LAST fence on the page never closes, so
# nothing after it could close it either. Reported as a malformed page rather
# than swallowing the rest of the file as one snippet body.
doc_unterminated_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence_unclosed
}
check fail "an unterminated fence is reported, not silently swallowed" \
  doc_unterminated_fence "opened and never closed"

# A scanner that stopped tracking non-`ts` fences would read the nested block's
# body as published contract and report drift (or a duplicate declaration),
# turning this PASS red. Without this fixture the CommonMark fence-length rule is
# guarded only incidentally, by an unrelated page in the real tree happening to
# contain a 4-backtick block.
doc_nested_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_audience_fence doc_vendor_fence \
    doc_elided_fence doc_nested_md_block
}
check pass "a \`ts\` fence nested in a 4-backtick \`md\` block is not published contract" \
  doc_nested_fence ""

# --- vacuity: the gate must not pass by comparing nothing --------------------
# Relabel the contract fence away from ```ts. Every comparison is DISCOVERED, so
# without the floor this leaves the gate green having compared everything except
# the snippet that matters.
doc_relabel_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence_text doc_audience_fence doc_vendor_fence \
    doc_elided_fence
}
check fail "relabelling the contract fence away from \`\`\`ts trips the vacuity floor" \
  doc_relabel_fence "no published snippet was compared for: BrainSourceConnector."

# Rename the published interface so no `BrainSourceConnector` snippet exists.
# A plausible partial page: the fence is still ```ts and still parses, so only
# the floor can catch that the contract page stopped publishing its contract.
doc_rename_interface() {
  tweak "$1/$DOC_REL" 's/^interface BrainSourceConnector<S extends EpisodeSource = EpisodeSource> {$/interface ConnectorSketch {/'
}
check fail "a contract snippet renamed out of the Brain* namespace trips the vacuity floor" \
  doc_rename_interface "no published snippet was compared for: BrainSourceConnector."

# The SECOND floored name. Deleting the whole `BrainSourceAudience` fence left the
# gate green when only BrainSourceConnector was floored — so the union half of
# #5165 was unguarded by the mechanism credited with guarding it.
doc_delete_audience_fence() {
  write_doc "$1/$DOC_REL" doc_connector_fence doc_vendor_fence doc_elided_fence
}
check fail "deleting the whole BrainSourceAudience fence trips the vacuity floor" \
  doc_delete_audience_fence "no published snippet was compared for: BrainSourceAudience."

# --- the suite itself wrote nothing tracked ---------------------------------
#
# ⚠️ The CHECKPOINT COUNT is half the assertion, and without it this fixture —
# the one that asserts #5172's entire headline claim — cannot fail. Measured:
# delete every `assert_tree_clean` call from `check()` and `DIRTIED` stays 0, so
# the suite printed `ok … at any of 0 checkpoints` and reported a full pass. It
# even printed the 0. Tying the count to the number of fixtures run is what makes
# "no tracked file was mutated" a statement about the run rather than about an
# empty set.
CASES=$((PASS + FAIL))
if [ "$DIRTIED" -eq 0 ] && [ "$CHECKPOINTS" -eq "$CASES" ]; then
  echo "  ok   no tracked file was mutated at any of $CHECKPOINTS checkpoints (expected pass)"
  PASS=$((PASS + 1))
elif [ "$CHECKPOINTS" -ne "$CASES" ]; then
  echo "  FAIL the tree was checked $CHECKPOINTS times for $CASES fixtures — the assert_tree_clean call has been removed from a fixture runner, so this assertion covers less than it claims" >&2
  FAIL=$((FAIL + 1))
else
  echo "  FAIL the working tree diverged at $DIRTIED of $CHECKPOINTS checkpoints" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "check-docs-brain-snippets.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
