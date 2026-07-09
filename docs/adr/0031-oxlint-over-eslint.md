# Lint with oxlint, not ESLint

Atlas's linter is [oxlint](https://oxc.rs) (the Oxc project's Rust linter),
configured via `.oxlintrc.json`, replacing ESLint + `typescript-eslint` +
`@eslint/js` + `@next/eslint-plugin-next` across the monorepo and both
`create-atlas` templates. `bun run lint` now invokes `oxlint`. Decided as a
full cutover during the TypeScript 7 adoption window (see #3870, #3873).

## Context

Atlas is already an early TypeScript 7 adopter: type-checks run on the
Go-native compiler (`@typescript/native-preview`, `tsgo`). The remaining pole
on a clean single-`typescript@7` world was ESLint — `typescript-eslint` imports
the `typescript` **JS programmatic API**, which is not stable until TS 7.1, so
the repo carried `typescript@6` partly to feed the linter (#3873).

oxlint sidesteps that coupling: its syntax rules are native Rust (50–100× faster
than ESLint on the syntax pass), and its **type-aware** rules run through
`tsgolint` on `microsoft/typescript-go` directly — the same engine Atlas
already adopted — rather than embedding the `typescript` JS API inside a JS
linter. Removing `typescript-eslint` removes one of the two reasons #3873
exists (the other, `.d.ts` emit via `tsc`, still needs `typescript@6`).

The one migration risk was Atlas's three CI-enforced architectural guards, all
built on ESLint `no-restricted-syntax`/`no-restricted-imports` esquery
selectors: the FetchError-flatten guard (#1616), the `feature: FeatureName`
registry invariant (#1652), and the `@useatlas/schemas` import boundary. oxlint
does **not** implement `no-restricted-syntax` natively.

## Decision

- **Rule baseline** — `.oxlintrc.json` enables the `typescript`, `nextjs`, and
  `import` plugins at `correctness` severity, mirroring the former
  `js.recommended` + `tseslint.recommended` + `@next/next` set. The `unicorn`
  and `oxc` default plugins are **not** enabled — they were never in the ESLint
  baseline and would flood a green tree with new warnings.
- **The three guards are preserved verbatim** through the `oxlint-plugin-eslint`
  JS plugin (`jsPlugins: [{ name: "eslint-js", specifier: "oxlint-plugin-eslint" }]`),
  as `eslint-js/no-restricted-syntax` and `eslint-js/no-restricted-imports` with
  the identical selectors and messages. All three were verified firing on probe
  files before shipping. The admin override duplicates the two FetchError
  selectors alongside the two `feature` selectors, matching ESLint's flat-config
  array-replace merge semantics.
- **Type-aware linting: enabled at `warn`, burning down.** The former config
  used `tseslint.recommended` (not `recommendedTypeChecked`), so the cutover
  itself carried no type-aware rules. Post-cutover, `oxlint-tsgolint` is wired
  via a dedicated `bun run lint:type-aware` script (kept out of the fast
  blocking `bun run lint` gate — it builds TS programs and is slower) with the
  full type-aware rule set at `warn`. Initial scan: ~3,856 findings (~418 in
  non-test source, the rest in test files). **Wave 1** fixed all ~406 non-test
  findings via parallel subagents under a behavior-preserving protocol
  (floating-promises → `await` when completion matters else `void`;
  base-to-string/template-expressions → output-preserving `String()`). Rules
  stay `warn` until the test-file findings (**wave 2**) are cleared, then the
  cleared rules promote to `error`.
  - **Wave 2 (test files).** Cleared the mechanically-safe ("Class 1") findings
    across every package. `no-floating-promises` (2,084 → 0): top-level
    `mock.module(...)` → `void` (order-sensitive; runs before imports, so
    `await` would reorder), async teardown in `finally`/`afterAll` → `await`,
    unused-return fire-and-forget → `void`; one file's async assertion helpers
    (`expectInvalid`/`expectValid`) were floating entirely — some `it()`
    callbacks weren't even `async` — so the fix (`await` + `async`) surfaced
    assertions that had never run (all still pass). `require-array-sort-compare`
    (14 → 0): numeric arrays got a real `(a,b)=>a-b` comparator (latent
    lexicographic bug), string-union `.map()` results a `as string` element cast
    (pure type assertion). `no-base-to-string` (142 → 73) and
    `restrict-template-expressions` (8 → 5) narrowed only where output-preserving
    (fetch-arg unions `string|URL|Request`, known-string init bodies, `never`
    exhaustiveness guards). **Left as `warn` (false positives / config
    artifacts, not burndown targets):** `await-thenable` (753) — every site is
    `await expect(...).rejects/.resolves`, a real Promise that bun types `void`;
    stripping `await` would silently disable the assertion. `unbound-method`
    (50) — save/restore identity + method refs passed to `expect`/mocks.
    `no-base-to-string` residuals — genuine `unknown` values where a narrow
    would change output. `no-redundant-type-constituents` (42) + `tsconfig-error`
    (16) — the type-aware program can't resolve `URL`/`Request` globals or the
    base tsconfig under per-package configs (tracked separately). **Promoted
    `warn` → `error`** (now 0 repo-wide): `no-floating-promises`,
    `require-array-sort-compare`, `no-useless-default-assignment`,
    `no-duplicate-type-constituents`.
  - **Wave 3 (`await-thenable`, 753 → 0, #4437).** The 753 sites were all
    `await expect(...).rejects/.resolves.X()` false positives: `bun-types` declares
    the matcher methods reached through `.resolves`/`.rejects` as returning `void`
    (they share the synchronous `MatchersBuiltin` interface), so tsgolint sees
    `await <void>` and flags the `await` as redundant — even though at runtime those
    methods return a real thenable that MUST be awaited to enforce the assertion.
    Not a bun-1.4 bump (that is a runtime rewrite; the matcher return types on bun
    `main` are still `void`). **Fix: a repo-side `bun` patch** (`patches/bun-types@1.3.14.patch`
    via `patchedDependencies`) that rewrites only the async matcher path — a mapped type
    repoints `resolves`/`rejects` so every matcher method returns `Promise<void>`, leaving
    the synchronous `expect(x).toBe(y)` path (`void`) untouched. We chose the patch over a
    repo-side `declare module` augmentation because the augmentation only applies to files
    in a program that includes it, and the repo's programs diverge (several packages have
    no tsconfig; `packages/web` *excludes* its tests, so tsgolint builds inferred per-file
    programs for them) — the patch propagates to every test program uniformly and stays
    correct for future test files, with no per-package wiring. Because the sync path is
    preserved, `no-floating-promises` (now `error`) newly catches a missing `await` before a
    `.rejects`/`.resolves` assertion — which surfaced one real latent bug (an un-awaited,
    never-enforced rejection assertion in `lazy-loader.test.ts`). After the patch, 15
    genuine residual redundant-awaits remained (previously masked by the 753 noise) and were
    removed: `await registry.registerDirect(...)` ×11 (`registerDirect` returns `void`) and
    `await validate!(...)` ×4 (synchronous mock returns). **Promoted `await-thenable`
    `warn` → `error`** (0 repo-wide). *Caveat:* the patch is pinned to `bun-types@1.3.14`;
    a version bump that changes `test.d.ts` will fail to apply at install time (a loud,
    CI-caught failure) and the patch must be regenerated (`bun patch bun-types@<v>`).
  - **Wave 4 (config-artifact tail: `no-redundant-type-constituents` 42 → 17, #4433 + #4434).**
    Two independent fixes, each clearing findings that were *config artifacts* of the
    per-package type-aware program — not code smells the sanctioned `bun run type` (root
    tsgo) ever saw. **#4433 — `@types/json-schema` (2 findings).** `ai` re-exports
    `JSONSchema7` from `@ai-sdk/provider` ← `json-schema`, but `@types/json-schema` was
    installed nowhere in the tree (only as a nested devDep of `@ai-sdk/provider`), so
    `JSONSchema7` resolved to an **error type that acts as `any`** — which absorbed the
    `undefined` in `(t.inputSchema as JSONSchema7 | undefined) ?? {…}` at
    `canonical-eval-mcp-llm.ts:308` / `canonical-eval-tool-selection.ts:307`, tripping
    `no-redundant-type-constituents`. Fix: add `@types/json-schema` as a **root
    devDependency**; `JSONSchema7` resolves to the real interface, both findings clear
    honestly, and `bun run type` stays green (the real type introduced no new errors —
    `jsonSchema(schema)` already accepted the shape). **#4434 — sdk/react per-package
    programs (25 findings, 23 cleared).** *sdk (21 → 0):* `packages/sdk/tsconfig.json`
    extended the root config (`lib: ["esnext"]`, no `types`), and tsgolint's per-package
    program did **not** auto-include `@types/bun`, so the `URL`/`Request`/`Response` globals
    in the fetch-mock test unions (`string | URL | Request`, `Promise<Response>`) resolved
    to error-types-as-`any`. The unions themselves are **correct** — the fix is
    `compilerOptions.types: ["bun", "node"]` (mirroring `packages/api`), which makes the
    globals resolve; no test source touched. This surfaced 2 previously-masked genuine
    `no-base-to-string` warnings (`String(calls[0]?.[0])` on a now-`string | URL | Request`
    fetch arg) — left as `warn` (permanent genuine-`unknown` category). *react (3 → 1):*
    react's tsconfig already carries `lib: ["dom", …]`, so its globals resolve — these were
    **not** global-resolution findings. 2 were `AtlasMcpError` from `@useatlas/sdk`
    resolving to an error type because the standalone type-aware program (no prior build)
    hit the unbuilt `dist/index.d.ts`; fix: a `paths` mapping (`@useatlas/sdk` →
    `../sdk/src/index.ts`) so the program resolves sdk to **source**, build-order-independent
    and matching what the root program does (it includes sdk source directly). The library
    build already externalizes `@useatlas/sdk`, so the mapping only redirects the
    self-contained widget bundle to source (identical code) and the dts keeps the external
    import by name — no source leak. The 3rd react finding (`unknown | "pending"` in a
    mock-fetch signature) is a **genuine** redundant constituent — `unknown` swallows the
    `"pending"` sentinel in *any* program, config or not — so it is **not** a config
    artifact; left as `warn` per this wave's no-test-source-edits rule. **Not promoted:**
    `no-redundant-type-constituents` (17) and `tsconfig-error` (16) remain non-zero
    repo-wide (residuals in `packages/web`, `plugins/mcp`, `packages/oauth-helper`,
    `packages/api` test files + the one genuine react finding), so both stay `warn` —
    promotion to `error` is gated on 0 **repo-wide**, not 0 in the touched packages.
  - **Wave 5 (closeout: `tsconfig-error` 16 → 0, `no-redundant-type-constituents`
    17 → 0, #4432).** *tsconfig-error (16 → 0):* every finding was a plugin
    `tsconfig.json` extending `../../../tsconfig.json` — one level above the repo
    root, a path that doesn't exist — so tsgolint couldn't load the base config and
    skipped type-aware analysis of those plugins entirely. Fixed to
    `../../tsconfig.json` (16 plugins; `plugins/chat` was already correct). No plugin
    has a `build`/`type` script, so the wrong depth had been invisible outside the
    linter. **Fixing the depth un-hid the same config-artifact class inside plugins**:
    unresolved `URL`/`Request`/`RequestInit`/`Buffer` globals (root config is
    `lib: ["esnext"]` with no `types`, and tsgolint doesn't auto-include `@types/bun`)
    plus 16 previously-masked `no-floating-promises` errors, all top-level
    `mock.module(...)` (wave-2 class, fixed with `void`) except one genuinely-floating
    `plugin.initialize!(...)` in the email-digest tests whose completion gates
    `schemaReady` — that helper became `async` and its 19 call sites `await`. Fix for
    the globals: `types: ["bun", "node"]` in all 16 plugin tsconfigs (mirroring
    `packages/api` and the wave-4 sdk fix), plus a new `plugins/mcp/tsconfig.json`
    (mcp had none, so its files fell under the root program's `lib: ["esnext"]`).
    `packages/oauth-helper` got the same `types` addition (its 2 `URL`/`Request`
    findings were this class). *packages/web (9 → 0):* web's tsconfig excludes tests,
    so tsgolint built inferred per-file programs for them — no `@/*` paths mapping, so
    `FetchError`/`DashboardCard`/`KnowledgeCollectionListResponse` resolved to
    error-types-as-`any` and absorbed union members. tsgolint honors **project
    references** for file→program routing: a new `packages/web/tsconfig.test.json`
    (extends the web config, adds `types: ["bun", "node"]`, includes tests; `composite:
    true` + an emit target under gitignored `dist/` only because TS validates
    references against TS6306/TS6310 — nothing ever builds it) referenced from
    `packages/web/tsconfig.json`. The web `type` gate and `next build` still check the
    unchanged main config; web tests now get a real program (which surfaced one
    `no-meaningless-void-operator` error — a `void act(...)` whose callee now resolves
    as `void`-returning; the `void` was dropped). *The last 6 findings were genuine,
    not config artifacts* — wave 4's classification of the mcp/api residuals as config
    artifacts turned out wrong: they persist under fully-healthy programs
    (`packages/api`'s program already had `types: ["bun", "node"]`) because `unknown`
    genuinely absorbs any union partner. All six were simplified to the type-identical
    form per the wave-4 genuine-finding carve-out: `unknown | "pending"` → `unknown`
    (react), `unknown | FetchStub` ×3 → `unknown` (mcp test helper; the doc comment
    keeps the either-body-or-stub intent), `{…} | unknown` → the already-`unknown`
    initializer and `unknown | null` → `unknown` (api tests). **Promoted
    `no-redundant-type-constituents` `warn` → `error`** (0 repo-wide);
    `tsconfig-error` isn't a configurable rule (it already reports at `error`
    severity when a program fails to load) and is now also 0 repo-wide. The
    healthier programs grew the permanent-`warn` tallies (`no-base-to-string`
    75 → 113, `unbound-method` 50 → 65, `restrict-template-expressions` 5 → 10) —
    same genuine-`unknown`/save-restore classes, newly visible, still not burndown
    targets. This closes #4432.
  - **CI enforcement (post-Wave-5).** With every promotable rule at `error` and
    0 repo-wide, `bun run lint:type-aware` is wired into CI as its own parallel
    `lint-type-aware` job (joined into the required `ci` umbrella check, so a
    type-aware regression blocks merges) and into `/ci` Stage 1
    (`scripts/ci-local.sh`). It stays out of the fast `bun run lint` gate — it
    builds full TS programs. The CI job builds the four `@useatlas/*` dists
    first so tsgolint's programs resolve `@useatlas/*` imports to real types
    (missing dist ⇒ error-types-as-`any`, the wave-4/5 config-artifact class).
    The permanent `warn` residuals (~200) never fail the job.

## Consequences

- **Divergences accepted (behavior-preserving over rewrite):** oxlint's
  reimplementations of `no-unsafe-optional-chaining` and `no-control-regex` are
  stricter than ESLint's and flagged 5 sites that ESLint passed clean. Rather
  than rewrite working, ESLint-green code to satisfy a stricter reimplementation
  mid-swap, both rules were initially set to `warn`. One genuine redundancy
  oxlint's parser caught — a duplicate `import type React` in
  `admin-layout.test.tsx` — was removed. **Follow-up (post-cutover):**
  `no-control-regex` was restored to `error` after switching the one flagged
  site (tar NUL-padding strip in `bundle-archive.ts`) to a `\u0000` escape with
  a justified `oxlint-disable-next-line`. `no-unsafe-optional-chaining` stays
  `warn` — its 4 remaining sites are benign test assertions not worth the
  non-null-assertion churn.
- **Signal loss, now restored:** `@typescript-eslint/no-explicit-any` was a
  *warning* under `tseslint.recommended` and is not in oxlint's `correctness`
  set. **Follow-up (post-cutover):** re-added as `typescript/no-explicit-any:
  warn` (root + template configs), reproducing the pre-oxlint signal — existing
  `oxlint-disable` comments are honored, and new undisabled `any` warns again.
- Scaffolded projects copy `.oxlintrc.json` (create-atlas's `copyDirRecursive`
  includes dotfiles) and depend on `oxlint`; `bun run lint` works standalone.
- `typescript@6` stays for `.d.ts` emit (`packages/{types,sdk,plugin-sdk,
  webhook-publisher}`) and `packages/react`'s `tsc`. #3873's eslint half is
  resolved; its declaration-emit half remains until the TS 7.1 tooling lands.
