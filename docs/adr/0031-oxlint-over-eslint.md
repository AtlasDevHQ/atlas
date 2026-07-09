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
