# Docs portal audience taxonomy (`apps/docs`)

The docs site is segmented into three route sections (PRD #4257):

| Section         | Mount          | Content root           | Audience class     |
| --------------- | -------------- | ---------------------- | ------------------ |
| SaaS / Cloud    | site root `/`  | `content/docs/**`      | `saas-only`        |
| Self-Hosted     | `/self-hosted` | `content/self-hosted/**` | `self-hosted-only` |
| API reference   | `/api-reference` | (generated, inside `content/docs`) | `saas-only` |
| Shared concepts | both trees     | `content/shared/**`    | `shared`           |

Every content file resolves to **exactly one** audience class. This is the
machine-checked contract that keeps a SaaS reader from ever seeing self-hosted
quirks and vice versa.

## Classification (directory manifest)

Classification is driven by the content-root directory, declared once in the
`CONTENT_ROOTS` manifest in
[`src/lib/audience-taxonomy.ts`](../../apps/docs/src/lib/audience-taxonomy.ts).
The directory a file lives in **is** its audience class — there is no per-file
`audience:` line to forget on the hundreds of `content/docs` pages (including the
generated `api-reference/` tree).

You MAY still add an explicit `audience:` frontmatter field
(`saas-only | self-hosted-only | shared`) to a page to document its class. When
present it is checked to **agree** with the directory; a contradiction (e.g. a
`content/docs/*` page that declares `audience: shared`) is a hard build error.

The gate runs at build time in
[`src/lib/source.ts`](../../apps/docs/src/lib/source.ts) via
`validateContentTaxonomy`, which **fails `next build`** on:

- **missing** classification — an orphan file under no known content root;
- **invalid** classification — an `audience:` value outside the three classes;
- **ambiguous** classification — an `audience:` that contradicts the directory.

Pure logic is unit-tested in
[`__tests__/audience-taxonomy.test.ts`](../../apps/docs/src/lib/__tests__/audience-taxonomy.test.ts)
with synthetic entries (no generated `.source/server` needed).

## Build-time conditionals — `<WhenSaaS>` / `<WhenSelfHosted>`

A `shared` page authored **once** can adapt per mount using the two conditional
components from [`src/lib/audience.tsx`](../../apps/docs/src/lib/audience.tsx):

```mdx
<WhenSaaS>
  Cloud-only guidance (billing, regions, …).
</WhenSaaS>

<WhenSelfHosted>
  Self-hosted-only guidance (Docker, BYO auth, …).
</WhenSelfHosted>
```

These resolve at **route/build time** from the audience injected by
`AudienceProvider` (the SaaS root injects `saas`; `/self-hosted` injects
`self-hosted`). On the SaaS mount `<WhenSelfHosted>` renders `null`, so the
self-hosted branch is **absent from the emitted static HTML** — not hidden with
CSS, not a reader-facing tab. A reader can never toggle to the other audience's
branch because it was never sent to them. This is the segmentation's core
security invariant; it is proven two ways:

- a render-string test
  ([`__tests__/audience-conditionals.test.tsx`](../../apps/docs/src/lib/__tests__/audience-conditionals.test.tsx))
  asserts the omitted branch's token is absent from the rendered HTML string;
- the static export (`bun run build`) is grepped: the token in a shared page's
  `<WhenSelfHosted>` block appears in the `/self-hosted` HTML output but **not**
  in the site-root HTML, and vice versa.

## Fork-marker convention

Prefer single-sourcing a concept into `content/shared/` (full presence, one
file, no drift). Sometimes, though, a topic genuinely needs **two different
pages** — one for each audience — because the guidance diverges (a "fork"). To
keep two divergent files instead of single-sourcing, mark **both** with the same
`fork:` key:

```yaml
# content/docs/deployment.mdx
---
title: Deployment
fork: deployment
---
```

```yaml
# content/self-hosted/deployment.mdx
---
title: Deployment
fork: deployment
---
```

The `fork:` key is a stable string shared by the two members of an intentional
divergence. It exists so a reviewer can tell a **deliberate fork** apart from a
**forgotten sync** (someone copied a page into both trees and now edits both).

The check (`detectForkViolations` / `assertNoUnmarkedForks`, run in the same
build-time gate) considers the same topic slug appearing across the `saas-only`
and `self-hosted-only` trees:

- **both members carry the same `fork:` key** → recognized intentional fork, OK;
- **no marker / only one side marked** → flagged as an un-marked duplicate
  (single-source it into `content/shared/`, or declare the fork);
- **members carry different keys** → flagged as mismatched.

Section landing pages (`index`) and `shared/` pages are never fork candidates —
each section owns its landing page, and shared pages are single-sourced by
construction.
