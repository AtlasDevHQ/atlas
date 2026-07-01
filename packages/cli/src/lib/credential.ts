/**
 * The workspace credential the REST-backed CLI clients updated in #4112
 * (`sql`/`metric`/`explore`/`datasource`) authenticate with (ADR-0027 §5), plus
 * `query`, which joined this XOR-credential path in #4124 (so `ATLAS_API_KEY`
 * now rides as `x-api-key`, not the operator Bearer). The legacy `import`/`init`
 * commands still route `ATLAS_API_KEY` through the separate operator-Bearer path
 * and do NOT use this type.
 *
 * Authorization rides on exactly ONE of two mutually-exclusive credential
 * classes — never both:
 *  - the `atlas login` device-flow SESSION bearer (interactive / ambient reuse),
 *    sent as `Authorization: Bearer <token>`; OR
 *  - a workspace-scoped API key for UNATTENDED CI (#4046), sent as
 *    `x-api-key: <key>` (the Better Auth `apiKey()` plugin's header).
 *
 * Modelled as an XOR (a discriminated union), NOT two independent optionals, so
 * "exactly one credential" is a compile-time invariant the clients can't violate
 * — there is no representable `{ token, apiKey }` (both) or `{}` (neither) state.
 * The server resolves whichever header it sees to the bound workspace and runs
 * the full gate chain; the CLI never re-derives any of that and never sends an
 * org/workspace field.
 */
export type CliCredential =
  | { readonly token: string; readonly apiKey?: never }
  | { readonly apiKey: string; readonly token?: never };

/**
 * The auth header for a credential: `x-api-key` for a workspace key, otherwise
 * `Authorization: Bearer` for a device-flow session. The XOR type guarantees
 * exactly one branch applies — there is no "both/neither" runtime ambiguity to
 * defend against.
 *
 * Also sends `X-Atlas-Mode: developer` on every request (#4126). The CLI is
 * itself a "developer" surface — distinct from the published end-user `/chat`
 * — so an admin operating it should see and query their OWN just-created
 * drafts (`atlas datasource create`/`profile` land as drafts, ADR per
 * `docs/development/content-mode.md`) without first publishing, exactly as
 * the admin console's developer-mode toggle already lets them. This is safe
 * to send unconditionally: `resolveMode` (`api/routes/middleware.ts`)
 * downgrades the request back to `published` server-side for any non-admin
 * role, so a member-floor credential gets no extra visibility — only the
 * admin-gated datasource ops this header actually matters for see any effect.
 */
export function credentialHeaders(credential: CliCredential): Record<string, string> {
  return {
    ...(credential.apiKey
      ? { "x-api-key": credential.apiKey }
      : { Authorization: `Bearer ${credential.token}` }),
    "X-Atlas-Mode": "developer",
  };
}

/**
 * Read the `--api-key <key>` flag from argv, accepting BOTH the space form
 * (`--api-key foo`) and the inline form (`--api-key=foo`). Single-sourced here so
 * `sql`/`metric`/`datasource` honour an explicitly-passed key identically: a
 * command that matched only the space form would silently drop `--api-key=foo`
 * and fall back to the ambient `atlas login` session — running as the wrong
 * identity with no surfaced error. Returns undefined when the flag is absent (or
 * its space form has no value), so the caller falls through to `ATLAS_API_KEY`.
 *
 * `explore` does NOT use this — it must also strip the flag + value out of the
 * command string it forwards to the server, so it parses argv in one pass
 * (`parseExploreArgs`) that handles both forms identically.
 */
export function readApiKeyFlag(args: string[]): string | undefined {
  const prefix = "--api-key=";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--api-key") {
      const next = args[i + 1];
      // `--api-key` with no following value (or another flag next) yields nothing.
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

/**
 * Resolve which credential a command should use, applying the precedence the four
 * REST-backed subcommands share (#4112) — `metric`/`explore`/`datasource` call
 * this directly; `sql` applies the same precedence inline (it interleaves the
 * `--workspace` rebind guard). A workspace API key (the `--api-key` flag or
 * `ATLAS_API_KEY`, already collapsed into `apiKey` by the caller) wins over a
 * stored `atlas login` session — unattended CI never goes through `atlas login`.
 * Returns `null` when neither is present, so the caller can surface a single
 * "log in or set ATLAS_API_KEY" message.
 */
export function resolveCredential(
  apiKey: string | undefined,
  session: { readonly token: string } | null,
): CliCredential | null {
  if (apiKey) return { apiKey };
  if (session) return { token: session.token };
  return null;
}
