# Publish

Publish `@useatlas/*` packages to npm. Bump versions, push tags, verify workflow runs, and confirm packages landed.

**Run when shipping a new version** of one or more packages to npm.

---

**Step 1: Determine what to publish**

Run these in parallel:

1. Current published versions:
   ```bash
   for pkg in types create create-plugin sdk plugin-sdk react clickhouse snowflake duckdb mysql salesforce e2b daytona nsjail sidecar vercel-sandbox slack webhook teams email jira yaml-context; do
     npm view "@useatlas/$pkg" version 2>/dev/null && echo "  @useatlas/$pkg" || echo "  @useatlas/$pkg (not published)"
   done
   ```

2. Current local versions:
   ```bash
   # Core packages
   jq -r '.version' packages/types/package.json && echo "  types"
   jq -r '.version' create-atlas/package.json && echo "  create-atlas"
   jq -r '.version' create-atlas-plugin/package.json && echo "  create-atlas-plugin"
   jq -r '.version' packages/sdk/package.json && echo "  sdk"
   jq -r '.version' packages/plugin-sdk/package.json && echo "  plugin-sdk"
   jq -r '.version' packages/react/package.json && echo "  react"
   # Plugins
   for plugin in clickhouse snowflake duckdb mysql salesforce e2b daytona nsjail sidecar vercel-sandbox slack webhook teams email jira yaml-context; do
     jq -r '.version' "plugins/$plugin/package.json" && echo "  $plugin"
   done
   ```

3. Recent publish workflow runs:
   ```
   gh run list -R AtlasDevHQ/atlas --workflow publish.yml --limit 5 --json status,conclusion,name,createdAt,databaseId,headBranch
   ```

4. Existing tags (to avoid conflicts):
   ```
   git tag --list '*-v*' | sort -V | tail -20
   ```

**Step 2: Plan the publish**

Compare local vs published versions. Present a table:

```
## Publish Plan

| Package | Published | Local | Action |
|---------|-----------|-------|--------|
| @useatlas/sdk | 0.0.6 | 0.0.7 | PUBLISH |
| @useatlas/clickhouse | 0.0.5 | 0.0.5 | skip (same version) |
| @useatlas/email | 0.0.6 | 0.0.7 | PUBLISH |
| ... | ... | ... | ... |

Packages to publish: N
Tags to push: sdk-v0.0.7, email-v0.0.7, ...
```

If local versions match published versions and the user wants to publish:
- Ask which packages need a bump
- Suggest the next patch version (0.0.X+1)
- Offer to bump all or selected packages

Wait for user confirmation before proceeding.

**Step 3: Bump versions (if needed)**

For each package that needs a bump:

```bash
# Update package.json version
# Use jq for precision — don't hand-edit
cd <package_dir>
jq '.version = "X.Y.Z"' package.json > package.json.tmp && mv package.json.tmp package.json
```

After all bumps:
```bash
git add <all bumped package.json files>
git commit -m "chore: bump <packages> to <version>"
git push
```

**Step 4: Push tags (one at a time)**

**CRITICAL: Push tags one at a time with a delay.** GitHub Actions silently drops workflows when many tags arrive in a single push.

```bash
# Generate and push tags sequentially
for tag in <tag1> <tag2> <tag3>; do
  git tag "$tag"
  git push origin "$tag"
  echo "Pushed $tag — waiting 3s for GitHub to register..."
  sleep 3
done
```

**Tag naming convention:**

| Package | Tag pattern | Example |
|---------|------------|---------|
| `@useatlas/types` | `types-v*` | `types-v0.0.2` |
| `create-atlas-agent` | `atlas-agent-v*` | `atlas-agent-v0.3.3` |
| `create-atlas-plugin` | `atlas-plugin-v*` | `atlas-plugin-v0.1.1` |
| `@useatlas/sdk` | `sdk-v*` | `sdk-v0.0.7` |
| `@useatlas/plugin-sdk` | `plugin-sdk-v*` | `plugin-sdk-v0.0.7` |
| `@useatlas/react` | `react-v*` | `react-v0.0.2` |
| `@useatlas/<plugin>` | `<plugin>-v*` | `clickhouse-v0.0.6` |

**Publish order:** `types` must be published before `sdk` or `react` (they depend on it).

**Step 5: Verify workflows triggered**

After all tags are pushed, verify each workflow run was created:

```bash
sleep 10  # Give GitHub a moment to register all runs
gh run list -R AtlasDevHQ/atlas --workflow publish.yml --limit <N> --json status,conclusion,createdAt,headBranch
```

For each expected tag, confirm a workflow run exists. If any are missing:
- The tag may have been silently dropped — delete and re-push it:
  ```bash
  git push origin :refs/tags/<tag>  # delete remote tag
  sleep 3
  git push origin <tag>             # re-push
  ```

**Step 6: Wait for completion and verify**

Poll until all runs complete (check every 30s, max 5 minutes):

```bash
gh run list -R AtlasDevHQ/atlas --workflow publish.yml --limit <N> --json status,conclusion,databaseId
```

If any run fails, get the logs:
```bash
gh run view <run_id> -R AtlasDevHQ/atlas --log-failed 2>&1 | tail -30
```

**Common failure causes:**
- OIDC token not configured for this package on npm (check trusted publishers)
- Package name collision (someone else published the name)
- `--frozen-lockfile` failed (lockfile drift — run `bun install` and push)
- Build/test failure in sdk or plugin-sdk (they build+test before publish)

After all runs succeed, verify packages landed:

```bash
for pkg in <published_packages>; do
  npm view "@useatlas/$pkg" version
done
```

**Step 7: Report**

```
## Publish Results

| Package | Version | Tag | Workflow | npm |
|---------|---------|-----|----------|-----|
| @useatlas/sdk | 0.0.7 | sdk-v0.0.7 | ✓ passed | ✓ live |
| @useatlas/email | 0.0.7 | email-v0.0.7 | ✓ passed | ✓ live |
| ... | ... | ... | ... | ... |

All N packages published successfully.
```

---

**New packages — initial manual publish required:**

OIDC trusted publishing only works for packages that already exist on npm. When publishing a **brand-new** `@useatlas/*` package for the first time:

1. Ask the user for a temporary npm access token (create at https://www.npmjs.com/settings/tokens)
2. Publish manually from the package directory:
   ```bash
   cd plugins/<name> && npm publish --access public --registry https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=<TOKEN>
   ```
3. After the initial publish, configure trusted publishing on npmjs.com:
   - Go to the package settings page → "Publishing access"
   - Add a GitHub Actions trusted publisher:
     - Repository: `AtlasDevHQ/atlas`
     - Environment: `npm`
     - Workflow: `publish.yml`
4. Remind the user to **revoke the temporary token** immediately after use
5. Ensure the publish workflow (`.github/workflows/publish.yml`) has the tag trigger and publish step for the new package — if not, add them before the first tag-based publish

After initial setup, all subsequent publishes work automatically via tags.

---

**Rules:**
- Always use `-R AtlasDevHQ/atlas` with `gh` commands
- **Never push multiple tags in a single `git push` command** — workflows silently drop
- Always verify the workflow actually triggered for each tag
- Don't publish without user confirmation — wrong versions on npm are hard to undo
- If a publish fails, don't retry blindly — check the error first
- Tags are always cut from main — never push a tag from a feature branch
- Core packages (types, sdk, plugin-sdk, react) build before publish; sdk and plugin-sdk also test; plugins ship raw TypeScript
- npm uses OIDC trusted publisher — no tokens needed, but the GitHub environment must be `npm`
- After publishing, npm may take 1-2 minutes to propagate — `npm view` may lag slightly
