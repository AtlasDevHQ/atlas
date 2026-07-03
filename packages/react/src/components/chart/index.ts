/**
 * `@useatlas/react/chart` — the recharts-backed chart renderer.
 *
 * Kept out of the package root on purpose: `result-chart.tsx` imports recharts
 * statically, and recharts is an OPTIONAL peer. The root entry only ever
 * reaches it through `lazy(() => import(...))`, so embedders without recharts
 * installed can still consume `AtlasChat` / the leaf primitives; importing
 * this subpath is the explicit opt-in to a hard recharts dependency.
 *
 * The pure detection module has zero runtime deps (its one recharts import is
 * type-only) and is re-exported from the root as well.
 */
export { ResultChart } from "./result-chart";
export * from "./chart-detection";
