---
description: Spawn a fresh Claude session (clean context, skip-permissions, Remote Control) in detached tmux — for when /clear isn't reachable, e.g. when driving the session from the Claude iPhone app's Remote Control
---

Spawn a fresh Claude Code session the operator can switch to (typically from the Claude iPhone app's Remote Control session list). The current session keeps running until they abandon it, so nothing is lost.

1. Parse the arguments: `$ARGUMENTS`
   - First token, if present, is the tmux + Remote Control session name. Default: `atlas-rc`.
2. Launch it detached (replace any same-named tmux session first):
   ```bash
   NAME="<name>"
   REPO="$(git rev-parse --show-toplevel)"
   tmux kill-session -t "$NAME" 2>/dev/null || true
   tmux new-session -d -s "$NAME" -c "$REPO" \
     "claude --dangerously-skip-permissions --remote-control '$NAME'"
   ```
3. Verify with `tmux ls`, then tell the operator:
   - the session name to pick in the iPhone app's Remote Control list (allow ~10s for it to register)
   - `tmux attach -t <name>` for terminal access
   - that this current session stays alive until abandoned
4. If `tmux` is missing, say so and stop — don't substitute `nohup` (the session needs a TTY).

Keep the response to a few lines — this is a utility command. Note: `--dangerously-skip-permissions` is intentional here (trusted dev box, operator-invoked); don't soften it to a prompt-y mode.
