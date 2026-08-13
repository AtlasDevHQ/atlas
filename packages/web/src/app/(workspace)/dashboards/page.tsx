"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  useAdminFetch,
  DEFAULT_ENROLLMENT_URL,
} from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/lib/fetch-error";
import { DashboardsEmptyState } from "./empty-state";
import { DashboardListSkeleton } from "@/ui/components/dashboards/dashboard-skeleton";
import { selectMostRecentDashboardId } from "./select-recent";
import { OPEN_CHAT_PARAM } from "./[id]/search-params";
import type { Dashboard } from "@/ui/lib/types";

/**
 * /dashboards is a redirect-only index: it lists the workspace's dashboards
 * and forwards to the most-recently-updated one (or shows the empty state when
 * there are none).
 *
 * This is a CLIENT component on purpose. The previous server component read the
 * incoming request's `cookie` header and forwarded it to the cross-origin API
 * (`api.useatlas.dev`). Under ADR-0024 §5 the session cookie is host-only to
 * the API origin, so the browser never sends it to `app.useatlas.dev` — the SSR
 * fetch saw no session, 401'd, and bounced *logged-in* users to /login (#4089).
 * Fetching from the browser (like /admin) lets the host-only
 * cookie attach automatically via `useAdminFetch`'s credentialed fetch — the
 * same browser-side credential path every other workspace route already uses.
 */
export default function DashboardsPage() {
  const router = useRouter();
  const { data, loading, error, refetch } = useAdminFetch<{
    dashboards: Dashboard[];
  }>("/api/v1/dashboards");

  // #5188 — 401 and 403 mean DIFFERENT things and used to share one branch.
  //
  // 401 is "not signed in", and the /login bounce resolves it. 403 is
  // "signed in, not permitted", which signing in again cannot fix — so
  // bouncing a 403 to /login produces an unbreakable loop: log in, land back
  // here, 403, bounce. Confirmed live in US prod, repeating every ~5s.
  //
  // The 403 that mattered was the admin-MFA enrollment gate firing on brand-new
  // owners; #5189 has since moved dashboards off `createAdminRouter()`, so it
  // can no longer originate here. This branch stays because it is the residual
  // path for ANY future 403 carrying that code, and because the enrollment URL
  // is the one destination that can actually clear it — `MfaGateProvider` is
  // mounted only in `admin-layout.tsx`, so on this `(workspace)` route
  // `useAdminFetch`'s `mfaGate.trigger()` resolves to a NO-OP and no dialog
  // ever appears.
  //
  // Everything else 403 falls through to the error card below, which renders
  // what the SERVER said rather than a guess — see the card for why that
  // distinction is load-bearing.
  const isUnauthenticated = error?.status === 401;
  // `enrollmentUrl` is sanitized to a same-origin path by `extractFetchError`,
  // the one place it enters `FetchError` — so every consumer that reads it off a
  // `FetchError` inherits the guard rather than each re-deriving one. An earlier
  // version of this fix guarded HERE instead, which protected only this page's
  // `router.replace` and left `mfa-enrollment-dialog`'s `router.push`
  // unguarded. (`admin-layout` reads the field from `usePasswordStatus`, which
  // parses the body itself and never enters `FetchError` — sanitized there
  // separately.)
  const mfaEnrollmentUrl =
    error?.status === 403 && error.code === "mfa_enrollment_required"
      ? (error.enrollmentUrl ?? DEFAULT_ENROLLMENT_URL)
      : null;
  // Drives the skeleton + the redirect effect: both 401 and the MFA case
  // navigate away, so neither should paint the error card on the way out.
  const isNavigatingAway = isUnauthenticated || mfaEnrollmentUrl !== null;

  const targetId = data
    ? selectMostRecentDashboardId(data.dashboards ?? [])
    : null;

  // #4563 — set when the empty state navigates to a just-created board (with
  // `?openChat=true` so the bound editor opens on arrival). The post-creation
  // list refetch flips `targetId` to that same board, and without this flag
  // the redirect effect below would race the creation push with a plain
  // `router.replace("/dashboards/{id}")` — stripping the editor-open intent
  // before the canvas consumed it.
  const [creationHandoff, setCreationHandoff] = useState(false);

  useEffect(() => {
    if (isUnauthenticated) {
      router.replace("/login?redirect=/dashboards");
      return;
    }
    if (mfaEnrollmentUrl) {
      router.replace(mfaEnrollmentUrl);
      return;
    }
    if (!targetId) return;
    // #4563 — during a creation handoff, converge on the same
    // intent-preserving URL the empty state pushed instead of standing down:
    // the replace is idempotent with the push (whichever navigation lands,
    // the canvas opens the bound editor), so the redirect can neither strip
    // the intent nor strand the index on the skeleton if the push is
    // superseded.
    router.replace(
      creationHandoff
        ? `/dashboards/${targetId}?${OPEN_CHAT_PARAM}=true`
        : `/dashboards/${targetId}`,
    );
  }, [isUnauthenticated, mfaEnrollmentUrl, targetId, router, creationHandoff]);

  // Auth bounce, MFA-enrollment hand-off, dashboard redirect, or creation
  // handoff in flight — show the layout-matching skeleton (not a blank frame)
  // so the redirect never flashes an empty screen (#4323). The empty/error
  // chrome is still gated below so it can't flash before navigation lands.
  if (isNavigatingAway || targetId || creationHandoff)
    return <DashboardListSkeleton />;

  if (error) {
    // A PERMISSION 403 is an answer, not a transient failure: "Couldn't load"
    // invites a retry that cannot work, and offering "Try again" is what made
    // the dead end read as a glitch.
    //
    // ⚠️ Keyed on `code`, not on the bare status. `GET /api/v1/dashboards`
    // answers 403 for several reasons and only the permission ones are about
    // roles: `ip_not_allowed`, the SSO-enforcement 403 and the
    // password-change gate all carry a remedy the CALLER can act on, authored by
    // the gate that knows it. Telling those users to go find an administrator is
    // this issue's own defect one level down, and swapping in canned copy loses
    // both the server's sentence and the requestId `friendlyError` appends.
    //
    // Enumerated post-#5189: `insufficient_permissions` is minted directly by
    // `permission-resolve`, so it reaches the client under its own name.
    // `api_key_not_permitted` cannot arise from a browser session, and
    // `forbidden_role` comes only from the admin/platform-admin role checks
    // (`adminAuth`, `platformAdminAuth`, `billing`'s inline BYOT gate), none of
    // which dashboards traverse — it is kept here as the defensive arm for a
    // future route, not because this one can produce it. Everything else is
    // rewritten by `authErrorCode` to `auth_error` / `session_expired` and
    // lands, correctly, in the server-message branch.
    const isPermissionDenial =
      error.status === 403 &&
      (error.code === "insufficient_permissions" || error.code === "forbidden_role");
    // ⚠️ Retry is for TRANSIENT failures, and no 403 is transient. The first
    // version of this fix removed the button only for the permission arm, which
    // reproduced the finding one arm over: `ip_not_allowed` (clearable only from
    // an admin-only page) and the SSO-enforcement 403 were handed the one action
    // that re-fails identically forever. Their server messages already name the
    // real remedy — rendering that and offering nothing false is the honest
    // pair.
    const isRetryable = error.status !== 403;
    // #5191 — the one 403 that DOES have an action, now that `FetchError`
    // carries the field. `ssoRedirectUrl` is the workspace's own identity
    // provider, and signing in there is exactly what clears the enforcement.
    // Without it this user reads a sentence about their IdP and has nowhere to
    // go — which is the same dead end the retry button was removed for, minus
    // the false hope.
    //
    // ⚠️ NOT navigated automatically. The MFA arm above `router.replace`s
    // because that gate is unconditional and the destination is our own page;
    // this one leaves the workspace for a third-party login, and a silent
    // cross-origin bounce out of a page the user asked for is not ours to
    // perform. `extractFetchError` has already restricted it to an
    // `http(s)` absolute URL.
    const ssoUrl = error.status === 403 ? error.ssoRedirectUrl : undefined;
    return (
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 text-center">
        <h1 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          {isPermissionDenial
            ? "You don’t have access to dashboards"
            : "Couldn’t load your dashboards"}
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          {isPermissionDenial
            ? `${friendlyError(error)} Ask a workspace administrator to grant your role access to dashboards.`
            : friendlyError(error)}
        </p>
        {ssoUrl && (
          <Button size="sm" className="mt-6" asChild>
            {/* A plain anchor, not `router.push`: the destination is a
                third-party origin, which the Next router does not handle. */}
            <a href={ssoUrl}>Sign in with your identity provider</a>
          </Button>
        )}
        {isRetryable && (
          <Button
            size="sm"
            variant="outline"
            className="mt-6"
            onClick={() => refetch()}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }

  // Still loading the list (no data yet) — show the skeleton rather than a
  // blank frame while the fetch is in flight.
  if (loading || !data) return <DashboardListSkeleton />;

  // Loaded with no dashboards.
  return (
    <DashboardsEmptyState
      onCreationNavigate={() => setCreationHandoff(true)}
    />
  );
}
