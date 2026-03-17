Open a PR for the current branch's work. Branch, commit, push, create PR.

**Step 1: Understand what's being shipped**

Run these in parallel:
- `git status` — see all changed/untracked files
- `git diff` — see staged and unstaged changes
- `git log --oneline -5` — recent commits on this branch
- `git log --oneline main..HEAD` — all commits since branching from main
- `git branch --show-current` — current branch name

**Step 2: Identify the linked issue**

Parse the branch name for an issue number (e.g., `feat/docs-site` -> look for related issue).

If unclear, check recent commits for issue references (`#N`, `Closes #N`).

If still unclear, ask which issue this work is for.

**Step 3: Create branch if needed**

If still on `main`, create a branch. Use the convention `fix/`, `feat/`, `chore/`, or `docs/` prefix with a short descriptive slug.

If already on a feature branch, stay on it.

**Step 4: Run CI gates (mandatory)**

Run `/ci` — all five gates must pass before proceeding. If any fail, fix them before moving on.

This catches lint errors, type issues, syncpack drift, and template drift that would otherwise break CI after merge. Do NOT skip this step.

**Step 5: Stage and commit**

- Review all changes carefully. Stage files that are part of this work — prefer specific `git add <file>` over `git add -A`
- Do NOT stage `.env`, credentials, or unrelated files
- If there are already commits on the branch and no unstaged changes, skip to Step 6
- Write a concise commit message following the repo's style (check `git log --oneline -10` on main)
- If there are multiple logical changes, consider separate commits

**Step 6: Push and create PR**

1. Push the branch:
   ```
   git push -u origin <branch-name>
   ```

2. Create the PR with `gh pr create`. Title should be concise (<70 chars). Body must include `Closes #N` to auto-close the linked issue **when the PR is merged**:
   ```
   gh pr create -R AtlasDevHQ/atlas --title "..." --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   - [ ] ...

   Closes #N
   EOF
   )"
   ```

3. Add labels to the PR matching the linked issue's labels:
   ```
   gh pr edit <PR_NUMBER> -R AtlasDevHQ/atlas --add-label "feature,area: cli"
   ```

**Step 7: Confirm**

Output a summary:
- PR URL
- Issue linked
- Milestone the issue belongs to
- Any follow-up items noticed during review

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with all `gh` commands
- Never force-push or amend without asking
- **Do NOT close the issue** — `Closes #N` in the PR body handles that automatically on merge
- Do NOT run `gh issue close`
- **CI gates must pass** — `/ci` is mandatory in Step 4, not optional
