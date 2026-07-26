---
paths:
  - "packages/web/**"
  - "apps/www/**"
  - "packages/react/**"
---

# Frontend conventions

- [ ] **Frontend is a pure HTTP client** — `@atlas/web` does NOT depend on `@atlas/api`. Shared types live in `@useatlas/types` (wire types) and `@useatlas/schemas` (Zod validation), re-exported via `packages/web/src/ui/lib/types.ts`
- [ ] **Tailwind CSS 4** — Via `@tailwindcss/postcss`, not v3
- [ ] **shadcn/ui v2** — New-york style, neutral base, Lucide icons. **Always use shadcn/ui primitives** — never hand-roll. Install: `bun x shadcn@latest add <component>` from `packages/web/`. Uses `cn()` from `@/lib/utils`
- [ ] **nuqs for URL state** — [nuqs](https://nuqs.47ng.com/) for pagination, filters, selected items. Parsers in `search-params.ts` next to the page. Transient UI state stays `useState`
- [ ] **zustand for cross-page UI state** — [zustand](https://zustand.docs.pmnd.rs/) for transient state that outlives a component but isn't URL-shareable (command menus, wizards, undo). Stores in `packages/web/src/lib/stores/<name>-store.ts`, client components only. Not for local (`useState`), URL (`nuqs`), or server state (`useAdminFetch`)
- [ ] **React Compiler handles memoization** — No `useMemo`/`useCallback`/`React.memo` for performance. `useMemo` only for correctness (stable refs); `React.memo` w/ custom comparator for semantic equality
- [ ] **Immutable array operations** — `toSorted()`, `toReversed()`, `toSpliced()` in React components
- [ ] **Dynamic imports for heavy components** — `next/dynamic` for Monaco, Recharts, syntax highlighters
- [ ] **`FeatureName` registry for admin surfaces** — `<MutationErrorSurface>`, `<EnterpriseUpsell>`, `<FeatureGate>`, `<AdminContentWrapper>`, `<ReasonDialog>` type `feature` as `FeatureName` from `@/ui/components/admin/feature-registry`. Append the canonical name to `FEATURE_NAMES` first (casing matches banner copy — "SSO" not "sso"); consolidate duplicates. `tsgo`-enforced

## Admin page hooks

Admin pages use shared hooks — never hand-roll fetch/mutation logic:
```typescript
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";

const { data, loading, error, refetch } = useAdminFetch<T>("/api/v1/admin/...");
const { mutate, saving, error } = useAdminMutation<T>({
  path: "/api/v1/admin/...", method: "POST", invalidates: refetch,
});
```
Config-form pages (load one settings object → edit fields → dirty-gated save → reset on refetch) use `useConfigForm` instead of wiring those two by hand — `toForm` is the single statement of the field set, and the dirty compare derives from it so a new field can't be forgotten:
```typescript
import { useConfigForm } from "@/ui/hooks/use-config-form";

const form = useConfigForm<WireConfig, FormValues>({
  path: "/api/v1/admin/...", schema: WireConfigSchema,
  toForm: (d) => ({ enabled: d.enabled, cap: d.cap === null ? "" : String(d.cap) }),
  toPayload: (v) => ({ enabled: v.enabled, cap: v.cap === "" ? null : Number(v.cap) }),
});
// form.fields.enabled.{value,set} · form.{data,loading,loadError,refetch,values,dirty,reset,save,saving,error}
```
