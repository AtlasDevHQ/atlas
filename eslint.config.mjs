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
  // (e.g. `{ message: friendlyError(x.error) }`) are NOT flagged because the
  // value's top-level type is CallExpression, which fails the value.type
  // filter on both selectors.
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
  {
    ignores: [".next/", "node_modules/", "packages/web/.next/", "**/dist/"],
  }
);
