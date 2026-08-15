#!/usr/bin/env bash
# Adversarial fixture suite for the Caddyfile config gate (#5242).
#
# The gate under test is `scripts/check-caddyfile.sh`, which adapts
# `deploy/docs/Caddyfile` with the SAME digest-pinned Caddy that serves it. This
# suite exists because "we run `caddy validate`" is a claim about what that
# command REFUSES, and the honest way to hold it is to break the file five
# different ways and require a red each time.
#
# ## Every fixture asserts its own mutation landed
#
# The failure mode this suite is most exposed to is a `sed` that matches
# nothing: the copy then equals the real Caddyfile, which VALIDATES, and a case
# asserting "invalid" goes red for the right reason by accident — or, worse, a
# case asserting "valid" passes having mutated nothing. `mutate()` diffs the
# copy against its source and fails LOUD when they are identical. This repo has
# paid for the other shape more than once ("fixtures that agree by
# construction").
#
# ## Two exit codes, and they mean different things
#
# 1 = the config is invalid. 2 = the gate could not run (no docker, no
# Dockerfile, no Caddyfile, an ambiguous `FROM caddy:` line). A CI operator has
# to be able to tell "the docs container will not boot" from "this runner has no
# docker", so the split is asserted rather than assumed.
#
# ## Docker
#
# The discovery/argument fixtures need none. The validation fixtures do, and
# they SKIP without it — the shape `scan-image.test.sh` uses, for the same
# reason: these run in CI, where the `drift` job has docker, and the gate itself
# exits 2 rather than 0 when docker is missing, so a docker-less CI runner can
# never look green.
#
# Run locally: bash scripts/__tests__/check-caddyfile.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-caddyfile.sh"
CADDYFILE="$ROOT/deploy/docs/Caddyfile"
DOCKERFILE="$ROOT/deploy/docs/Dockerfile"

for required in "$GATE" "$CADDYFILE" "$DOCKERFILE"; do
  [ -f "$required" ] || { echo "::error::missing $required" >&2; exit 2; }
done

PASS=0
FAIL=0
pass() { echo "  ok   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL + 1)); }

TMPROOT="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 130' INT
trap 'rm -rf "$TMPROOT"; exit 143' TERM

# The tracked tree must be untouched — this suite only writes under mktemp -d.
TREE_SNAPSHOT="$(git -C "$ROOT" status --porcelain)" || exit 2

echo "check-caddyfile.test.sh — Caddy config gate (#5242)"

# ── argument / environment fixtures (no docker needed) ──────────────────────

expect_status() {
  local name="$1" want="$2"
  shift 2
  local out status=0
  out="$(cd "$ROOT" && bash "$GATE" "$@" 2>&1)" || status=$?
  if [ "$status" -eq "$want" ]; then
    pass "$name (exit $want)"
  else
    fail "$name — expected exit $want, got $status"
    printf '%s\n' "$out" | sed 's/^/       | /' >&2
  fi
}

expect_status "a Caddyfile path that does not exist is exit 2, not a validation failure" 2 \
  "$TMPROOT/nope/Caddyfile"

# A DIRECTORY is the case a bare `-f` would miss if it were ever relaxed to
# `-e`: `docker run -v <dir>:/etc/caddy/Caddyfile` mounts a directory where a
# file belongs, and caddy then reports a missing config — an environment fault
# wearing a validation failure's clothes.
mkdir -p "$TMPROOT/a-directory"
expect_status "a directory passed as the Caddyfile is exit 2" 2 "$TMPROOT/a-directory"

# ── the image really comes from the Dockerfile ──────────────────────────────
#
# Not a cosmetic check. The whole argument for this gate is that it adapts the
# config with the binary that will SERVE it; a second pin here would drift from
# `deploy/docs/Dockerfile` silently, and the gate would then be validating
# against a Caddy nobody runs.
DOCKERFILE_IMAGE="$(grep -E '^FROM[[:space:]]+caddy:' "$DOCKERFILE" | awk '{print $2}')"
if [ -z "$DOCKERFILE_IMAGE" ]; then
  fail "could not read the caddy image out of $DOCKERFILE — this suite's premise is gone"
elif grep -qF "$DOCKERFILE_IMAGE" "$GATE"; then
  fail "the gate hard-codes ${DOCKERFILE_IMAGE} instead of reading it from deploy/docs/Dockerfile"
else
  pass "the gate pins no image of its own (it reads $DOCKERFILE_IMAGE from the Dockerfile)"
fi

# ── validation fixtures (need docker) ───────────────────────────────────────

DOCKER_CASES=0
if ! command -v docker >/dev/null 2>&1; then
  # ⚠️ FATAL under CI. A skip is the right local behaviour and the wrong CI
  # behaviour: in CI it would report "10 passed" on a run that validated no
  # config at all, which is the vacuous-gate shape this suite exists to refuse.
  # Not `-n "${CI:-}${GITHUB_ACTIONS:-}"` — concatenation makes the literal
  # string `false` non-empty, so `CI=false` would read as "in CI". It fails in
  # the safe direction, but a guard whose condition means the opposite of what it
  # says is one nobody can reason about.
  if [ "${CI:-}" = "true" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error::docker is unavailable on a CI runner — the validation fixtures cannot run, and skipping them here would report a green gate that checked nothing." >&2
    exit 2
  fi
  echo "  ⊘ skipped — docker not available locally (the validation fixtures run in CI's drift job)"
else
  DOCKER_CASES=10
  # mutate <name> <sed-script> — copy the real Caddyfile, apply <sed-script>,
  # and REQUIRE the copy to differ. A sed that matched nothing would leave a
  # valid config behind and the case would assert nothing.
  #
  # ⚠️ It publishes its result through the GLOBAL `MUTATED` rather than on
  # stdout, and that is not a style choice. `dest="$(mutate …)"` runs the
  # function in a command-substitution SUBSHELL, so its `fail` incremented a
  # copy of the counter and the parent's `$FAIL` never moved — the suite printed
  # a FAIL line and still exited 0. Measured, by pointing one fixture's sed at a
  # line that does not exist: `9 passed, 0 failed`, with the failure text right
  # there in the output. A guard that reports a failure and exits green is the
  # exact shape this file exists to refuse.
  MUTATED=""
  mutate() {
    local name="$1" script="$2"
    MUTATED="$TMPROOT/$name.Caddyfile"
    cp "$CADDYFILE" "$MUTATED" || return 2
    sed -i "$script" "$MUTATED" || return 2
    if cmp -s "$CADDYFILE" "$MUTATED"; then
      fail "$name — the fixture's sed matched NOTHING, so this case would have tested a valid config. Update the pattern."
      return 1
    fi
    return 0
  }

  check_invalid() {
    local name="$1" script="$2" dest
    # ⚠️ THREE outcomes, not two. `mutate` returns 1 when it has ALREADY counted
    # a `fail` (the sed matched nothing) and 2 when SETUP broke and nothing was
    # reported at all. `|| return 0` treated them identically, so a failing
    # `cp`/`sed` produced no pass, no fail and no message — the case simply
    # evaporated.
    #
    # MEASURED, with `sed` forced to exit 1 on PATH: `5 passed, 0 failed`, exit
    # 0, against a baseline of `10 passed`. All five adversarial cases gone,
    # green. Live triggers, not hypotheticals: BSD/macOS `sed -i` requires a
    # backup-suffix argument, so every validation case is vacuous on a mac while
    # the suite reports success; a full or read-only TMPDIR does the same to `cp`.
    mutate "$name" "$script"
    case $? in
      0) ;;
      1) return 0 ;;
      *)
        fail "$name — fixture SETUP failed (cp/sed). NOTHING was tested; this is not a pass."
        return 0
        ;;
    esac
    dest="$MUTATED"
    local out status=0
    out="$(cd "$ROOT" && bash "$GATE" "$dest" 2>&1)" || status=$?
    # Exactly 1. A 2 here would mean the gate could not run, which is not the
    # same claim and must not satisfy a validation fixture.
    if [ "$status" -eq 1 ] && printf '%s' "$out" | grep -qF '[caddyfile] FAIL'; then
      pass "$name is refused"
    else
      fail "$name — expected exit 1 with a FAIL banner, got $status"
      printf '%s\n' "$out" | sed 's/^/       | /' >&2
    fi
  }

  # THE VACUITY FLOOR, and it comes first. Every case below asserts a red; if
  # the gate were red on everything they would all pass while proving nothing.
  expect_status "the REAL deploy/docs/Caddyfile validates" 0

  # An unbalanced brace — the classic hand-edit slip, and the one a text-matching
  # test cannot see at all.
  check_invalid "an unbalanced site block" '$a\
\
:9999 {\
\troot * /srv'

  # An unknown directive. A typo'd `encode` is a live risk on a file that is
  # edited by hand and never parsed.
  check_invalid "a misspelled directive" 's|^\tencode zstd gzip|\tencodee zstd gzip|'

  # A status code outside the redirect range. `redirect-coverage.test.ts` asserts
  # every retired URL is a 308 BY TEXT, so it would happily accept `3o8` — this
  # is the half only an adapter can hold.
  check_invalid "a redir with a nonsense status code" \
    '0,/^\tredir \/guides\/brain-sources /s|^\tredir \/guides\/brain-sources .*|\tredir /guides/brain-sources /guides/atlas-sources 999|'

  # An unterminated regex in a `path_regexp` matcher — the #5236 block's
  # neighbours are full of these, and a broken one is invisible to a line grep.
  check_invalid "a malformed path_regexp" \
    's|path_regexp mdxalias .*|path_regexp mdxalias ^/(.+\\.mdx$|'

  # A named matcher that is referenced and never defined. This is the failure a
  # careless rename produces, and it is the one most likely to reach main.
  check_invalid "a reference to an undefined named matcher" \
    's|^\theader @apiSearch |\theader @neverDefinedAnywhere |'

  # ── a DOCKER fault is exit 2, never a verdict on the file ─────────────────
  #
  # The case that would have caught the gate's original shape. `if ! docker run`
  # discarded the status, so a dead daemon, a registry outage or a Docker Hub
  # rate limit all exited 1 under "your Caddyfile is not a valid Caddy config" —
  # naming a tracked file that is fine. `command -v docker` cannot see any of
  # that; it only proves the binary exists.
  #
  # An unreachable socket is the SHARPEST case, not merely a representative one:
  # docker exits **1** for it — the same code `caddy validate` uses to refuse a
  # config — while registry and mount faults exit 125 and exec faults 127. The
  # status alone cannot separate a dead daemon from a broken file, which is the
  # whole reason the gate decides on the marker. See `check-caddyfile.sh`'s table.
  docker_out=""
  docker_status=0
  docker_out="$(cd "$ROOT" && DOCKER_HOST=unix:///nonexistent-caddyfile-probe.sock \
    bash "$GATE" 2>&1)" || docker_status=$?
  if [ "$docker_status" -eq 2 ] &&
    printf '%s' "$docker_out" | grep -qF 'NOT a verdict on' &&
    ! printf '%s' "$docker_out" | grep -qF 'is not a valid Caddy config'; then
    pass "an unreachable docker daemon is exit 2, not a verdict on the Caddyfile"
  else
    fail "an unreachable docker daemon — expected exit 2 and no validation verdict, got $docker_status"
    printf '%s\n' "$docker_out" | sed 's/^/       | /' >&2
  fi

  # ── the MARKER rule, on its own ────────────────────────────────────────────
  #
  # ⚠️ THE CASE ABOVE DOES NOT TEST IT. Measured: with only the unreachable-daemon
  # fixture, deleting the `docker version` probe leaves the suite at 11/11, and
  # replacing `grep -qF 'using config from file'` with `if true` ALSO leaves it at
  # 11/11 — because three redundant guards stand behind one input and whichever
  # fires first satisfies it. The marker rule is the centrepiece of the whole
  # exit-1-vs-exit-2 argument and it was the least covered thing in the file.
  #
  # A `docker` STUB on PATH is what isolates it: the daemon and image probes are
  # made to succeed, so the only thing left deciding the verdict is the marker.
  # This needs no seam in the gate — the gate calls `docker`, and PATH decides
  # which one.
  # ⚠️ The stub's `run` output is `cat`ed from a FILE, never interpolated into
  # the stub's source. The first version inlined it, and caddy's own output
  # contains double quotes — `{"level":"info","msg":"using config from file"}` —
  # which closed the stub's quoting and word-split the JSON into `config`, `from`,
  # `file}` on separate lines. The marker then never matched and the POSITIVE
  # control failed, which is the fixture lying about the gate.
  stub_docker() {
    local dir="$1" run_status="$2" run_out="$3"
    mkdir -p "$dir" || return 2
    printf '%s\n' "$run_out" > "$dir/run-output" || return 2
    cat > "$dir/docker" <<STUB
#!/usr/bin/env bash
case "\$1" in
  version) echo "99.9.9"; exit 0 ;;
  image)   exit 0 ;;
  run)     cat "$dir/run-output"; exit $run_status ;;
esac
exit 0
STUB
    chmod +x "$dir/docker"
  }

  check_marker() {
    local name="$1" run_status="$2" run_out="$3" want="$4" marker="$5"
    local dir="$TMPROOT/stub-$want-$run_status" out status=0
    stub_docker "$dir" "$run_status" "$run_out" || {
      fail "$name — could not build the docker stub"
      return 0
    }
    out="$(cd "$ROOT" && PATH="$dir:$PATH" bash "$GATE" 2>&1)" || status=$?
    if [ "$status" -eq "$want" ] && printf '%s' "$out" | grep -qF -- "$marker"; then
      pass "$name"
    else
      fail "$name — expected exit $want containing '$marker', got $status"
      printf '%s\n' "$out" | sed 's/^/       | /' >&2
    fi
  }

  # A caddy that exits 0 having adapted NOTHING — a base image that gains an
  # ENTRYPOINT, a `validate` that becomes a deprecating no-op, a `FROM caddy:`
  # repointed at a wrapper. Exit 0 must NOT be taken as a verdict. This is the
  # false-GREEN direction, the one the gate must never produce.
  check_marker "exit 0 with no marker is exit 2, not a PASS" 0 "some unrelated output" \
    2 "without caddy ever reading the config"

  # …and the failure direction: a nonzero exit with no marker is an environment
  # fault, not a verdict on the file.
  check_marker "exit 1 with no marker is exit 2, not a verdict" 1 "docker: something broke" \
    2 "NOT a verdict on"

  # The positive control. Without it, a gate hard-wired to exit 2 would satisfy
  # both rows above — the marker must still be able to produce a real verdict.
  check_marker "exit 1 WITH the marker is a genuine validation failure" 1 \
    '{"level":"info","msg":"using config from file"}
Error: adapting config using caddyfile: bad' \
    1 "is not a valid Caddy config"
fi

# ── the case count must match ───────────────────────────────────────────────
#
# Without this a vanished case is invisible: the summary prints whatever ran,
# and "5 passed, 0 failed" reads exactly like success. The sibling
# `check-docs-brain-snippets.test.sh` pins its checkpoint count for the same
# reason.
#
# THREE argv/image cases, plus 10 when docker is present (the real-file floor,
# five refusals, the docker-fault case, and three marker cases). The tracked-tree
# check is NOT in the total: it runs after this line, which is deliberate — it
# has to observe every case's writes, including this one's.
#
# ⚠️ An ABSOLUTE literal, not a count derived from the run. `check-docs-brain-snippets.test.sh`
# compares two numbers that BOTH move when a fixture vanishes, so deleting a case
# there leaves it green — measured, `40 passed, 0 failed`. An earlier version of
# this comment cited that suite as the precedent for this floor; it is the
# counter-example.
EXPECTED_CASES=$((3 + DOCKER_CASES))
if [ "$((PASS + FAIL))" -ne "$EXPECTED_CASES" ]; then
  fail "expected $EXPECTED_CASES cases, ran $((PASS + FAIL)) — a case VANISHED (a setup fault returning early?), which is not a pass"
fi

# ── the tracked tree must be untouched ──────────────────────────────────────
NOW="$(git -C "$ROOT" status --porcelain)" || exit 2
if [ "$NOW" = "$TREE_SNAPSHOT" ]; then
  pass "no tracked file was mutated"
else
  fail "the working tree changed while running this suite — it must only write under mktemp -d"
  diff <(printf '%s\n' "$TREE_SNAPSHOT") <(printf '%s\n' "$NOW") | sed 's/^/       | /' >&2
fi

echo ""
echo "check-caddyfile.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
