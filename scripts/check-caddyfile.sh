#!/usr/bin/env bash
# check-caddyfile.sh — `deploy/docs/Caddyfile` must parse as a Caddy config (#5242).
#
# ## Why this exists
#
# `deploy/docs/Caddyfile` is the ONLY redirect layer for `apps/docs`: the site is
# `output: "export"`, which disables Next's `redirects()`. It is asserted
# extensively — but only AS TEXT, by `apps/docs/src/lib/__tests__/redirect-coverage.test.ts`
# and `security-txt-redirect.test.ts`, both of which string-match lines.
#
# Nothing parsed it as a CONFIG. A syntax error in that file:
#
#   - passes `lint`, `type`, `lint:type-aware`, `drift` and every test;
#   - is not caught by `Built image (docs)` either — the Dockerfile `COPY`s the
#     Caddyfile without adapting it, so the build is green and the container
#     dies at boot;
#   - takes the docs site down AFTER merge, on the deploy the redirects need in
#     order to exist.
#
# #5236 added 28 `redir` lines in one block, the largest single addition that
# file has ever had, which is what prompted this.
#
# ## The image is READ FROM THE DOCKERFILE, never pinned here
#
# Validation is only worth anything if it runs the binary that will actually
# serve the file. `deploy/docs/Dockerfile`'s runtime stage is digest-pinned, and
# this script extracts that exact reference — so bumping Caddy there moves this
# gate with it, and no second pin can drift. The extraction requires EXACTLY ONE
# `FROM caddy:` line; a `head -1` on several would be a silent choice between
# them. (The Dockerfile also mentions `caddy:2.10-alpine` in a comment, which is
# why the match is anchored at `FROM` rather than on the image name.)
#
# ## Docker is REQUIRED, not optional
#
# A gate that passes when its tool is missing is worse than no gate: it reads as
# "the config is valid" on a run that checked nothing. This exits 2 — the
# environment-fault code, distinct from a validation failure's 1 — so a CI
# operator can tell "the Caddyfile is broken" from "the runner has no docker".
#
# Usage: bash scripts/check-caddyfile.sh [path/to/Caddyfile]
#   The argument exists for `scripts/__tests__/check-caddyfile.test.sh`, which
#   builds throwaway configs under `mktemp -d` rather than rewriting tracked
#   source — #5172's lesson, applied at the seam from the start.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT/deploy/docs/Dockerfile"
CADDYFILE_ARG="${1:-$ROOT/deploy/docs/Caddyfile}"

die() {
  echo "[caddyfile] $1" >&2
  exit 2
}

fail() {
  echo "[caddyfile] FAIL: $1" >&2
  exit 1
}

[ -f "$DOCKERFILE" ] || die "no Dockerfile at $DOCKERFILE — has deploy/docs moved?"
[ -f "$CADDYFILE_ARG" ] || die "no Caddyfile at $CADDYFILE_ARG"

# Absolute, because `docker run -v` refuses a relative source and would
# otherwise create a named VOLUME called e.g. `deploy` — mounting an empty
# directory where the config should be, which `caddy validate` reports as a
# missing file rather than as the mount fault it is.
CADDYFILE="$(cd "$(dirname "$CADDYFILE_ARG")" && pwd)/$(basename "$CADDYFILE_ARG")"

# `grep -c` exits 1 for zero matches — the value being counted — and 2 when it
# cannot READ the file. `|| true` on both would collapse them, and the second
# prints nothing, so the message below would name no number at all.
GREP_STATUS=0
FROM_LINES="$(grep -cE '^FROM[[:space:]]+caddy:' "$DOCKERFILE")" || GREP_STATUS=$?
[ "$GREP_STATUS" -le 1 ] || die "could not read $DOCKERFILE (grep exit $GREP_STATUS) — check its permissions."
if [ "$FROM_LINES" != "1" ]; then
  die "expected exactly one \`FROM caddy:\` line in $DOCKERFILE, found $FROM_LINES. This gate must run the SAME image that serves the file; pick one deliberately rather than letting this script choose."
fi
IMAGE="$(grep -E '^FROM[[:space:]]+caddy:' "$DOCKERFILE" | awk '{print $2}')"

command -v docker >/dev/null 2>&1 ||
  die "docker is required to validate the Caddyfile (this gate runs \`caddy validate\` in $IMAGE) and is not on PATH. Exiting 2 rather than passing a check that ran nothing."

# ⚠️ A FAILING `docker run` IS NOT A VERDICT ON THE FILE, and the exit code is
# not enough to tell the two apart.
#
# `command -v docker` proves the BINARY is on PATH. It proves nothing about the
# daemon, the socket, the registry, or the image. The first cut wrote
# `if ! docker run …`, which discards the status entirely, so every one of those
# faults was reported as "your Caddyfile is not a valid Caddy config" — naming a
# tracked file that is fine. Worse than no gate: on a routine Docker Hub rate
# limit the `drift` job goes red instructing an operator to fix a correct file.
#
# ⚠️ AND BRANCHING ON THE STATUS IS ALSO NOT ENOUGH — measured, which is the
# only reason this is not still wrong. The replacement mapped ≥125 to exit 2 on
# the documented "docker uses 125 for its own faults" rule. Then the fixture for
# it went red: `DOCKER_HOST=unix:///nonexistent.sock docker run …` exits **1**
# here (docker 29.1.3), identically to `caddy validate` refusing a config. The
# status cannot separate them.
#
# So the decision is made on POSITIVE EVIDENCE THAT CADDY RAN. Caddy emits
#     {"level":"info", … ,"msg":"using config from file", …}
# the moment it reads the config — on success AND on a config error, verified
# both ways against this image. A docker fault never reaches it. No marker means
# no verdict was ever produced, whatever the exit code says.
#
#                                  first cut   status-only   now
#   valid config                   exit 0      exit 0        exit 0
#   INVALID config                 exit 1      exit 1        exit 1
#   daemon down / socket denied    exit 1      exit 1 ✗      exit 2
#   registry outage / rate limit   exit 1      exit 2        exit 2
#   exec fault (126/127)           exit 1      exit 2        exit 2
#
# Every changed row moves from asserting a verdict about the file to admitting
# there is none — the conservative direction. If a future Caddy renames that log
# line, this gate starts reporting exit 2 on genuinely invalid configs: a false
# ENVIRONMENT fault, which is loud and refuses to assert, rather than a false
# verdict about a file. That is the failure direction to prefer.
#
# The daemon and image probes come first so the common faults get their own
# message instead of arriving as an absent marker.
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "the docker daemon is not reachable (\`docker version\` failed). This is NOT a verdict on $CADDYFILE — the config was never parsed. Start docker, or check DOCKER_HOST."

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --quiet "$IMAGE" >/dev/null 2>&1 ||
    die "could not obtain $IMAGE (pull failed — registry outage, rate limit, or a bad digest). This is NOT a verdict on $CADDYFILE."
fi

echo "[caddyfile] validating $(basename "$CADDYFILE") with $IMAGE"

# `--mount` rather than `-v`: `-v` splits on `:`, so a checkout or TMPDIR path
# containing a colon becomes a malformed mount — a docker fault that used to
# arrive dressed as an invalid config. `readonly` because a config adapter has
# no business writing to its input. `--entrypoint` is not needed: the caddy
# image's entrypoint IS `caddy`, so the subcommand rides as the command.
set +e
OUT="$(docker run --rm \
  --mount "type=bind,source=$CADDYFILE,target=/etc/caddy/Caddyfile,readonly" \
  "$IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"
DOCKER_STATUS=$?
set -e

if [ "$DOCKER_STATUS" -eq 0 ]; then
  echo "[caddyfile] PASS: valid configuration"
  exit 0
fi

echo "$OUT" >&2
if printf '%s' "$OUT" | grep -qF 'using config from file'; then
  fail "$CADDYFILE is not a valid Caddy config. It would pass every other gate and then kill the docs container at boot — the Dockerfile COPYs it without adapting it."
fi
die "docker exited $DOCKER_STATUS without caddy ever reading the config (no \`using config from file\` line above). This is NOT a verdict on $CADDYFILE: the config was never parsed."
