# Playwright E2E Tests for Testing Spike

> Use this prompt to create Playwright e2e tests covering the remaining browser-dependent items from `.claude/research/TESTING-SPIKE.md`.

---

## Task

Write a Playwright e2e test suite in `e2e/` that automates the browser-dependent items from the manual testing spike. Dev should be running on :3000/:3001 with simple demo data. Admin login: `admin@atlas.dev / atlas-dev`.

## Setup

- Check if Playwright is already in `e2e/` — if so, extend it. If not, set it up: `bun add -d @playwright/test` at the root, create `e2e/playwright.config.ts` targeting `http://localhost:3000`.
- Use a global setup that logs in as admin and saves storage state (reuse across tests).
- Tests should be independent and parallelizable where possible.

## Tests to Write

### 1. Chat — Charts (`e2e/charts.spec.ts`)

Test that queries produce the correct chart types:

```
| Query | Expected Chart | Assertion |
|-------|---------------|-----------|
| "companies by industry" | bar chart | `.recharts-bar-rectangle` elements exist |
| "accounts created per month" | line chart | `.recharts-line` or `.recharts-curve` exists |
| "show me plan distribution" | pie chart | `.recharts-pie-sector` elements exist |
| any chart result | toggle | click table/chart toggle, verify both views render |
```

Flow for each:
1. Navigate to `/`, ensure logged in
2. Type question in chat input (`textarea` or `[data-testid="chat-input"]`)
3. Submit (Enter or click send button)
4. Wait for streaming to finish (wait for the assistant message to stop updating, or wait for a SQL result card to appear)
5. Assert chart SVG elements exist within the result
6. For toggle: click the table/chart toggle button, verify the alternate view renders

Notes:
- The chat uses Vercel AI SDK streaming — messages appear incrementally
- Chart detection is in `packages/web/src/ui/components/chart/chart-detection.ts` — read it to understand what data shapes trigger which chart types
- SQL result cards contain the chart. Look for the result card container first, then chart elements inside it
- Area, stacked bar, scatter may not trigger with simple demo data — skip if data shape doesn't match. Test what's possible with 3 tables (companies, people, accounts)

### 2. Conversations (`e2e/conversations.spec.ts`)

```
| Action | Assertion |
|--------|-----------|
| Ask a question | Conversation appears in sidebar |
| Click "New Chat" | Input clears, new conversation created |
| Click a previous conversation | Messages from that conversation load |
| Star a conversation | Star icon fills, appears in starred filter |
| Unstar | Star icon unfills, disappears from starred filter |
| Delete conversation | Confirm modal appears, conversation removed from sidebar |
```

Flow:
1. Ask 2-3 different questions to create multiple conversations
2. Verify sidebar shows them
3. Click "New Chat", verify clean state
4. Click back on first conversation, verify its messages reload
5. Star/unstar via the star icon in the sidebar item
6. Delete via the delete button/icon, confirm in modal

### 3. Auth Flows (`e2e/auth.spec.ts`)

```
| Flow | Steps |
|------|-------|
| Login | Navigate to /, fill email/password, submit, verify chat UI loads |
| Logout | Click user menu/avatar, click logout, verify redirected to login |
| Re-login | After logout, login again, verify session works |
| Sign up | Navigate to sign-up, create new user, verify gets analyst role |
| Password change | If password_change_required, verify the change password prompt appears and works |
```

Notes:
- The login form is rendered by the Next.js frontend using Better Auth React client
- Look for form elements: email input, password input, submit button
- After login, the chat UI should be visible (chat input, sidebar)

### 4. Admin Console (`e2e/admin.spec.ts`)

```
| Page | Route | Assertions |
|------|-------|------------|
| Overview | /admin | Health badges visible, stats cards with numbers |
| Connections | /admin/connections | Default connection listed, test button works |
| Semantic | /admin/semantic | Entity list loads, click entity shows detail |
| Audit | /admin/audit | Table with query entries, pagination controls |
| Users | /admin/users | User list, invite button, role badges |
| Tokens | /admin/tokens | Usage summary cards, trend chart |
| Settings | /admin/settings | Settings form with sections, save button |
```

Flow:
1. Navigate to `/admin` (must be admin role)
2. For each page: navigate, wait for content, assert key elements

### 5. Schema Explorer (`e2e/schema-explorer.spec.ts`)

```
| Action | Assertion |
|--------|-----------|
| Open schema explorer | Panel appears with entity list |
| Search "comp" | Only "companies" shown |
| Clear search | All 3 entities shown |
| Click entity | Detail panel with dimensions, joins, sample values |
| Close and reopen | State resets (no entity selected, search cleared) |
```

Notes:
- Schema explorer is opened via a button in the chat UI (look for database/schema icon)
- The search input has placeholder "Search tables..."
- Entity detail shows in a sub-panel or expanded section

### 6. Mobile Responsive (`e2e/mobile.spec.ts`)

```
| Viewport | Assertions |
|----------|------------|
| 375x667 (iPhone SE) | Sidebar collapsed, chat input visible, can type and submit |
| 768x1024 (iPad) | Sidebar may be visible, layout not broken |
```

Use `page.setViewportSize()` before navigating.

### 7. Production Smoke (`e2e/production.spec.ts`)

Target `https://app.useatlas.dev` instead of localhost:

```
| Check | Assertion |
|-------|-----------|
| Landing page loads | useatlas.dev returns 200, has expected content |
| Docs site loads | docs.useatlas.dev returns 200, search works |
| App loads | app.useatlas.dev shows login page |
| API health | api.useatlas.dev/api/health returns ok |
```

Note: Don't test login on production (credentials are different). Just verify pages load.

## Implementation Notes

- Use `page.waitForSelector()` or `page.locator().waitFor()` for streaming responses
- For chat streaming, a good heuristic is waiting for the "stop generating" button to disappear, or waiting for `.recharts-wrapper` to appear
- Add reasonable timeouts (30s for chat responses — LLM can be slow)
- Use `test.describe.serial()` for tests that depend on conversation state
- Tag tests: `@local` for localhost tests, `@production` for prod smoke tests
- Config should support running against different base URLs via env var

## File Structure

```
e2e/
├── playwright.config.ts
├── global-setup.ts          # Login + save storage state
├── auth.spec.ts
├── charts.spec.ts
├── conversations.spec.ts
├── admin.spec.ts
├── schema-explorer.spec.ts
├── mobile.spec.ts
└── production.spec.ts
```
