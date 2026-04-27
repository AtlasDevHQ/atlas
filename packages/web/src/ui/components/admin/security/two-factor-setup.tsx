"use client";

/**
 * Two-factor (TOTP) enrollment for admin and platform_admin accounts.
 *
 * Backs the `/privacy` §9 + `/dpa` Annex II "MFA-required admin access" claim
 * (#1925). Mounted under `/admin/settings/security`. The page surfaces three
 * states:
 *
 *   1. Not enrolled       — show "Enable two-factor" button. Triggers
 *                           authClient.twoFactor.enable() which returns
 *                           `{ totpURI, backupCodes }`. Render the URI as
 *                           a copyable text plus the backup codes (one
 *                           time only — admins are warned to save them).
 *   2. Pending verify     — show a 6-digit input. Submit calls
 *                           authClient.twoFactor.verifyTotp() which flips
 *                           `user.twoFactorEnabled` to true on success and
 *                           clears the mfa_enrollment_required gate.
 *   3. Enrolled           — show "Regenerate backup codes" + "Disable"
 *                           controls, both behind a password-confirm dialog.
 *
 * No QR code library is bundled. Authenticator apps that support otpauth://
 * URIs (Google Authenticator, 1Password, Authy, Bitwarden) accept the URI
 * directly. The page also surfaces the manual TOTP secret for users on
 * authenticators that need it. This keeps the bundle out of the React
 * Compiler's hot path; we can revisit if user feedback warrants.
 */

import { useState } from "react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Lock,
  ShieldCheck,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape returned by Better Auth's `twoFactor.enable` action. Typed loosely
 * here because the client plugin's exported type isn't reachable through
 * `createAuthClient`'s plugin generic chain.
 */
interface EnableResponse {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Result wrapper Better Auth uses for client actions. `data` is null on
 * error, `error` is null on success — we narrow at the call site.
 */
type ClientResult<T> = { data: T | null; error: { message?: string } | null };

// Minimal contract for the parts of authClient.twoFactor we use. Keeps the
// component working under TS6's stricter inference of plugin-augmented
// clients without resorting to `any`.
interface TwoFactorClient {
  enable: (opts: { password: string }) => Promise<ClientResult<EnableResponse>>;
  verifyTotp: (opts: { code: string }) => Promise<ClientResult<unknown>>;
  disable: (opts: { password: string }) => Promise<ClientResult<unknown>>;
  generateBackupCodes: (opts: {
    password: string;
  }) => Promise<ClientResult<{ backupCodes: string[] }>>;
}

function getTwoFactor(): TwoFactorClient {
  return (authClient as unknown as { twoFactor: TwoFactorClient }).twoFactor;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the `secret` query param out of an otpauth:// URI so the page can
 * render the manual key alongside the URI. Returns `null` if the URI is
 * malformed — the UI then shows only the URI and a "copy" affordance.
 */
function extractSecret(totpURI: string): string | null {
  try {
    // otpauth://totp/Issuer:user@example.com?secret=...&issuer=...
    const url = new URL(totpURI);
    return url.searchParams.get("secret");
  } catch {
    return null;
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // intentionally ignored: clipboard write can fail on insecure origins
    // or denied permissions; the UI falls back to "select & copy manually"
    return false;
  }
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface CopyFieldProps {
  label: string;
  value: string;
  monospace?: boolean;
}

function CopyField({ label, value, monospace }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          className={monospace ? "font-mono text-xs" : "text-sm"}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="shrink-0"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

interface BackupCodesProps {
  codes: string[];
}

function BackupCodes({ codes }: BackupCodesProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyToClipboard(codes.join("\n"));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Save these backup codes
          </p>
          <p className="text-xs text-amber-800/80 dark:text-amber-200/80">
            Each code lets you sign in once if your authenticator is unavailable.
            They will not be shown again.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pt-2 font-mono text-sm tabular-nums">
        {codes.map((code) => (
          <div
            key={code}
            className="rounded border border-amber-500/20 bg-background/60 px-2 py-1.5 text-center"
          >
            {code}
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="w-full"
      >
        {copied ? (
          <>
            <Check className="mr-1.5 size-3.5" />
            Copied to clipboard
          </>
        ) : (
          <>
            <Copy className="mr-1.5 size-3.5" />
            Copy all codes
          </>
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface TwoFactorSetupProps {
  /**
   * Whether the current user already has a verified second factor on file.
   * Drives the initial render: the "enable" path when false, the "manage"
   * path when true. Sourced from `authClient.useSession().data.user.twoFactorEnabled`
   * upstream so the page can observe Better Auth's session reactivity.
   */
  enabled: boolean;
  /**
   * Called after a successful enroll / disable / regenerate so the parent
   * can refetch session state and re-render with the updated `enabled` flag.
   */
  onChange?: () => void;
}

type EnrollStage =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "confirm"; totpURI: string; backupCodes: string[] }
  | { kind: "verifying" };

export function TwoFactorSetup({ enabled, onChange }: TwoFactorSetupProps) {
  const [stage, setStage] = useState<EnrollStage>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [regenCodes, setRegenCodes] = useState<string[] | null>(null);

  function reset() {
    setStage({ kind: "idle" });
    setPassword("");
    setCode("");
    setError(null);
    setBusy(false);
  }

  async function handleEnable() {
    setBusy(true);
    setError(null);
    const result = await getTwoFactor().enable({ password });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Could not enable two-factor authentication.");
      return;
    }
    setStage({
      kind: "confirm",
      totpURI: result.data.totpURI,
      backupCodes: result.data.backupCodes,
    });
  }

  async function handleVerify() {
    setBusy(true);
    setError(null);
    const result = await getTwoFactor().verifyTotp({ code });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "That code didn't match. Try again.");
      return;
    }
    reset();
    onChange?.();
  }

  async function handleRegenerate() {
    setBusy(true);
    setError(null);
    const result = await getTwoFactor().generateBackupCodes({ password: confirmPassword });
    setBusy(false);
    setConfirmPassword("");
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Could not regenerate backup codes.");
      return;
    }
    setRegenCodes(result.data.backupCodes);
    setRegenOpen(false);
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    const result = await getTwoFactor().disable({ password: confirmPassword });
    setBusy(false);
    setConfirmPassword("");
    if (result.error) {
      setError(result.error.message ?? "Could not disable two-factor authentication.");
      return;
    }
    setDisableOpen(false);
    onChange?.();
  }

  // ── Enrolled view ──────────────────────────────────────────────────

  if (enabled) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm font-semibold">Two-factor on</CardTitle>
              <p className="text-xs text-muted-foreground">
                Authenticator app codes are required at every sign-in.
              </p>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 pt-0">
            <Button variant="outline" size="sm" onClick={() => setRegenOpen(true)}>
              Regenerate backup codes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDisableOpen(true)}>
              Disable two-factor
            </Button>
          </CardContent>
        </Card>

        {regenCodes && <BackupCodes codes={regenCodes} />}
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Regenerate backup codes?</AlertDialogTitle>
              <AlertDialogDescription>
                This invalidates your existing backup codes. Make sure to save the new
                codes — they won't be shown again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5 py-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Confirm with your password
              </label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmPassword("")}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleRegenerate}
                disabled={busy || !confirmPassword}
              >
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Regenerate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disable two-factor?</AlertDialogTitle>
              <AlertDialogDescription>
                Disabling two-factor will weaken your account security. Admin-role
                accounts will be locked out of the admin console until they re-enroll.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5 py-2">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Confirm with your password
              </label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmPassword("")}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDisable}
                disabled={busy || !confirmPassword}
              >
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Disable
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  // ── Not-enrolled view ──────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-amber-500/5 text-amber-600 dark:text-amber-400">
            <Lock className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm font-semibold">Two-factor required</CardTitle>
            <p className="text-xs text-muted-foreground">
              Admin accounts must enroll a TOTP authenticator. Until you do, the
              admin console will be locked.
            </p>
          </div>
        </CardHeader>

        {stage.kind === "idle" && (
          <CardContent className="pt-0">
            <Button onClick={() => setStage({ kind: "password" })}>
              Set up two-factor
            </Button>
          </CardContent>
        )}

        {stage.kind === "password" && (
          <CardContent className="space-y-3 pt-0">
            <p className="text-sm text-muted-foreground">
              Confirm your password to start enrollment. We'll show your TOTP secret
              and one-time backup codes on the next step.
            </p>
            <Input
              type="password"
              placeholder="Current password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button onClick={handleEnable} disabled={busy || !password}>
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Continue
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        )}

        {stage.kind === "confirm" && (
          <CardContent className="space-y-4 pt-0">
            <ol className="ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
              <li>
                Add Atlas to your authenticator app — paste the URI below or scan
                its QR code in your password manager.
              </li>
              <li>Save the backup codes somewhere safe.</li>
              <li>Enter the 6-digit code your authenticator generates.</li>
            </ol>

            <CopyField label="Otpauth URI" value={stage.totpURI} monospace />
            {extractSecret(stage.totpURI) && (
              <CopyField
                label="Manual setup key"
                value={extractSecret(stage.totpURI) ?? ""}
                monospace
              />
            )}

            <BackupCodes codes={stage.backupCodes} />

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Authenticator code
              </label>
              <Input
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="font-mono text-base tracking-widest"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleVerify} disabled={busy || code.length !== 6}>
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Verify and finish
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
