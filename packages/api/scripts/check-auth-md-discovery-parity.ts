#!/usr/bin/env bun
// check-auth-md-discovery-parity.ts — CI gate (#3825) that asserts the
// human-readable `/auth.md` agent-onboarding document (#3824) never advertises
// a host, scope, or endpoint that disagrees with Atlas's machine-discovery
// documents (`/.well-known/oauth-authorization-server/api/auth` and
// `/.well-known/oauth-protected-resource/mcp/{workspace_id}`).
//
// Why this exists on top of #3824's structural sharing:
//   #3824 already feeds the `/auth.md` builder the SAME host-resolution helpers
//   (`buildAuthServerUri` / `buildResourceUri`, incl. the `api*` → `mcp*`
//   regional brand-mirror) and the SAME canonical scope constant
//   (`ATLAS_OAUTH_SCOPES`) the `.well-known` router uses. That structurally
//   prevents the *most likely* drift. This guard is defense-in-depth against
//   the failure that structural sharing can't catch: a maintainer HARDCODING a host, scope,
//   or endpoint path into the `auth.md` prose (or a doc copy-edit) that
//   silently diverges from machine discovery. An agent that trusts `/auth.md`
//   and a divergent client that trusts `.well-known` would then bootstrap
//   differently — exactly the interop failure the discovery file exists to
//   prevent.
//
// Strategy: render `/auth.md` from a fixed sample base URL using the REAL pure
// builder + shared helpers + canonical scopes, then reconstruct the
// `.well-known` advertised facts from the SAME fixed inputs, and assert parity
// of:
//   1. the authorization-server issuer URI,
//   2. the MCP resource host (including the `api*` → `mcp*` brand-mirror),
//   3. the advertised scope set,
// and that `/auth.md` names no endpoint `.well-known` does not advertise (in
// particular never a WorkOS-conformance endpoint such as `/agent/identity`).
//
// A divergence exits non-zero with an actionable message naming the divergent
// value. Wired into the existing `drift` CI job (the same gate that runs
// schema-drift / template-drift), so a divergence blocks merge.
//
// Verification-only: imports the real modules, changes no runtime behavior.
//
// Lives under `packages/api/scripts/` (not the repo-root `scripts/`) because it
// imports the real `@atlas/api/*` modules, which only resolve from inside the
// workspace package. The drift CI job invokes it via
// `cd packages/api && bun scripts/check-auth-md-discovery-parity.ts`.
//
// The parity logic is pure and exported (`collectViolations` + the per-aspect
// checkers) so the adversarial-fixture suite
// (`packages/api/src/api/__tests__/auth-md-discovery-parity.test.ts`) can prove
// each drift vector fails with a value-naming message without mutating real
// source. (That suite lives under `src/` — not next to this script — so the
// api-tests shards pick it up; it imports the pure checkers from here.)
//
// Usage: bun packages/api/scripts/check-auth-md-discovery-parity.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAuthMd, type AuthMdScope } from "@atlas/api/lib/mcp/auth-md";
import { ATLAS_OAUTH_SCOPES } from "@atlas/api/lib/auth/oauth-scopes";
import {
  buildAuthServerUri,
  buildIssuerBaseUri,
  buildResourceUri,
} from "@atlas/api/api/routes/well-known";

/** `packages/api` — this script lives one level down in `scripts/`. */
const apiRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

/**
 * The doc constants the `/auth.md` route (`api/routes/auth-md.ts`) feeds the
 * builder that are NOT host/scope-derived (docs URL, onboarding endpoint).
 * They exist so `buildAuthMd` produces a faithful document to scan; they are
 * not part of `.well-known` parity. The docs host is exempted from the
 * foreign-host check (it is a legitimate "go deeper" link, not a discovery
 * host).
 */
export const ATLAS_DOCS_URL = "https://docs.useatlas.dev";
const ONBOARDING_MCP_PATH = "/mcp/onboarding/sse";

/**
 * `.well-known` host fixtures. Each entry drives both the rendered `/auth.md`
 * and the reconstructed `.well-known` facts from the SAME resolved base, so
 * the parity is checked per region. The eu entry exercises the `api*` → `mcp*`
 * regional brand-mirror — the resolved resource host must be the `mcp-eu.*`
 * brand, not the `api-eu.*` infra host.
 */
const HOST_FIXTURES = [
  { label: "us region", apiBase: "https://api.useatlas.dev" },
  { label: "eu region", apiBase: "https://api-eu.useatlas.dev" },
] as const;

/**
 * Endpoint fragments that must NEVER appear in `/auth.md`: the WorkOS
 * agent-verified conformance machinery Atlas serves none of. A discovery
 * document must not name an endpoint that 404s. This mirrors the existing
 * backstop unit tests (`lib/mcp/__tests__/auth-md.test.ts`) as defense in
 * depth — the parity guard fails the build in the SAME job as the other drift
 * gates, independent of the per-file test shard running.
 */
export const FORBIDDEN_FRAGMENTS = [
  "/agent/identity",
  "identity_assertion",
  "urn:workos:",
  "agent_auth",
] as const;

/**
 * The `.well-known` discovery paths the router (`well-known.ts`) actually
 * mounts. `/auth.md` may point at these (it tells agents where to read machine
 * metadata); naming a `.well-known` path the router does NOT serve is drift.
 * The `{workspace_id}` segment is the doc's placeholder for the router's
 * `:workspace_id` param.
 */
export const SERVED_WELL_KNOWN_PATHS = [
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/openid-configuration/api/auth",
  "/.well-known/oauth-protected-resource/mcp/{workspace_id}",
] as const;

/** The resolved host pair `.well-known` advertises for a given fixed input. */
export interface ResolvedHosts {
  /** Auth-server issuer URI — `.well-known`'s `authorization_servers[0]`. */
  readonly authServerUri: string;
  /** MCP resource host (brand-mirror applied) — `.well-known`'s `resource`. */
  readonly resourceUri: string;
}

// ---------------------------------------------------------------------------
// `.well-known` source-of-truth extraction
// ---------------------------------------------------------------------------

/**
 * The protected-resource metadata's `scopes_supported` is a hardcoded literal
 * in `well-known.ts` (it lists the `mcp:*` subset the MCP resource server
 * advertises). It is not exported, so we extract the literal from source — the
 * same read-the-source discipline every other drift gate uses. The set the
 * `.well-known` document advertises must equal the set `/auth.md` names, or an
 * agent and a `.well-known`-trusting client disagree on which scopes to
 * request.
 *
 * Verification-only constraint: we deliberately do NOT refactor `well-known.ts`
 * to export the literal (that would touch runtime code). Reading it here keeps
 * the guard purely additive. Exported so the fixture suite can exercise the
 * extraction against synthetic source.
 */
export function parseWellKnownScopes(source: string, sourceLabel: string): string[] {
  const match = source.match(/scopes_supported:\s*\[([^\]]*)\]/);
  if (!match) {
    fail(
      `Could not locate the \`scopes_supported\` literal in ${sourceLabel}. ` +
        `The .well-known protected-resource scope source moved — update ` +
        `parseWellKnownScopes() in this guard to track it.`,
    );
  }
  const scopes = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  if (scopes.length === 0) {
    fail(
      `The \`scopes_supported\` literal in ${sourceLabel} parsed to an empty ` +
        `set — the .well-known protected-resource document would advertise no ` +
        `scopes. Refusing to treat that as parity.`,
    );
  }
  return scopes;
}

function wellKnownAdvertisedScopes(): string[] {
  const wellKnownPath = join(apiRoot, "src/api/routes/well-known.ts");
  return parseWellKnownScopes(readFileSync(wellKnownPath, "utf8"), rel(wellKnownPath));
}

// ---------------------------------------------------------------------------
// auth.md rendering (mirrors api/routes/auth-md.ts)
// ---------------------------------------------------------------------------

/**
 * The `mcp:*` subset of the canonical scope union, mapped to the
 * `AuthMdScope` shape the builder expects — the same derivation
 * `api/routes/auth-md.ts:mcpScopes()` performs. Grant blurbs are irrelevant to
 * parity (they're prose), so we pass a placeholder; only scope *names* matter.
 */
function mcpScopesFromCanonical(): AuthMdScope[] {
  return ATLAS_OAUTH_SCOPES.filter((s) => s.startsWith("mcp:")).map((name) => ({
    name,
    grants: "—",
  }));
}

/**
 * Drive the shared host helpers + builder for a fixed resolved API base. The
 * route resolves hosts from the request via the shared helpers; we drive the
 * SAME helpers through the env var the route's resolution honors, then hand the
 * resolved values to the SAME builder. `req` is a placeholder — the env var
 * wins in the helpers' resolution precedence.
 */
function withResolvedBase<T>(apiBase: string, fn: (req: Request) => T): T {
  const prev = process.env.ATLAS_PUBLIC_API_URL;
  process.env.ATLAS_PUBLIC_API_URL = apiBase;
  try {
    return fn(new Request(`${apiBase}/auth.md`));
  } finally {
    if (prev === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
    else process.env.ATLAS_PUBLIC_API_URL = prev;
  }
}

/** Render the document the route would serve for a given resolved API base. */
function renderAuthMd(apiBase: string): string {
  return withResolvedBase(apiBase, (req) =>
    buildAuthMd({
      authServerUri: buildAuthServerUri(req),
      issuerBaseUri: buildIssuerBaseUri(req),
      resourceUri: buildResourceUri(req),
      scopes: mcpScopesFromCanonical(),
      onboardingPath: ONBOARDING_MCP_PATH,
      docsUrl: ATLAS_DOCS_URL,
    }),
  );
}

/** Resolve the `.well-known`-advertised hosts for a given resolved API base. */
function resolvedHosts(apiBase: string): ResolvedHosts {
  return withResolvedBase(apiBase, (req) => ({
    authServerUri: buildAuthServerUri(req),
    resourceUri: buildResourceUri(req),
  }));
}

// ---------------------------------------------------------------------------
// Parity checkers (pure — return violation strings, no shared state, no exit)
// ---------------------------------------------------------------------------

function rel(p: string): string {
  return p.startsWith(apiRoot) ? `packages/api/${p.slice(apiRoot.length + 1)}` : p;
}

/** Hard, immediate failure (config/parse errors that invalidate the run). */
function fail(message: string): never {
  console.error(`\ncheck-auth-md-discovery-parity: ${message}\n`);
  process.exit(1);
}

/**
 * Scope-set parity. Catches BOTH directions of drift: a scope hardcoded into
 * the prose that machine discovery omits, and a `.well-known` scope the doc
 * forgets to mention. Independent of host fixtures, so it runs once.
 */
export function scopeParityViolations(doc: string, advertised: readonly string[]): string[] {
  const out: string[] = [];
  const advertisedSet = new Set(advertised);
  // Every `mcp:<word>` token the prose names. The brand host `.../mcp` is not a
  // scope (no colon), so this pattern can't false-match it.
  const namedInDoc = new Set(doc.match(/mcp:[a-z][a-z0-9_]*/g) ?? []);

  for (const scope of namedInDoc) {
    if (!advertisedSet.has(scope)) {
      out.push(
        `/auth.md names scope \`${scope}\` that the .well-known ` +
          `protected-resource metadata does NOT advertise ` +
          `(scopes_supported = [${advertised.join(", ")}]). ` +
          `An agent reading /auth.md would request a scope machine discovery ` +
          `omits. Either add it to scopes_supported in well-known.ts, or stop ` +
          `naming it in the /auth.md builder.`,
      );
    }
  }
  for (const scope of advertised) {
    if (!namedInDoc.has(scope)) {
      out.push(
        `The .well-known protected-resource metadata advertises scope ` +
          `\`${scope}\` that /auth.md never names. A client trusting machine ` +
          `discovery and an agent trusting /auth.md would request different ` +
          `scopes. Surface \`${scope}\` in the /auth.md builder, or remove it ` +
          `from scopes_supported in well-known.ts.`,
      );
    }
  }
  return out;
}

/**
 * Host parity for one fixture. Asserts the resolved auth-server issuer URI and
 * the resolved MCP resource host (incl. the brand-mirror) appear verbatim in
 * the doc — i.e. the prose names exactly what `.well-known` advertises, not a
 * hardcoded look-alike — AND that no OTHER `useatlas.dev` host literal leaks
 * in (the "maintainer hardcodes a host" vector).
 */
export function hostParityViolations(
  label: string,
  doc: string,
  hosts: ResolvedHosts,
): string[] {
  const out: string[] = [];

  if (!doc.includes(hosts.authServerUri)) {
    out.push(
      `[${label}] /auth.md does not name the resolved authorization-server ` +
        `issuer URI \`${hosts.authServerUri}\` that .well-known advertises as ` +
        `\`authorization_servers\`. A host was likely hardcoded in the prose ` +
        `instead of resolved from buildAuthServerUri().`,
    );
  }
  if (!doc.includes(hosts.resourceUri)) {
    out.push(
      `[${label}] /auth.md does not name the resolved MCP resource host ` +
        `\`${hosts.resourceUri}\` that .well-known advertises as \`resource\` ` +
        `(this is the api*→mcp* brand-mirror output of buildResourceUri()). ` +
        `A host was likely hardcoded in the prose, or the brand-mirror was ` +
        `bypassed.`,
    );
  }

  // No `useatlas.dev` host literal in the doc may be a host OTHER than the two
  // resolved ones (plus the docs link): a stray `https://api-apac.useatlas.dev`
  // baked into the prose that machine discovery, resolved from the same input,
  // never advertises.
  const allowedOrigins = new Set(
    [hosts.authServerUri, hosts.resourceUri, ATLAS_DOCS_URL].map((u) => new URL(u).origin),
  );
  for (const literal of doc.match(/https?:\/\/[a-z0-9.-]*useatlas\.dev/gi) ?? []) {
    if (!allowedOrigins.has(new URL(literal).origin)) {
      out.push(
        `[${label}] /auth.md names the host \`${literal}\` that is neither the ` +
          `resolved auth-server issuer (\`${hosts.authServerUri}\`) nor the ` +
          `resolved MCP resource host (\`${hosts.resourceUri}\`) nor the docs ` +
          `link. A host appears hardcoded in the prose and diverges from ` +
          `machine discovery.`,
      );
    }
  }
  return out;
}

/**
 * Endpoint parity for one fixture: the doc names no forbidden WorkOS-conformance
 * endpoint, and every `/.well-known/...` path it points at is one the router
 * actually serves (so the doc can't send an agent to a path that 404s).
 */
export function endpointParityViolations(label: string, doc: string): string[] {
  const out: string[] = [];

  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (doc.includes(fragment)) {
      out.push(
        `[${label}] /auth.md names \`${fragment}\` — a WorkOS agent-verified ` +
          `endpoint Atlas does not serve and .well-known does not advertise. ` +
          `A discovery document must never point an agent at an endpoint that ` +
          `404s. Remove it from the /auth.md builder.`,
      );
    }
  }

  const served = new Set<string>(SERVED_WELL_KNOWN_PATHS);
  for (const path of doc.match(/\/\.well-known\/[^\s`)]+/g) ?? []) {
    if (!served.has(path)) {
      out.push(
        `[${label}] /auth.md points at the discovery path \`${path}\` that the ` +
          `.well-known router does not serve (served: ${[...served].join(", ")}). ` +
          `Either the doc hardcoded a wrong path or a route was renamed without ` +
          `updating the doc.`,
      );
    }
  }
  return out;
}

/**
 * Run every parity check across all host fixtures + the host-independent scope
 * check, and return the combined violation list. Pure: the caller owns I/O.
 */
export function collectViolations(input: {
  fixtures: readonly { label: string; doc: string; hosts: ResolvedHosts }[];
  advertisedScopes: readonly string[];
}): string[] {
  const out: string[] = [];
  for (const f of input.fixtures) {
    out.push(...hostParityViolations(f.label, f.doc, f.hosts));
    out.push(...endpointParityViolations(f.label, f.doc));
  }
  // Scope parity is host-independent — the `mcp:*` set the prose names doesn't
  // vary by region — so check it once against the first fixture's doc.
  const firstDoc = input.fixtures[0]?.doc ?? "";
  out.push(...scopeParityViolations(firstDoc, input.advertisedScopes));
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main(): void {
  const advertisedScopes = wellKnownAdvertisedScopes();

  const fixtures = HOST_FIXTURES.map((f) => ({
    label: f.label,
    doc: renderAuthMd(f.apiBase),
    hosts: resolvedHosts(f.apiBase),
  }));

  const violations = collectViolations({ fixtures, advertisedScopes });

  if (violations.length > 0) {
    console.error(
      "\ncheck-auth-md-discovery-parity: /auth.md DIVERGES from machine " +
        "discovery (.well-known). The human-readable onboarding doc must name " +
        "exactly the hosts, scopes, and endpoints machine discovery advertises " +
        "from the same inputs.\n",
    );
    for (const v of violations) console.error(`  ✗ ${v}\n`);
    console.error(
      `${violations.length} divergence(s). Fix the /auth.md builder ` +
        "(packages/api/src/lib/mcp/auth-md.ts) or the .well-known router " +
        "(packages/api/src/api/routes/well-known.ts) so the two agree.\n",
    );
    process.exit(1);
  }

  console.log(
    "OK: /auth.md advertises exactly the hosts, scopes, and endpoints the " +
      ".well-known discovery documents advertise from the same inputs " +
      `(${HOST_FIXTURES.length} region fixtures, scopes ` +
      `[${advertisedScopes.join(", ")}]).`,
  );
}

// Only run when invoked as the script, not when imported by the fixture suite.
if (import.meta.main) main();
