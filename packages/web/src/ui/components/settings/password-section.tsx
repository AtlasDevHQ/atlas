"use client";

/**
 * `/settings/profile` → Change password section.
 *
 * Hidden when auth mode is anything but managed: simple-key / byot users
 * have no Better Auth password row, so the change-password call would 404.
 * Probe `/api/v1/admin/me/password-status` once on mount and short-circuit
 * to nothing on a non-managed reply rather than render a form that always
 * errors.
 */

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAtlasConfig } from "@/ui/context";
import { usePasswordStatus } from "@/ui/hooks/use-password-status";
import { SectionHeading } from "@/ui/components/admin/compact";

const MIN_PASSWORD = 8;

export function PasswordSection() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // The probe returns { kind: "allowed" } in managed auth and 404s in
  // simple-key / byot deployments — render nothing in either non-allowed
  // case rather than a form that can't succeed. `mfa-required` is treated
  // as allowed: the user still needs to be able to rotate their password
  // even while their MFA enrollment is pending.
  const passwordStatus = usePasswordStatus(true);
  const canChangePassword =
    passwordStatus.data?.kind === "allowed" || passwordStatus.data?.kind === "mfa-required";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedAt(null);

    if (!currentPassword) {
      setError("Enter your current password to confirm.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current one.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/admin/me/password`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        // Server may return non-JSON for some error paths (HTML pages,
        // empty bodies). Fall back to the generic HTTP-status message but
        // log the parse failure so flaky upstream replies aren't invisible.
        const data = (await res.json().catch((err) => {
          console.warn("[settings] password error body parse failed", err);
          return {};
        })) as { message?: string };
        setError(data.message ?? `Failed to change password (HTTP ${res.status}).`);
        return;
      }
      reset();
      setSavedAt(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[settings] change-password threw", message);
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  // Defer render until the auth-mode probe resolves — a flash of "change
  // password" that disappears on the next render is worse than waiting.
  if (passwordStatus.isPending) return null;
  if (!canChangePassword) return null;

  return (
    <section>
      <SectionHeading
        title="Password"
        description="Use a unique password — at least 8 characters, ideally more."
      />
      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-1.5">
          <Label htmlFor="profile-current-password">Current password</Label>
          <Input
            id="profile-current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-new-password">New password</Label>
          <Input
            id="profile-new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            placeholder="At least 8 characters"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-confirm-password">Confirm new password</Label>
          <Input
            id="profile-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {savedAt != null && !error && (
          <p className="text-xs text-muted-foreground">Password updated.</p>
        )}

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <KeyRound className="mr-1.5 size-3.5" />
            )}
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}
