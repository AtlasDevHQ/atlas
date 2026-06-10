/**
 * Shorthand ambient declaration for the optional `railway` peer dependency.
 * The SDK is lazy-loaded via dynamic import() and intentionally not installed
 * in the monorepo (beta SDK, optional peer) — the structural contract the
 * plugin relies on lives in index.ts. When a consumer installs the real
 * `railway` package, its own types take precedence over this shorthand.
 */
declare module "railway";
