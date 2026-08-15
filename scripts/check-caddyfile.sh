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

FROM_LINES="$(grep -cE '^FROM[[:space:]]+caddy:' "$DOCKERFILE" || true)"
if [ "$FROM_LINES" != "1" ]; then
  die "expected exactly one \`FROM caddy:\` line in $DOCKERFILE, found $FROM_LINES. This gate must run the SAME image that serves the file; pick one deliberately rather than letting this script choose."
fi
IMAGE="$(grep -E '^FROM[[:space:]]+caddy:' "$DOCKERFILE" | awk '{print $2}')"

command -v docker >/dev/null 2>&1 ||
  die "docker is required to validate the Caddyfile (this gate runs \`caddy validate\` in $IMAGE) and is not on PATH. Exiting 2 rather than passing a check that ran nothing."

echo "[caddyfile] validating $(basename "$CADDYFILE") with $IMAGE"

# `:ro` because a config adapter has no business writing to its input, and the
# container runs as root. `--entrypoint` is not needed — the caddy image's
# entrypoint IS `caddy`, and passing the subcommand as the command works.
if ! OUT="$(docker run --rm -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" "$IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
  echo "$OUT" >&2
  fail "$CADDYFILE is not a valid Caddy config. It would pass every other gate and then kill the docs container at boot — the Dockerfile COPYs it without adapting it."
fi

echo "[caddyfile] PASS: valid configuration"
