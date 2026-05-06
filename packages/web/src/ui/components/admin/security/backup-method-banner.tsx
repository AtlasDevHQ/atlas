"use client";

/**
 * Backup-method banner — top of `/admin/settings/security` (#2092).
 *
 * Wave 2B passkey-recovery surface. Renders when the calling user matches
 * the lockout-risk profile:
 *
 *   exactly one passkey AND no password AND no TOTP
 *
 * That predicate maps to the `passkeyOnly` bucket from the #2094
 * adoption telemetry, narrowed to "single passkey" — a passkey is
 * already multi-factor by WebAuthn UV, but losing the only authenticator
 * is the lockout case admin-mediated reset (#2092 Section 2) exists to
 * recover from. The banner widens that bottleneck by nudging users to
 * either enroll a second passkey (preferred) or keep a password set.
 *
 * Dismissal is per-session (`sessionStorage`) so re-rendering on the
 * next sign-in is automatic — the persistence guarantee from the
 * acceptance criteria. Once the predicate clears (≥2 passkeys, OR a
 * password, OR TOTP), the banner stays away regardless of dismissal
 * state. A user who dismisses then enrolls a second passkey will not
 * see the banner again, even before sessionStorage rotates.
 */

import { useEffect, useMemo, useState } from "react";
import { KeyRound, ShieldAlert, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { cn } from "@/lib/utils";

// Hand-mirrored from `MyMfaFactorsResponseSchema` in
// `packages/api/src/api/routes/admin-mfa-reset.ts`. Update both when the
// response shape changes — keeping the mirror local to the consumer
// avoids pulling the API package into the web bundle.
const MfaFactorsSchema = z.object({
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  passkeyCount: z.number().int().nonnegative(),
});

type MfaFactors = z.infer<typeof MfaFactorsSchema>;

/**
 * Single source of truth for the lockout-risk predicate. Lifted out of
 * the component so a future change (e.g. relax to `passkeyCount <= 1`
 * once the SaaS auth schema enforces a min-2 invariant) only mutates one
 * location.
 *
 * The acceptance criteria pin BOTH halves of the rule:
 *   - exactly one passkey (count === 1, not "≥1")
 *   - no other factor (no password, no TOTP)
 */
function isAtLockoutRisk(f: MfaFactors): boolean {
  return f.passkeyCount === 1 && !f.hasPassword && !f.hasTotp;
}

const DISMISS_STORAGE_KEY = "atlas:backup-method-banner:dismissed";

export interface BackupMethodBannerProps {
  /**
   * Click handler for the primary "Enroll a second passkey" CTA. Wired
   * by the parent so the same passkey-add flow as the enrollment tile
   * fires (consistent OS prompt, naming dialog, post-enroll refetch).
   */
  onAddPasskey: () => void;
  /**
   * Click handler for the secondary "Add a password" CTA. Optional —
   * when omitted (e.g. SaaS deploys that don't expose self-service
   * password setup outside the email flow), the secondary button is
   * suppressed and only the passkey CTA renders.
   */
  onAddPassword?: () => void;
}

export function BackupMethodBanner({ onAddPasskey, onAddPassword }: BackupMethodBannerProps) {
  const { data, loading, error } = useAdminFetch<MfaFactors>(
    "/api/v1/admin/me/mfa-factors",
    { schema: MfaFactorsSchema },
  );

  // sessionStorage is read once on mount — re-renders during this
  // session honor the same value. Per-session dismissal is the
  // acceptance-criteria requirement: dismiss persists "until the
  // predicate clears", and predicate clearing is checked below.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(DISMISS_STORAGE_KEY) === "1";
    } catch (err) {
      // intentionally ignored: storage access can throw in private-mode
      // browsers — falling through to "not dismissed" is the safer
      // default; the banner re-renders once they reach a normal session.
      console.debug("[backup-method-banner] sessionStorage unavailable", err);
      return false;
    }
  });

  function handleDismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_STORAGE_KEY, "1");
    } catch (err) {
      // intentionally ignored: storage write can throw in private-mode
      // browsers — keep the in-memory dismissal so the user sees the
      // banner disappear; it'll re-render on the next sign-in regardless.
      console.debug("[backup-method-banner] sessionStorage write failed", err);
    }
  }

  // If the predicate cleared since the last dismissal (user just
  // enrolled a second passkey, then refetch fired), drop the
  // dismissal flag so the next at-risk session — possibly weeks
  // later — surfaces the banner cleanly.
  useEffect(() => {
    if (!data) return;
    if (dismissed && !isAtLockoutRisk(data)) {
      try {
        window.sessionStorage.removeItem(DISMISS_STORAGE_KEY);
      } catch (err) {
        console.debug("[backup-method-banner] sessionStorage removeItem failed", err);
      }
      setDismissed(false);
    }
  }, [data, dismissed]);

  // Memoize the at-risk decision so a render where `data` is referentially
  // stable but TanStack returns a new wrapper doesn't re-evaluate the
  // predicate every paint.
  const atRisk = useMemo(() => (data ? isAtLockoutRisk(data) : false), [data]);

  // Render-gating waterfall: don't render anything while the snapshot is
  // loading (avoids a flash of the banner that disappears once the
  // session check resolves), don't render on error (the panel below
  // will surface a separate error if it matters), don't render when
  // dismissed for the session, don't render when the user is not at
  // risk. All four branches collapse to the same null return.
  if (loading || error || !data || dismissed || !atRisk) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg ring-1 ring-amber-500/30 bg-amber-500/5 p-4",
        "flex items-start gap-3",
      )}
    >
      <span
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300"
        aria-hidden
      >
        <ShieldAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Add a backup method</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          You have one passkey and no other way to sign in. If you lose access
          to that authenticator, an admin will need to manually reset your
          MFA before you can recover the account. Enrolling a second
          passkey&mdash;ideally on a different device&mdash;is the simplest
          way to widen the recovery path.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onAddPasskey}>
            <KeyRound className="mr-1.5 size-3.5" />
            Enroll a second passkey
          </Button>
          {/*
            Secondary CTA is "Add a password" — only rendered when the
            parent supplies a handler (predicate already required
            hasPassword=false, so suppressing on missing handler is the
            "deploy doesn't expose self-service password setup" carve-out
            documented on the prop).
          */}
          {onAddPassword && (
            <Button size="sm" variant="outline" onClick={onAddPassword}>
              Add a password
            </Button>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleDismiss}
        aria-label="Dismiss for this session"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
