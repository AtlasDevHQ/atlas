## Part J: Undocumented Features Discovery (HIGH RISK)

This is the most important check — finding features that exist in code but have NO documentation at all.

### J1. New routes without docs

Discover all route files and check each has corresponding docs coverage:
```bash
# All route files in the API
ls packages/api/src/api/routes/*.ts

# All pages in the web app (feature surfaces)
find packages/web/src/app -name "page.tsx" -not -path "*/node_modules/*"
```

For each route file, search ALL THREE content trees (`grep -r <feature> apps/docs/content/`) for mentions of the feature. New route files (onboarding, demo, admin-sso, admin-usage, etc.) often ship without guide pages.

When a feature is undocumented, note which tree the missing page belongs in: SaaS/enterprise features (`ee/`-gated, platform-ops, billing, residency, marketplace) → `content/docs/`; self-hosted deploy/config features → `content/self-hosted/`; audience-neutral facts (reference, plugins, SDK, semantic layer) → `content/shared/`.

### J2. New internal DB tables without docs

Internal-DB tables are created by SQL migrations (`db/migrations/####_*.sql`), NOT inline in `internal.ts` — grep the migrations:

```bash
# All tables created by migrations — these represent features
grep -hoP "CREATE TABLE( IF NOT EXISTS)? \"?\w+" packages/api/src/lib/db/migrations/*.sql | sort -u

# When scoping to a release cycle (Part K), only the migrations added since the last tag:
git diff --name-only --diff-filter=A $(git describe --tags --abbrev=0)..HEAD -- packages/api/src/lib/db/migrations/
```

Each table represents a user-facing feature. Check if there's a corresponding docs page or section explaining the feature (usage_events → usage metering docs, sso_providers → SSO guide, demo_leads → demo mode docs, etc.)

### J3. New packages/directories without docs

```bash
# Top-level directories that may need docs
ls -d ee/ packages/*/

# New app pages (signup, demo, etc.)
find packages/web/src/app -maxdepth 1 -type d
```

Check if new top-level features (ee/, signup flow, demo mode) have corresponding docs pages.

### J4. Recently shipped features

Read `.claude/research/ROADMAP.md` and find all `[x]` items in the most recent milestone(s). For each shipped feature, verify there's a corresponding docs page or section. This catches features that were built but never documented.

---
