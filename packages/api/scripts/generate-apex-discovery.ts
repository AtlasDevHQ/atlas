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

import { readFileSync, writeFileSync } from "node:fs";
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
  readonly scopes_supported: readonly string[];
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
  // The scopes an agent requests when obtaining an access token for this
  // resource. RFC 9728 §2 lists `scopes_supported` as OPTIONAL, but agent
  // readiness scanners (and the MCP authorization spec) expect it, and the
  // sibling per-workspace MCP protected-resource metadata advertises the same
  // `mcp:*` set (well-known.ts). These are the data-access scopes the Atlas
  // authorization server issues; the OIDC sign-in scopes (openid/profile/email)
  // are advertised by the auth-server metadata, not the resource.
  scopes_supported: ["mcp:read", "mcp:write"],
  resource_documentation: "https://docs.useatlas.dev/api-reference",
  resource_name: "Atlas API",
  resource_policy_uri: "https://www.useatlas.dev/privacy",
  resource_tos_uri: "https://www.useatlas.dev/terms",
} as const satisfies ProtectedResourceMetadata;

// ---------------------------------------------------------------------------
// Region directory (the agent analogue of the browser's front-door)
// ---------------------------------------------------------------------------

/**
 * The selectable residency regions, mirrored from
 * `deploy/api/atlas.config.ts` `residency.regions` (the SAME SSOT the signup
 * picker + login front-door consume). `assertRegionsMatchConfig()` below fails
 * generation if this list drifts from that config, so the apex directory can't
 * silently disagree with what the platform actually offers.
 *
 * Only `id`, `label`, `api` are stated; the MCP host + auth.md URL are DERIVED
 * from `api` (§ `mcpHostFor`) so they can't drift from it. `staging`
 * (`selectable: false`) is intentionally excluded — real signups never see it.
 */
const SELECTABLE_REGIONS = [
  { id: "us", label: "United States", api: "https://api.useatlas.dev" },
  { id: "eu", label: "Europe", api: "https://api-eu.useatlas.dev" },
  { id: "apac", label: "Asia Pacific", api: "https://api-apac.useatlas.dev" },
] as const;

const DEFAULT_REGION = "us";

/**
 * Map a regional API host to its MCP resource host — the `api*.useatlas.dev`
 * → `mcp*.useatlas.dev` brand-mirror the live `.well-known` router applies
 * (`well-known.ts:brandedMcpHost`). Kept as a derivation (not a second literal)
 * so a region's MCP host is always consistent with its API host.
 */
function mcpHostFor(api: string): string {
  const brand = api.replace(
    /^https:\/\/api(-[a-z0-9]+)?\.useatlas\.dev$/,
    "https://mcp$1.useatlas.dev",
  );
  return `${brand}/mcp`;
}

/** One entry in the region directory an agent reads to pick its residency host. */
interface RegionDirectoryEntry {
  readonly id: string;
  readonly label: string;
  /** Regional API base / OAuth issuer host. */
  readonly api: string;
  /** Regional MCP resource host (`<host>/mcp`). */
  readonly mcp: string;
  /** That region's own agent-onboarding document (region-correct discovery). */
  readonly authMd: string;
}

interface RegionDirectory {
  readonly default: string;
  readonly regions: readonly RegionDirectoryEntry[];
}

/**
 * The agent-facing region directory served at
 * `useatlas.dev/.well-known/atlas-regions.json`. Atlas residency makes the
 * *host* the region (ADR-0024), so an agent resolves its region here, then
 * follows that host's own `/auth.md` + `.well-known` (which advertise the
 * regional MCP endpoint). This is the machine-readable analogue of the browser
 * signup/front-door region picker.
 */
export function buildRegionDirectory(): RegionDirectory {
  return {
    default: DEFAULT_REGION,
    regions: SELECTABLE_REGIONS.map((r) => ({
      id: r.id,
      label: r.label,
      api: r.api,
      mcp: mcpHostFor(r.api),
      authMd: `${r.api}/auth.md`,
    })),
  };
}

/**
 * Fail generation if `SELECTABLE_REGIONS` drifts from the deploy-config SSOT:
 * every selectable region there must be listed here with the same `apiUrl`, and
 * this list must name no region the config marks `selectable: false` / omits.
 * Regex-parses `residency.regions` from source (the config imports `@atlas/api`
 * modules that don't resolve from this script's cwd, so we read, not import) —
 * the same read-the-source discipline as check-auth-md-discovery-parity.ts.
 */
function assertRegionsMatchConfig(): void {
  const src = readFileSync(join(repoRoot, "deploy/api/atlas.config.ts"), "utf8");
  const regionsAt = src.indexOf("regions:", src.indexOf("residency:"));
  if (regionsAt === -1) {
    throw new Error(
      "generate-apex-discovery: could not locate residency.regions in deploy/api/atlas.config.ts — the config shape moved; update assertRegionsMatchConfig().",
    );
  }
  // Region blocks are flat (no nested braces): `"id": { label: ..., apiUrl: "...", [selectable: false] }`.
  const configRegions = new Map<string, string>(); // id -> apiUrl, selectable only
  const block = /"(\w+)":\s*\{([^}]*)\}/g;
  for (let m = block.exec(src.slice(regionsAt)); m; m = block.exec(src.slice(regionsAt))) {
    const [, id, body] = m;
    if (/selectable:\s*false/.test(body)) continue;
    const apiUrl = body.match(/apiUrl:\s*"([^"]+)"/)?.[1];
    if (apiUrl) configRegions.set(id, apiUrl);
  }

  const listed = new Map<string, string>(SELECTABLE_REGIONS.map((r) => [r.id, r.api]));
  const problems: string[] = [];
  for (const [id, apiUrl] of configRegions) {
    if (!listed.has(id)) {
      problems.push(`config marks region "${id}" (${apiUrl}) selectable, but the apex region directory omits it`);
    } else if (listed.get(id) !== apiUrl) {
      problems.push(`region "${id}" apiUrl mismatch: config=${apiUrl}, directory=${listed.get(id)}`);
    }
  }
  for (const [id] of listed) {
    if (!configRegions.has(id)) {
      problems.push(`apex region directory lists "${id}", but the config has no such selectable region`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "generate-apex-discovery: apex region directory drifted from deploy/api/atlas.config.ts residency.regions:\n  - " +
        problems.join("\n  - ") +
        "\nUpdate SELECTABLE_REGIONS in this generator to match the config.",
    );
  }
}

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
  /** Served at `useatlas.dev/.well-known/atlas-regions.json` — the region directory. */
  wwwRegions: join(repoRoot, "apps/www/public/.well-known/atlas-regions.json"),
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
  assertRegionsMatchConfig();

  const authMd = renderCanonicalAuthMd();
  const protectedResource = jsonArtifact(API_PROTECTED_RESOURCE);

  writeFileSync(OUTPUTS.wwwAuthMd, authMd);
  writeFileSync(OUTPUTS.wwwProtectedResource, protectedResource);
  writeFileSync(OUTPUTS.docsProtectedResource, protectedResource);
  writeFileSync(OUTPUTS.wwwRegions, jsonArtifact(buildRegionDirectory()));

  console.log(
    "Generated apex discovery artifacts:\n" +
      `  ${OUTPUTS.wwwAuthMd}\n` +
      `  ${OUTPUTS.wwwProtectedResource}\n` +
      `  ${OUTPUTS.docsProtectedResource}\n` +
      `  ${OUTPUTS.wwwRegions}`,
  );
}

// Only write files when run as the script (`bun scripts/generate-apex-discovery.ts`),
// not when imported by the unit test — importing must have no side effects.
if (import.meta.main) main();
