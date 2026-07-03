#!/usr/bin/env bun
// generate-apex-discovery.ts — emits the STATIC agent-discovery artifacts the
// apex brand domain (`useatlas.dev`, served by apps/www's static Bun server)
// and the docs site host, from ONE source of truth so the copies can never
// drift from what the live API advertises.
//
// Why the apex hosts these at all:
//   `useatlas.dev` is the first host an agent (or an agent-readiness scanner)
//   resolves for the brand. The live OAuth/OIDC + auth.md machinery lives on
//   `api.useatlas.dev` (Better Auth, issuer-suffixed paths) and is dynamic;
//   the apex is a static export that can't run that machinery per-request. So
//   the apex serves a STATIC mirror of the canonical (US-region) surface:
//     - /auth.md                                  (agent-onboarding document)
//     - /.well-known/oauth-protected-resource     (the REST API as a resource)
//   plus 302 redirects to the live openid-configuration / oauth-authorization-
//   server docs (wired in apps/www/serve.ts — those are Better-Auth-generated
//   and must never be statically frozen).
//
// The drift trap:
//   A hand-copied static mirror silently rots the moment a scope, host, or the
//   auth.md prose changes on the API side. This generator makes the mirror
//   DERIVED, and `scripts/check-apex-discovery-drift.sh` re-runs it in CI and
//   fails on any diff — the same generate-then-diff discipline the template and
//   openapi drift gates use. auth.md itself is rendered by the SAME pure
//   `renderAuthMd()` the live route serves, so the apex snapshot is byte-for-
//   byte what `api.useatlas.dev/auth.md` returns for the US region.
//
// Lives under `packages/api/scripts/` (not repo-root `scripts/`) for the same
// reason as check-auth-md-discovery-parity.ts: it imports the real
// `@atlas/api/*` modules, which only resolve from inside the workspace package.
// It writes OUT to apps/www + apps/docs via relative paths.
//
// Usage: cd packages/api && bun scripts/generate-apex-discovery.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderAuthMd } from "@atlas/api/api/routes/auth-md";

// ---------------------------------------------------------------------------
// Canonical inputs
// ---------------------------------------------------------------------------

/**
 * The canonical (US-region) API base the apex mirror is rendered against. The
 * apex is region-agnostic brand real estate; it advertises the canonical brand
 * surface, and regional routing happens after an agent follows discovery. The
 * `api*.useatlas.dev` → `mcp*.useatlas.dev` brand-mirror in the shared host
 * helpers turns this into the `mcp.useatlas.dev/mcp` resource audience, exactly
 * as the live `.well-known` router does.
 */
const CANONICAL_API_BASE = "https://api.useatlas.dev";

/**
 * RFC 9728 OAuth Protected Resource metadata shape (the subset Atlas
 * advertises). Declared locally rather than reused from Better Auth's
 * `getProtectedResourceMetadata` param because that types the API's *MCP*
 * variant, which describes a different resource. `satisfies` this on the const
 * below so a field-name typo or wrong element type is a compile error rather
 * than a wrong value the drift gate would faithfully mirror into both copies.
 */
interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly resource_documentation: string;
  readonly resource_name: string;
  readonly resource_policy_uri: string;
  readonly resource_tos_uri: string;
}

/**
 * The REST-API OAuth Protected Resource metadata (RFC 9728), describing
 * `api.useatlas.dev` as a bearer-token-protected resource. This is the SINGLE
 * definition; the generator emits it to both the apex (apps/www) and the docs
 * site so the two static copies stay identical. (Distinct from the API's
 * dynamic *MCP* protected-resource doc at `/oauth-protected-resource/mcp/:id`,
 * which describes a different resource — the per-workspace MCP server.)
 *
 * Exported so a unit test can assert its shape without re-reading the emitted
 * artifact.
 */
export const API_PROTECTED_RESOURCE = {
  resource: "https://api.useatlas.dev",
  authorization_servers: ["https://api.useatlas.dev"],
  bearer_methods_supported: ["header"],
  resource_documentation: "https://docs.useatlas.dev/api-reference",
  resource_name: "Atlas API",
  resource_policy_uri: "https://www.useatlas.dev/privacy",
  resource_tos_uri: "https://www.useatlas.dev/terms",
} as const satisfies ProtectedResourceMetadata;

// ---------------------------------------------------------------------------
// Output targets (relative to packages/api/scripts/)
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dir, "..", "..", "..");

const OUTPUTS = {
  /** Served verbatim by apps/www/serve.ts at `useatlas.dev/auth.md`. */
  wwwAuthMd: join(repoRoot, "apps/www/public/auth.md"),
  /** Served (extension-stripped) at `useatlas.dev/.well-known/oauth-protected-resource`. */
  wwwProtectedResource: join(
    repoRoot,
    "apps/www/public/.well-known/oauth-protected-resource.json",
  ),
  /** Imported by the docs oauth-protected-resource route so it holds no copy. */
  docsProtectedResource: join(
    repoRoot,
    "apps/docs/src/app/.well-known/oauth-protected-resource/resource-metadata.generated.json",
  ),
} as const;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render `renderAuthMd` against the canonical base deterministically. The
 * shared host helpers resolve `ATLAS_PUBLIC_API_URL` first, then
 * `BETTER_AUTH_URL`, then the request origin — so an ambient env var on the
 * generating machine (a dev's `.env`, CI) would otherwise leak into the output
 * and make the committed file non-reproducible. Pin the env for the render and
 * restore it, mirroring check-auth-md-discovery-parity.ts's `withResolvedBase`.
 * Belt-and-suspenders: we also delete `BETTER_AUTH_URL` and pass a canonical
 * request origin, so ALL three resolution tiers agree on `api.useatlas.dev` —
 * the output can't change even if the helper precedence is ever reordered.
 *
 * Exported so a unit test can lock this env-independence contract (the drift
 * gate can't — it regenerates with the same generator, so a precedence bug
 * would leave both sides equally wrong).
 */
export function renderCanonicalAuthMd(): string {
  const prevApi = process.env.ATLAS_PUBLIC_API_URL;
  const prevAuth = process.env.BETTER_AUTH_URL;
  process.env.ATLAS_PUBLIC_API_URL = CANONICAL_API_BASE;
  delete process.env.BETTER_AUTH_URL;
  try {
    return renderAuthMd(new Request(`${CANONICAL_API_BASE}/auth.md`));
  } finally {
    if (prevApi === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
    else process.env.ATLAS_PUBLIC_API_URL = prevApi;
    if (prevAuth === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = prevAuth;
  }
}

/** Stable JSON encoding (2-space, trailing newline) shared by all JSON outputs. */
function jsonArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): void {
  const authMd = renderCanonicalAuthMd();
  const protectedResource = jsonArtifact(API_PROTECTED_RESOURCE);

  writeFileSync(OUTPUTS.wwwAuthMd, authMd);
  writeFileSync(OUTPUTS.wwwProtectedResource, protectedResource);
  writeFileSync(OUTPUTS.docsProtectedResource, protectedResource);

  console.log(
    "Generated apex discovery artifacts:\n" +
      `  ${OUTPUTS.wwwAuthMd}\n` +
      `  ${OUTPUTS.wwwProtectedResource}\n` +
      `  ${OUTPUTS.docsProtectedResource}`,
  );
}

// Only write files when run as the script (`bun scripts/generate-apex-discovery.ts`),
// not when imported by the unit test — importing must have no side effects.
if (import.meta.main) main();
