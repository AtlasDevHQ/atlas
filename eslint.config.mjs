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
  // Guard the structured-FetchError invariant established by #1614 and
  // completed by the hook-level migration in #1615. `useAdminMutation`
  // returns `FetchError` (status/code/requestId) both on `MutateResult.error`
  // and hook-level `error` — wrapping it as `{ message: ... }` re-flattens to
  // a bare string and breaks `friendlyError()` + `EnterpriseUpsell` routing.
  // Rule applies only to the web package; other packages have different
  // error-passing conventions.
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ObjectExpression[properties.length=1] > Property[key.name='message'][value.type='MemberExpression'][value.property.name='error']",
          message:
            "Do not wrap a mutation `.error` as `{ message: x.error }` — useAdminMutation now surfaces a structured FetchError (status/code/requestId). Pass it straight to setError()/AdminContentWrapper, or convert to a string via friendlyError() / friendlyErrorOrNull().",
        },
      ],
    },
  },
  {
    ignores: [".next/", "node_modules/", "packages/web/.next/", "**/dist/"],
  }
);
