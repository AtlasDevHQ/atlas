"use client";

/**
 * `/settings/profile` → Change password section.
 *
 * Posts to the existing self-service `POST /api/v1/admin/me/password` endpoint
 * — same handler the forced-change `<ChangePasswordDialog>` uses, but rendered
 * inline as a user-initiated form (no current-password prefill, no force-open).
 *
 * Hidden when auth mode is anything but managed: simple-key / byot users
 * authenticate without a Better Auth password row, so the change-password
 * call would always 404.
 */

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAtlasConfig } from "@/ui/context";
import { SectionHeading } from "@/ui/components/admin/compact";

const MIN_PASSWORD = 8;

export function PasswordSection() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

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
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        if (res.status === 404) {
          setError(
            "Password changes aren't available in this auth mode. Contact your administrator.",
          );
        } else {
          setError(data.message ?? `Failed to change password (HTTP ${res.status}).`);
        }
        return;
      }
      reset();
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

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
