import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // `useAdminMutation` returns a structured `FetchError` (status/code/
  // requestId) on both `MutateResult.error` and hook-level `error`.
  // Re-wrapping as `{ message: X.error }` flattens it back to a bare string
  // and breaks `friendlyError()` HTTP-status translation + `EnterpriseUpsell`
  // routing on EE 403s. Two selectors cover the common variants:
  //   - Member access:   { message: x.error }, { message: x.error, code: 'c' },
  //                      { message: x.error.message }, { message: a.b.error.c }
  //   - Optional chain:  { message: x?.error }, { message: x.error?.message },
  //                      { message: x?.error?.message }
  // The Identifier-aliased form (`const e = x.error; setError({ message: e })`)
  // requires data-flow analysis ESLint can't do via selectors — relying on
  // code review for that variant is an accepted gap. Function-wrapped uses
  // (e.g. `{ message: friendlyError(x.error) }`) are NOT flagged: the
  // `[value.type='MemberExpression']` / `[value.type='ChainExpression']`
  // filter on the Property gates the descendant search, so a CallExpression
  // value short-circuits both selectors. Don't drop those filters or the
  // function-wrapped carve-out goes away.
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ObjectExpression > Property[key.name='message'][value.type='MemberExpression'] MemberExpression[property.name='error']",
          message:
            "Do not flatten a mutation `.error` into `{ message: x.error }` — useAdminMutation surfaces a structured FetchError (status/code/requestId). Pass it straight to setError() / AdminContentWrapper, or convert to a string via friendlyError() / friendlyErrorOrNull().",
        },
        {
          selector:
            "ObjectExpression > Property[key.name='message'][value.type='ChainExpression'] MemberExpression[property.name='error']",
          message:
            "Do not flatten a mutation `.error` chain into `{ message: x?.error }` — useAdminMutation surfaces a structured FetchError. Pass it straight to setError() / AdminContentWrapper, or convert to a string via friendlyError() / friendlyErrorOrNull().",
        },
      ],
    },
  },
  // Admin components must type their `feature` prop as `FeatureName` from
  // `@/ui/components/admin/feature-registry`, never `string`. The registry
  // is the `tsgo`-enforced source of truth for user-visible feature labels
  // (see #1652, win #43) — a `feature: string` slot reopens the typo-lands-
  // in-banner-copy regression the registry closes. This rule enforces the
  // "new admin surface joins the registry" invariant that TS alone can't
  // express: TS catches bad *values* for `feature: FeatureName`, but it
  // can't complain if a new component widens back to `string`. Scoped to
  // admin/ directories so unrelated `feature: string` props are unaffected.
  //
  // The `no-restricted-syntax` rule is array-valued, so ESLint's flat-config
  // merge semantics mean this block *replaces* the broader `packages/web/**`
  // rule above. Both FetchError-flattening selectors are duplicated here so
  // admin files keep the structured-error protection they had before.
  {
    files: [
      "packages/web/src/ui/components/admin/**/*.{ts,tsx}",
      "packages/web/src/app/admin/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ObjectExpression > Property[key.name='message'][value.type='MemberExpression'] MemberExpression[property.name='error']",
          message:
            "Do not flatten a mutation `.error` into `{ message: x.error }` — useAdminMutation surfaces a structured FetchError (status/code/requestId). Pass it straight to setError() / AdminContentWrapper, or convert to a string via friendlyError() / friendlyErrorOrNull().",
        },
        {
          selector:
            "ObjectExpression > Property[key.name='message'][value.type='ChainExpression'] MemberExpression[property.name='error']",
          message:
            "Do not flatten a mutation `.error` chain into `{ message: x?.error }` — useAdminMutation surfaces a structured FetchError. Pass it straight to setError() / AdminContentWrapper, or convert to a string via friendlyError() / friendlyErrorOrNull().",
        },
        {
          selector:
            "TSPropertySignature[key.name='feature'] > TSTypeAnnotation > TSStringKeyword",
          message:
            "Admin components must type `feature` as `FeatureName` from @/ui/components/admin/feature-registry, not `string`. A string slot reopens the typo-in-banner-copy regression the registry closes (#1652).",
        },
        {
          selector:
            "TSPropertySignature[key.name='feature'] > TSTypeAnnotation > TSUnionType > TSStringKeyword",
          message:
            "Admin components must type `feature` as `FeatureName` from @/ui/components/admin/feature-registry. Widening to `FeatureName | string` collapses to `string` and reopens the typo regression.",
        },
      ],
    },
  },
  // `@useatlas/schemas` is the one-source-of-truth wire-format package. Its
  // whole point is to sit below `@atlas/api` and `@atlas/web` in the
  // dependency graph so both layers import a shared validator. Allowing
  // an upward import inverts that graph and re-opens the drift window the
  // package closes — so enforce the boundary as a build failure.
  {
    files: ["packages/schemas/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@atlas/api", "@atlas/api/*", "@atlas/web", "@atlas/web/*", "@atlas/ee", "@atlas/ee/*"],
              message:
                "@useatlas/schemas must not depend on @atlas/* packages. Wire-format schemas sit below the app layer; keep the dependency direction types → schemas → api/web.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [".next/", "node_modules/", "packages/web/.next/", "**/dist/"],
  }
);
