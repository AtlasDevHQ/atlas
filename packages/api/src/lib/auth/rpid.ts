/**
 * WebAuthn Relying Party ID (`rpID`) resolution for the passkey plugin.
 *
 * Extracted from `server.ts` so the resolver stays a pure, dependency-light
 * unit (no `better-auth` import): it's consumed both at auth-instance
 * construction (`buildPlugins` in `server.ts`) and eagerly at startup
 * (`checkManagedAuthMode` in `startup.ts`), so neither path has to drag the
 * Better Auth module graph around to validate the rpID. See #3045.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:rpid");

/**
 * Legacy WebAuthn rpID default. Retained as the fallback for single-origin /
 * self-hosted deploys that configure neither `ATLAS_CORS_ORIGIN` nor
 * `BETTER_AUTH_TRUSTED_ORIGINS` — there is no web origin to derive from, so
 * preserving the historical value keeps minimal setups working unchanged.
 * Prod also resolves to exactly this string, but *because* its first
 * `ATLAS_CORS_ORIGIN` entry is `https://app.useatlas.dev` (deploy/README.md) —
 * so the derive path below is a no-op for prod only as long as that stays
 * true. If prod ever prepends a different origin, the derived rpID shifts and
 * `ATLAS_RPID` must be pinned explicitly to avoid invalidating enrolled keys.
 */
export const DEFAULT_RP_ID = "app.useatlas.dev";

/**
 * WebAuthn's "registrable domain suffix of, or equal to" rule: `rpID` is valid
 * for `host` when it equals the host or is a parent domain (dot-boundary
 * suffix) of it — e.g. `useatlas.dev` is valid for `app.staging.useatlas.dev`,
 * but `app.useatlas.dev` is NOT (the exact footgun this module fixes: prod's
 * rpID silently inherited on a staging host).
 *
 * No public-suffix-list awareness: a plain dotted-label check (the rpID is a
 * registrable-domain suffix of the app host, never a cross-host cookie domain —
 * session cookies are host-only, ADR-0024 §5). Atlas's app host and rpID are
 * always the same registrable domain, and the browser is the backstop for a
 * pathological rpID like a bare public suffix.
 */
function isRegistrableDomainSuffixOrEqual(rpID: string, host: string): boolean {
  // Hostnames are case-insensitive (DNS), and browsers lowercase the rpID
  // before matching it against the page origin — so compare case-insensitively.
  // An explicit `ATLAS_RPID=App.useatlas.dev` is valid for origin host
  // `app.useatlas.dev` and must NOT trip the boot assertion. (`originHost` is
  // already lowercased by `new URL().hostname`; only the operator-typed
  // explicit rpID can carry case. The *returned* rpID is left verbatim — see
  // `resolvePasskeyRpId` — so this comparison never mutates the enrolled value.)
  const r = rpID.toLowerCase();
  const h = host.toLowerCase();
  if (r === h) return true;
  return h.endsWith(`.${r}`);
}

/**
 * True when `host` is an IP literal rather than a domain name. WebAuthn rpIDs
 * MUST be domain names — an IP can never be a valid rpID — so an IP-derived (or
 * explicitly-IP) rpID means passkeys will fail in the browser regardless of
 * what we return. We detect it so the caller can surface a loud, actionable
 * boot signal instead of letting it fail silently in the ceremony.
 *
 * `new URL().hostname` keeps IPv6 literals bracketed (`[::1]`), so the colon /
 * bracket test catches them; the dotted-quad test catches IPv4 (`127.0.0.1`).
 * `localhost` is a *name*, not an IP, and is a valid rpID, so it is not matched.
 */
function isIpLiteralHost(host: string): boolean {
  if (host.includes(":") || host.startsWith("[")) return true; // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host); // dotted IPv4
}

/**
 * Extract the host from a configured web origin so the rpID can be validated
 * against it, or `null` (with a loud error log) when the origin is unusable.
 *
 * `getWebOrigin()` returns the operator's raw `ATLAS_CORS_ORIGIN` /
 * `BETTER_AUTH_TRUSTED_ORIGINS` entry — it does NOT guarantee an absolute URL.
 * Two realistic misconfigurations yield no host: a scheme-less bare host
 * (`new URL` throws) and a scheme-less host:port like `app.example.com:3000`
 * (`new URL` parses it as a protocol, leaving `hostname === ""`). Both mean
 * the rpID can't be validated, so a wrong rpID would still break passkeys in
 * the browser — exactly the silent failure this module exists to prevent.
 * We log at error level (not warn — this belongs above boot noise) and name
 * the consequence + fix, then return null so the caller degrades to the
 * explicit/default rpID rather than crashing. This is the only logged path;
 * the caller does not double-log.
 */
function parseOriginHostForRpId(webOrigin: string): string | null {
  let host: string;
  try {
    host = new URL(webOrigin).hostname;
  } catch (err) {
    log.error(
      { webOrigin, err: err instanceof Error ? err.message : String(err) },
      "Configured web origin is not a parseable absolute URL while resolving the WebAuthn rpID — "
        + "the rpID can't be validated against it, so a wrong rpID will break passkeys in the browser "
        + "with no further server signal. Ensure the first ATLAS_CORS_ORIGIN / BETTER_AUTH_TRUSTED_ORIGINS "
        + "entry includes the scheme (e.g. https://app.example.com).",
    );
    return null;
  }
  if (!host) {
    log.error(
      { webOrigin },
      "Configured web origin has no host while resolving the WebAuthn rpID (scheme missing? — a value "
        + 'like "app.example.com:3000" parses as a protocol, not a host) — the rpID can\'t be validated '
        + "against it, so a wrong rpID will break passkeys in the browser with no further server signal. "
        + "Ensure the first ATLAS_CORS_ORIGIN / BETTER_AUTH_TRUSTED_ORIGINS entry includes the scheme "
        + "(e.g. https://app.example.com).",
    );
    return null;
  }
  return host;
}

/**
 * Resolve the WebAuthn Relying Party ID (`rpID`) for the passkey plugin, and
 * fail loud if it can't possibly be valid for the deploy's web origin.
 *
 * `rpID` is the registrable domain a passkey is bound to. It MUST stay stable
 * across enrollment — changing the *effective* value invalidates every passkey
 * already registered (see the comment above the `passkey({...})` call in
 * `server.ts`). The resolution order is therefore deliberately conservative:
 *
 *   1. Explicit `ATLAS_RPID` always wins. SaaS multi-region deploys MUST set
 *      it so a reorder of `ATLAS_CORS_ORIGIN` (which `getWebOrigin()` reads)
 *      can never shift the derived rpID out from under enrolled keys.
 *   2. Otherwise derive it from the configured web origin's host
 *      (`getWebOrigin()` — first `ATLAS_CORS_ORIGIN`, then the first trusted
 *      origin). Prod's app origin is `https://app.useatlas.dev`, so the
 *      derived value is exactly `app.useatlas.dev` — identical to the old
 *      hardcoded default, so no prod passkey is invalidated. Staging now
 *      derives `app.staging.useatlas.dev` instead of silently inheriting
 *      prod's rpID and breaking every staging passkey.
 *   3. If no web origin is configured (single-origin / self-hosted with
 *      neither var set), fall back to {@link DEFAULT_RP_ID} so minimal setups
 *      keep working unchanged — no hard-fail.
 *
 * The failure this guards against — `The RP ID "..." is invalid for this
 * domain` — fires only at ceremony time, in the user's browser, with no
 * boot-time signal. So whenever a web origin IS configured we assert the
 * effective rpID is valid for it and throw with an actionable message
 * otherwise. (Unlike most boot-time config, which we only `log.warn` on, a
 * wrong rpID can't be repaired at runtime and fails silently in the browser
 * ceremony — so it warrants a hard fail.) A bogus *explicit* `ATLAS_RPID` is
 * caught here too; the derived path can never produce an invalid value, so unset
 * deploys never throw. Hostnames aren't secrets (CLAUDE.md), so they're safe
 * to log/surface.
 *
 * Throwing alone isn't a true hard boot-fail — `buildPlugins()` runs lazily
 * (first managed-auth request / boot migration), and the migration path
 * catches the throw into a generic log. So `checkManagedAuthMode` in
 * `startup.ts` ALSO calls this and turns a throw into a startup diagnostic,
 * surfacing the actionable message eagerly on `/health` and route 503s.
 */
export function resolvePasskeyRpId(env: NodeJS.ProcessEnv, webOrigin: string | null): string {
  const explicit = env.ATLAS_RPID?.trim();

  // The web origin's host, when one is configured and usable. A configured but
  // UNUSABLE origin (unparseable, or scheme-less so `new URL` yields an empty
  // host — e.g. "app.example.com:3000" parses as a protocol, not a host) is a
  // misconfiguration, NOT the "no origin configured" minimal-setup case — so
  // `parseOriginHostForRpId` logs it at error level with the consequence
  // spelled out, rather than letting it slip past as a silent null. We still
  // degrade to the explicit/default rpID (no host → nothing to validate
  // against → can't assert), but the boot log is loud instead of silent.
  const originHost = webOrigin ? parseOriginHostForRpId(webOrigin) : null;

  // 1. explicit env  >  2. derive from origin host  >  3. legacy default.
  const rpID = explicit || originHost || DEFAULT_RP_ID;

  // Fail loud when the effective rpID cannot be valid for the configured
  // origin. Only reachable when an origin is configured AND parseable; the
  // derived path always equals originHost (so always passes), meaning in
  // practice this only trips on an explicit-but-wrong ATLAS_RPID.
  if (originHost && !isRegistrableDomainSuffixOrEqual(rpID, originHost)) {
    throw new Error(
      `WebAuthn rpID "${rpID}" is not valid for the configured web origin "${webOrigin}" `
        + `(host "${originHost}"): rpID must equal the origin host or be a parent domain of it. `
        + (explicit
          ? `ATLAS_RPID="${explicit}" is set explicitly but is not a registrable-domain suffix of `
            + `the origin — set ATLAS_RPID to "${originHost}" (or a parent domain), or correct the `
            + `first ATLAS_CORS_ORIGIN / BETTER_AUTH_TRUSTED_ORIGINS entry.`
          : `Set ATLAS_RPID explicitly to "${originHost}" (or a parent domain), or correct the web origin.`),
    );
  }

  // An IP-literal rpID passes the suffix check (it equals the origin host) but
  // can never work — WebAuthn rejects IP rpIDs in the browser. We don't throw
  // (that would break non-passkey managed auth for a dev on an IP host, and
  // there's no valid rpID to substitute when the page itself is served from an
  // IP), but we surface it loudly so the operator isn't left chasing an opaque
  // browser error. Serve the app from a hostname (e.g. `localhost`) to fix it.
  if (isIpLiteralHost(rpID)) {
    log.error(
      { rpID, webOrigin },
      "Resolved WebAuthn rpID is an IP address — rpIDs must be domain names, not IPs, so passkeys "
        + "will fail in the browser regardless. Serve the app from a hostname (e.g. localhost in dev) "
        + "or set ATLAS_RPID to a registrable domain; passkeys are effectively disabled for this origin.",
    );
  }

  return rpID;
}
