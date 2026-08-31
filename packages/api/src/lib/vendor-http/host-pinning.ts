/**
 * Concern 4 of 4 — host pinning for a tenant-typed base URL.
 *
 * This owns the CALL SHAPE, not the guard: `assertBaseUrlAllowed` and
 * `hostForLog` stay in `openapi/egress-guard.ts` and are consumed from here.
 * ADR-0045 already names `guardedFetch` as shared surface; nothing about the
 * guard moved.
 *
 * ── Why this is a concern at all ─────────────────────────────────────────
 *
 * A base URL that arrives in a `workspace_action_credentials` row is typed by
 * a WORKSPACE admin — on SaaS a tenant, not the operator — and the request
 * carries a credential to whatever host it names. Unguarded, that turns a
 * settings form into an outbound probe of the deployment's own network with
 * auth attached. Salesforce reasoned its way to the guard on its own
 * (`normalizeInstanceUrl`); Jira, the older sibling, shipped without it on the
 * same class of value. Two independent derivations of one check, one of them
 * missing, is the shape ADR-0045's deferral trigger named.
 *
 * ── Why the refusal copy is templated and not the guard's own ────────────
 *
 * The refusal deliberately does not echo the guard's wording. Naming "blocked
 * internal address" back to whoever typed the URL turns the form into a
 * network scanner with a readout — so the caller supplies vendor-shaped copy
 * that is actionable to an admin who typed a typo and useless to one probing
 * the network. Both migrated clients kept their exact wording through this
 * template.
 *
 * @see ./index.ts — the spine's scope, and what it deliberately does NOT own.
 * @see ../openapi/egress-guard.ts — the guard itself, unchanged.
 */

import type { Logger } from "pino";
import { assertBaseUrlAllowed, hostForLog } from "@atlas/api/lib/openapi/egress-guard";

export interface VendorHostPinOptions {
  /** The caller's own logger, so a refusal keeps its `action:<vendor>` scope. */
  readonly log: Logger;
  /**
   * How the operator-facing error names this URL, as a sentence subject —
   * e.g. `"The configured Jira base URL"`.
   */
  readonly label: string;
  /** How the log line names it — e.g. `"Jira base URL"`. */
  readonly subject: string;
  /** The vendor noun in the refusal — e.g. `"Jira"`. */
  readonly vendor: string;
  /**
   * What a correct value is, with no leading article and no trailing period —
   * e.g. `"your Jira site URL, e.g. https://acme.atlassian.net"`. Read into
   * both `It should be <…>.` and `Use <…>.`
   */
  readonly shouldBe: string;
  /**
   * Keep the URL's path, trailing slashes stripped. Default: reduce to the
   * origin. Jira needs the path (a site can live under one); Salesforce's My
   * Domain URL is an origin.
   */
  readonly keepPath?: boolean;
}

/**
 * Validate a tenant-typed base URL and return its normalized form.
 *
 * Throws — with copy an admin can act on — when the value is not a URL, is
 * not https, or is refused by the egress guard. Nothing reaches the network
 * before this returns.
 */
export function pinVendorHost(raw: string, opts: VendorHostPinOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    opts.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      `${opts.subject} is not a valid URL`,
    );
    throw new Error(`${opts.label} is not a valid URL. It should be ${opts.shouldBe}.`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${opts.label} must use https (got "${parsed.protocol}").`);
  }

  try {
    assertBaseUrlAllowed(parsed.origin);
  } catch (err) {
    opts.log.error(
      { host: hostForLog(parsed.origin), err: err instanceof Error ? err.message : String(err) },
      `${opts.subject} was refused by the egress guard`,
    );
    throw new Error(
      `${opts.label} does not point at a reachable public ${opts.vendor} host. Use ${opts.shouldBe}.`,
    );
  }

  return opts.keepPath ? parsed.origin + parsed.pathname.replace(/\/+$/, "") : parsed.origin;
}
