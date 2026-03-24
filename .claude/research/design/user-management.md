# User Management — Admin Dashboard Design Document

> Design reference for adding user management to the Atlas admin console using Better Auth's `organization()` plugin.

## Context

### What exists today

**Auth server** (`packages/api/src/lib/auth/server.ts`):
- Better Auth with `bearer()`, `apiKey()`, and `admin()` plugins
- `admin({ defaultRole: "analyst", adminRoles: ["admin"] })` — the admin plugin adds a `role` column to the `user` table and provides server-side user management APIs (list users, set role, ban/unban)
- First-user bootstrap: `ATLAS_ADMIN_EMAIL` match or first signup gets `admin` role
- Cross-subdomain cookie support for Railway split-service deployment

**Role model** (`packages/api/src/lib/auth/types.ts`):
- Three roles: `viewer`, `analyst`, `admin` (flat hierarchy, not organization-scoped)
- `AtlasUser` carries `id`, `mode`, `label`, `role?`, `claims?`
- Roles drive action approval permissions (viewer < analyst < admin)

**Admin dashboard** (`packages/web/src/app/admin/`):
- 7 pages: Overview, Semantic Layer, Connections, Audit, Plugins, Scheduled Tasks, Actions
- No Users page exists
- Admin auth preamble enforces `role === "admin"` on all `/api/v1/admin/*` routes
- Sidebar nav in `packages/web/src/ui/components/admin/admin-sidebar.tsx`

**Better Auth tables in internal DB** (`DATABASE_URL`):
- `user` (id, name, email, emailVerified, image, createdAt, updatedAt, role, banned, banReason, banExpires)
- `session` (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
- `account` (id, accountId, providerId, userId, ...)
- `apikey` (from `@better-auth/api-key` plugin)

### What's missing

No admin UI to:
1. **List users** — see who has accounts, their roles, last active
2. **Change roles** — promote/demote users (viewer/analyst/admin)
3. **Invite users** — send email invitations (requires email infra)
4. **Ban/unban** — disable accounts without deleting
5. **Delete users** — remove accounts entirely

## Decision: Better Auth `admin()` plugin vs `organization()` plugin

### Option A: Lean on existing `admin()` plugin (Recommended for now)

The `admin()` plugin is **already installed** and provides:

| API | Method | What it does |
|-----|--------|-------------|
| `listUsers` | GET | Paginated user list with sorting/filtering |
| `setRole` | POST | Change a user's role |
| `banUser` | POST | Ban with optional reason and expiry |
| `unbanUser` | POST | Remove ban |
| `removeUser` | POST | Delete user account |
| `revokeUserSessions` | POST | Force logout |

These APIs are already available via Better Auth's HTTP handler at `/api/auth/*`. The admin console just needs a UI that calls them.

**Pros:**
- Zero new dependencies or migrations
- APIs already exist and work today
- Matches Atlas's flat role model (viewer/analyst/admin)
- Simple — no organizational hierarchy to manage

**Cons:**
- No invitation system (users must self-signup)
- No organization/team scoping (all users share one flat namespace)
- No fine-grained permissions beyond the 3 Atlas roles

### Option B: Add `organization()` plugin (Future — multi-tenant)

The `organization()` plugin adds:
- **Organizations** — named groups with owner/admin/member roles
- **Invitations** — email-based invite flow with role assignment
- **Teams** — sub-groups within orgs for granular permissions
- **Custom roles** — extensible RBAC with `createAccessControl()`
- **New tables**: `organization`, `member`, `invitation` (+ optional `team`)

**When to adopt:**
- When Atlas needs multi-tenancy (multiple companies sharing one Atlas instance)
- When invitation flow is required (email onboarding)
- When team-scoped permissions are needed (e.g., team A sees tables X/Y, team B sees Z)

**Why not now:**
- Atlas deployments are single-tenant today (one company = one Atlas instance)
- Adding org hierarchy to a flat 3-role system adds complexity with no user benefit yet
- Organization roles (owner/admin/member) don't map cleanly to Atlas roles (viewer/analyst/admin) — would need a mapping layer
- Requires email infrastructure (`sendInvitationEmail` callback) which Atlas doesn't have
- Migration risk — new tables, schema changes, potential breakage

### Recommendation

**Phase 1 (now): Build the Users page using the existing `admin()` plugin APIs.** This gives admins full user management (list, role changes, ban, delete) with zero new infrastructure.

**Phase 2 (future, post-v1.0): Evaluate `organization()` when multi-tenancy is on the roadmap.** At that point, the flat role model needs rethinking anyway — orgs would likely replace or wrap the current viewer/analyst/admin hierarchy.

## Design: Users Admin Page (Phase 1)

### API Layer

The Better Auth `admin()` plugin already exposes all needed endpoints through the catch-all auth route. However, for consistency with other admin pages, we should **proxy through the Atlas admin API** rather than calling Better Auth directly from the frontend. This:

1. Keeps all admin operations behind the same auth preamble + rate limiting
2. Decouples the frontend from Better Auth's API shape
3. Allows us to enrich responses (e.g., add last query timestamp from audit_log)

#### New admin API routes (`packages/api/src/api/routes/admin.ts`)

```
GET    /api/v1/admin/users                 — List users (paginated, filterable)
GET    /api/v1/admin/users/:id             — Get single user detail
PATCH  /api/v1/admin/users/:id/role        — Change role { role: "analyst" }
POST   /api/v1/admin/users/:id/ban         — Ban user { reason?, expiresAt? }
POST   /api/v1/admin/users/:id/unban       — Unban user
DELETE /api/v1/admin/users/:id             — Delete user
POST   /api/v1/admin/users/:id/revoke      — Revoke all sessions (force logout)
GET    /api/v1/admin/users/stats           — Aggregate stats (total, by role, active)
```

Implementation: Each route calls `auth.api.*` from the Better Auth instance (server-side, no HTTP round-trip). The `getAuthInstance()` function is already available.

Example for list:
```typescript
admin.get("/users", async (c) => {
  const preamble = await adminAuthPreamble(c.req.raw, crypto.randomUUID());
  if ("error" in preamble) return c.json(preamble.error, { status: preamble.status });

  const auth = getAuthInstance();
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const search = c.req.query("search");
  const role = c.req.query("role");

  // Better Auth admin plugin's listUsers supports pagination + filtering
  const result = await auth.api.listUsers({
    query: {
      limit: Math.min(limit, 200),
      offset: Math.max(offset, 0),
      ...(search ? { searchField: "email", searchValue: search, searchOperator: "contains" } : {}),
      ...(role ? { filterField: "role", filterValue: role, filterOperator: "eq" } : {}),
      sortBy: "createdAt",
      sortDirection: "desc",
    },
  });

  return c.json({ users: result.users, total: result.total, limit, offset });
});
```

#### Self-protection rules

- **Cannot change own role** — prevent admin from demoting themselves
- **Cannot ban self** — prevent admin from locking themselves out
- **Cannot delete self** — same reason
- **Last admin guard** — prevent removing the last admin (query `user` table for admin count before demotion/deletion/ban)

### Frontend

#### New files

```
packages/web/src/app/admin/users/
  page.tsx                    — Users page (client component)
  search-params.ts            — nuqs parsers (search, role filter, pagination)

packages/web/src/ui/components/admin/
  user-table.tsx              — Data table with role badges, actions dropdown
  user-role-select.tsx        — Role selector (viewer/analyst/admin)
  user-actions-dropdown.tsx   — Per-user actions (change role, ban, revoke, delete)
  ban-dialog.tsx              — Ban confirmation with optional reason/expiry
  delete-user-dialog.tsx      — Delete confirmation dialog
```

#### Page layout

```
+---------------------------------------------------------------+
| Users                                          [Search...] [v] |
|---------------------------------------------------------------|
| Stats bar: Total users | Admins | Analysts | Viewers | Banned |
|---------------------------------------------------------------|
| Email            | Role      | Status  | Created    | Actions |
|------------------|-----------|---------|------------|---------|
| alice@co.com     | admin     | Active  | 2026-01-15 | [...]   |
| bob@co.com       | analyst   | Active  | 2026-02-01 | [...]   |
| carol@co.com     | viewer    | Banned  | 2026-02-10 | [...]   |
|---------------------------------------------------------------|
| < 1 2 3 ... >                                    50 per page  |
+---------------------------------------------------------------+
```

#### URL state (nuqs)

```typescript
// search-params.ts
import { parseAsString, parseAsInteger } from "nuqs";

export const usersSearchParams = {
  search: parseAsString.withDefault(""),
  role: parseAsString.withDefault(""),        // "" | "viewer" | "analyst" | "admin"
  page: parseAsInteger.withDefault(1),
  limit: parseAsInteger.withDefault(50),
};
```

#### Actions dropdown per user

| Action | Condition | Confirmation |
|--------|-----------|-------------|
| Change role | Not self | Inline select |
| Ban user | Not self, not banned | Dialog with reason/expiry |
| Unban user | Currently banned | Inline button |
| Revoke sessions | Not self | Confirm toast |
| Delete user | Not self | Dialog with email confirmation |

#### Role badges

- `admin` — red badge
- `analyst` — blue badge
- `viewer` — gray badge
- `banned` — yellow/warning overlay on any role badge

### Sidebar update

Add to `navItems` in `admin-sidebar.tsx`:

```typescript
{ href: "/admin/users", label: "Users", icon: Users },
```

Position: after "Audit", before "Plugins" (grouping: data stuff, then people stuff, then system stuff).

### Auth client integration

The frontend already has `authClient` from `packages/web/src/lib/auth/client.ts`. For the admin page, we call the Atlas admin API (not Better Auth directly):

```typescript
// Fetch via the standard admin API pattern used by other admin pages
const res = await fetch(`${apiUrl}/api/v1/admin/users?limit=50&offset=0`, {
  credentials: IS_CROSS_ORIGIN ? "include" : "same-origin",
});
```

## Future: Organization Plugin Migration Path (Phase 2)

When multi-tenancy becomes a requirement, here's how `organization()` would layer in:

### Schema changes

New tables (auto-migrated by Better Auth):
- `organization` (id, name, slug, logo, metadata, createdAt)
- `member` (id, organizationId, userId, role, teamId, createdAt)
- `invitation` (id, organizationId, email, role, status, inviterId, expiresAt)
- `team` (id, name, organizationId, createdAt) — if teams enabled

### Role mapping

| Better Auth org role | Atlas role | Description |
|---------------------|------------|-------------|
| `owner` | `admin` | Full control, can manage org settings |
| `admin` | `analyst` | Can query and approve actions |
| `member` | `viewer` | Read-only access |

Or define custom roles that map directly:

```typescript
import { createAccessControl } from "better-auth/plugins/access";

const ac = createAccessControl({
  query: ["execute", "view"],
  action: ["approve", "view"],
  semantic: ["edit", "view"],
  admin: ["access"],
});

const viewer = ac.newRole({ query: ["view"] });
const analyst = ac.newRole({ query: ["execute", "view"], action: ["approve", "view"] });
const admin = ac.newRole({ query: ["execute", "view"], action: ["approve", "view"], semantic: ["edit", "view"], admin: ["access"] });
```

### Email infrastructure

The `organization()` invitation system needs `sendInvitationEmail`. Options:
- **Resend** — already in the dependency tree for scheduled task email delivery (`RESEND_API_KEY`)
- Reuse the same email infra, just add an invitation template

### Migration steps

1. Add `organization()` plugin to `server.ts`
2. Run Better Auth migrations (new tables auto-created)
3. Create a "default" organization for existing users
4. Migrate existing `user.role` values to `member.role` in the default org
5. Update `managed.ts` to read role from `member` table instead of `user` table
6. Update admin UI to show org context
7. Add invitation flow to admin UI

### When to pull the trigger

Signals that multi-tenancy is needed:
- Customer requests for shared Atlas instances
- Need for team-scoped semantic layers (team A sees different tables than team B)
- Invitation-based onboarding requirement
- SSO integration where org membership maps to Atlas access

## Implementation Plan (Phase 1)

### Step 1: Admin API routes for users

Add user management routes to `packages/api/src/api/routes/admin.ts`. Use Better Auth's server-side API (`auth.api.*`). Include self-protection guards.

### Step 2: Users admin page

Create `packages/web/src/app/admin/users/page.tsx` with nuqs-managed search params, data table, role badges, and action dropdowns.

### Step 3: Admin UI components

Build `user-table.tsx`, `user-role-select.tsx`, `user-actions-dropdown.tsx`, `ban-dialog.tsx`, `delete-user-dialog.tsx` in the admin components directory.

### Step 4: Sidebar nav update

Add Users link to the admin sidebar. Update the Overview page stats to include user count.

### Step 5: Testing

- API route tests (role changes, self-protection, last-admin guard)
- Verify admin-only access enforcement
- Test pagination, search, filtering

## Dependencies

**Phase 1:** None. Everything needed is already installed.

**Phase 2 (future):**
- `better-auth` organization plugin (bundled with `better-auth`, just needs activation)
- Email infrastructure for invitations (Resend already available)

## Open Questions

1. **Should we show "last active" time?** Would need to join with `session` table or `audit_log`. Useful but adds query complexity.
2. **API key management in admin UI?** The `apiKey()` plugin is installed — should admins be able to see/revoke user API keys? Probably yes, but could be a follow-up.
3. **User creation by admin?** Better Auth's admin plugin supports `createUser`. Should admins be able to create accounts directly (bypassing signup)? Useful for managed deployments.
