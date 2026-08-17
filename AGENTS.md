# AGENTS.md

**Read [CLAUDE.md](CLAUDE.md).** It is the single maintained source for this repo's rules,
architecture, commands and conventions, regardless of which harness you are.

This file used to be a 32 KB parallel copy of that content for Codex. It was cut to a
pointer on 2026-08-17, because the copies had drifted into disagreeing about a gate that
blocks merges: this file claimed type-aware linting was *"available but off by default"*,
while `.github/workflows/ci.yml` runs `lint-type-aware` under the `ci` umbrella and its own
comment states that a type-aware regression blocks merges. An agent trusting the stale copy
skips a required gate — which is the exact failure CLAUDE.md cites from #5083.

Only what is genuinely harness-specific lives here. Everything else has one copy.

## Codex on Windows + WSL

- This checkout lives in WSL. When Codex runs from Windows, prefer WSL-native commands with `wsl -d Ubuntu --cd <checkout-path> bash -lc '...'` instead of running Git/Bun against the `\\wsl.localhost\...` UNC path. Several checkouts exist in parallel under `/home/msywu/oss/atlas/` — use the one you were invoked in, never a hardcoded sibling.
- Use WSL Git for this repo. Windows Git cannot safely reset or checkout Linux symlinks such as `brand.css` workspace links.
- Use the Linux Bun binary first in PATH: `PATH=/home/msywu/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. This prevents package lifecycle scripts from resolving to the Windows Bun shim and falling back to `cmd.exe`.
- Example: `wsl -d Ubuntu --cd /home/msywu/oss/atlas/ide bash -lc 'bun install'`.
