"use client";

import type { LucideIcon } from "lucide-react";
import { Ban, Cloud, ServerOff, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isSaasExclusiveFeature,
  type FeatureName,
} from "@/ui/components/admin/feature-registry";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { unexplainedFailure } from "@/ui/lib/fetch-error";

/**
 * Dedicated upsell shown when an admin page returns an
 * `enterprise_required` error (403 + `{ error: "enterprise_required" }`).
 *
 * Distinct from the generic `FeatureGate` 403 ("Access denied") so non-EE
 * admins see "this feature needs an enterprise plan" with a concrete next
 * step, rather than assuming their account lacks a role.
 *
 * Hosted-SaaS-only features (e.g. proactive monitoring, #3999) reuse the same
 * `enterprise_required` envelope but are denied on every self-hosted
 * deployment *including self-hosted enterprise* — no plan upgrade unlocks them
 * locally. On self-hosted we therefore swap to hosted-only copy + an Atlas
 * Cloud CTA instead of the "upgrade / contact sales" line, which would be
 * misleading there. (On SaaS the denial is a real per-tier gate, so the
 * upgrade copy stays.) Deploy mode here is a cosmetic-only branch, so
 * rendering from `useDeployMode`'s hostname guess before the settings fetch
 * resolves is acceptable per its contract.
 */
export function EnterpriseUpsell({
  feature,
  message,
  requestId,
}: {
  feature: FeatureName;
  /** The server's description of this refusal. Pass `serverMessage(err)`. */
  message?: string;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  // Only SaaS-exclusive features need the authoritative deploy mode; for every
  // other feature `hostedOnly` is false regardless, so skip the settings fetch
  // (`enabled: false` → host guess, which we then ignore).
  const isSaasExclusive = isSaasExclusiveFeature(feature);
  const { deployMode } = useDeployMode({ enabled: isSaasExclusive });
  const hostedOnly = isSaasExclusive && deployMode === "self-hosted";
  // Same normalization, same reason, as `FeatureGate`: "   " is truthy, so a
  // whitespace message would render the headline over an empty <p>.
  const authored = message?.trim() || undefined;

  if (hostedOnly) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <Cloud className="mx-auto size-10 text-primary/70" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">
            {feature} is an Atlas Cloud feature
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {authored ??
              `${feature} is available only on Atlas Cloud (the hosted SaaS) and can't be enabled on a self-hosted deployment.`}
          </p>
          <div className="mt-4 flex justify-center">
            <Button asChild size="sm" variant="outline">
              <a
                href="https://www.useatlas.dev"
                target="_blank"
                rel="noreferrer noopener"
              >
                Learn about Atlas Cloud
              </a>
            </Button>
          </div>
          <GateRequestId requestId={requestId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <ShieldCheck
          className="mx-auto size-10 text-primary/70"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm font-medium">
          {feature} requires an enterprise plan
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {authored ??
            `${feature} is part of Atlas Enterprise. Upgrade your plan or contact sales to enable it for your workspace.`}
        </p>
        <div className="mt-4 flex justify-center">
          <Button asChild size="sm" variant="outline">
            <a
              href="https://www.useatlas.dev/enterprise"
              target="_blank"
              rel="noreferrer noopener"
            >
              Learn about Atlas Enterprise
            </a>
          </Button>
        </div>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}

/**
 * The statuses that route to {@link FeatureGate} rather than a red error
 * banner: a refusal the operator is meant to act on, not a fault.
 *
 * One definition, because the set was previously written out at five call
 * sites — three of them beside an `as` cast TypeScript was told to trust, and
 * they did not all spell the same list. Widening the union without touching
 * every `includes` list compiled and silently gated nothing new.
 * `isGateStatus` narrows, so the casts are gone and the copies cannot
 * disagree.
 */
export const GATE_STATUSES = [401, 403, 404, 503] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export function isGateStatus(status: number | undefined): status is GateStatus {
  return status !== undefined && (GATE_STATUSES as readonly number[]).includes(status);
}

/**
 * The correlation id, rendered under whichever gated placeholder is showing.
 *
 * A gate an operator did not expect — a 403 they believe they should pass, a
 * 404 on a feature they configured, an entitlement that should be live — is
 * un-diagnosable without this. `friendlyError` appends it to non-gated errors;
 * the gated placeholders had nowhere to put it, so it was simply dropped.
 *
 * All three FULL-SURFACE placeholders now render it (#5068). The one gated
 * surface that still does not is `MutationErrorSurface`'s inline
 * `enterprise_required` variant, which is a single line of text with no room
 * for it.
 */
export function GateRequestId({ requestId }: { requestId?: string }) {
  // `.trim()` for the same reason `serverMessage` trims: `extractFetchError`
  // accepts any string, so "   " would render the label over nothing — the
  // blank-chrome class, one field over.
  if (!requestId?.trim()) return null;
  return (
    <p
      data-testid="feature-gate-request-id"
      className="mt-2 font-mono text-[11px] text-muted-foreground/70"
    >
      Request ID: {requestId.trim()}
    </p>
  );
}

/**
 * The shared body of every {@link FeatureGate} arm: icon, headline, one line
 * of description, and the correlation id.
 *
 * Extracted so the id renders identically on all four statuses. Before #5068
 * each arm was its own copy of this markup and the id had nowhere to go.
 */
function GateBody({
  icon: Icon,
  title,
  description,
  requestId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  requestId?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <Icon className="mx-auto size-10 text-muted-foreground/50" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}

/**
 * Shown when an admin page gets a 401/403/404/503 status.
 *
 * Evaluation order (matches code):
 * - 503 → unavailable (authz outage, billing check, restarting service, …)
 * - 404 → feature not enabled (enterprise config, no internal database)
 * - 401 → authentication required
 * - 403 → insufficient role
 *
 * Every arm prefers the server's own `message` over its canned copy, because
 * the canned line is a guess at the cause from the status alone and the
 * server knows. The canned copy is the fallback for an empty response body —
 * which is why callers should use `gateProps(err)` rather than hand-passing
 * `err.message` (see `serverMessage`: the latter is a synthesized placeholder
 * on an empty body, and rendering it replaces real guidance with a status
 * echo).
 *
 * 401 briefly *appended* its canned sign-in line instead, on the theory that
 * the affordance stays true whatever the server said. It does not, and the
 * concatenation was the giveaway: most 401 messages the API emits are bare
 * fragments with no terminal punctuation (`managed.ts` — "Not signed in",
 * "Account is banned", "Session expired (idle timeout)"; `byot.ts` — "JWT
 * missing sub claim"), so the shipped line read "Not signed in Please sign in
 * to access the admin console." And for a banned account, or either
 * key-based `ATLAS_AUTH_MODE`, signing in is exactly what will not help. The
 * headline carries the affordance; the description belongs to whoever knows
 * the cause.
 *
 * ⚠️ This makes the `message` field of every gated 401/403/404/503 response
 * user-facing prose on ~60 admin pages. Before #5068 it reached the screen on
 * `enterprise_required` 403s only.
 * A route that interpolates a driver error, a connection string, or a caught
 * `err.message` into a gated status now puts it on an admin's screen — see
 * CLAUDE.md § "No secrets in responses".
 */
export function FeatureGate({
  status,
  feature,
  message,
  requestId,
}: {
  status: GateStatus;
  feature: FeatureName;
  /** The server's description of *this* refusal. Pass `serverMessage(err)`. */
  message?: string;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  // Normalize once, here, rather than guarding at each arm. `serverMessage`
  // already trims blanks away, but this prop is a bare `string | undefined`
  // that any caller can hand "   " — and a whitespace message is truthy, so
  // even the `||` guards below would render the icon and headline over an
  // empty <p>. That is the blank-chrome failure `buildFetchError` exists to
  // prevent, arriving one layer lower.
  const authored = message?.trim() || undefined;

  if (status === 503) {
    // This arm used to assert one cause — "Internal database not configured /
    // Set DATABASE_URL" — on every 503, and it is the wrong place to say it.
    //
    // Not because no such 503 exists: `no_internal_db` from
    // `ee/platform/residency.ts` and `ee/platform/domains.ts` maps to 503
    // (`shared-residency.ts`, `shared-domains.ts`), and `/platform/residency`
    // consumes one. But every one of those carries its own message
    // ("Internal database is required for data residency."), so `serverMessage`
    // renders it verbatim through the branch above and this fallback is never
    // what an operator with a missing DATABASE_URL reads.
    //
    // What reaches HERE is a 503 with no message at all — an infrastructure
    // one with an HTML body, a restarting service, an unhealthy proxy — plus
    // authz outages like `permissions_unavailable`. Sending that operator to
    // set a variable which is already set is the misdirection.
    //
    // What actually reaches the no-message branch is an infrastructure 503
    // with an HTML body — a restarting service, an unhealthy proxy — where
    // `extractFetchError` finds no message at all. Sending that operator to
    // set a variable which is already set is the misdirection, not the
    // absence of a guess.
    return (
      <GateBody
        icon={ServerOff}
        title={`${feature} is unavailable`}
        description={
          authored ?? unexplainedFailure(503)
        }
        requestId={requestId}
      />
    );
  }

  if (status === 404) {
    return (
      <GateBody
        icon={Ban}
        title={`${feature} not enabled`}
        description={
          authored ?? "Enable this feature in your server configuration to use this page."
        }
        requestId={requestId}
      />
    );
  }

  // Exhaustiveness: 404 and 503 returned above, so only 401 | 403 may remain.
  // Widening `GATE_STATUSES` without adding an arm is a compile error here,
  // rather than a new status silently rendering "Access denied" — a wrong
  // diagnosis on screen, which is worse than the un-narrowed casts this
  // replaced.
  //
  // The literals are the whole point. `Exclude<GateStatus, 404 | 503>` reads
  // better and is worthless: it is computed FROM `GateStatus`, so widening the
  // tuple widens the annotation in lockstep and the assignment stays valid
  // forever. That was this file's own version of a fixture agreeing with
  // itself by construction, at the type level — verified by adding 429 to
  // `GATE_STATUSES` and watching tsgo exit 0.
  const authStatus: 401 | 403 = status;
  return (
    <GateBody
      icon={ShieldX}
      title={authStatus === 401 ? "Authentication required" : "Access denied"}
      description={
        authored ??
        (authStatus === 401
          ? "Please sign in to access the admin console."
          : "You need the admin role to access this page.")
      }
      requestId={requestId}
    />
  );
}

/**
 * Inline placeholder shown when an admin page fetch returns 403 with
 * `error: "mfa_enrollment_required"` (#2486). Without this carve-out the
 * generic FeatureGate would render "You need the admin role to access
 * this page." — which is misleading copy for an MFA-not-yet-enrolled
 * admin (the role check passed; only the second-factor check failed).
 *
 * On most routes the admin layout's full-screen gate covers this
 * placeholder before the user sees it; the inline copy is the carve-out
 * for the enrollment page itself (`/admin/account-security`), which the
 * layout intentionally leaves un-gated so the user can finish setup.
 *
 * The copy stays fixed on purpose — the server's 403 message is the generic
 * two-factor line and the enrollment CTA is the whole value here, so #5068's
 * "prefer the server's words" does NOT apply. The correlation id does: an
 * admin who *has* enrolled and still hits this needs something to hand an
 * operator.
 */
export function MfaRequiredPlaceholder({
  feature,
  requestId,
}: {
  feature: FeatureName;
  /** Correlation id from the response body, for log lookup. */
  requestId?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <ShieldCheck className="mx-auto size-10 text-primary/70" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Two-factor required</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enroll an authenticator app or passkey to access {feature}.
        </p>
        <GateRequestId requestId={requestId} />
      </div>
    </div>
  );
}
