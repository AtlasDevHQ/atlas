"use client";

/**
 * `/settings/profile` → Identity section.
 *
 * Email is intentionally read-only — Atlas is B2B; email is the org-managed
 * account anchor (often SSO / SCIM-provisioned, always the audit trail key).
 * Letting end-users mutate their own email is a consumer pattern that breaks
 * org provisioning and forensic queries.
 */

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeading } from "@/ui/components/admin/compact";

export function IdentitySection() {
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; name?: string }
    | undefined;

  const [name, setName] = useState<string>(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== (user?.name ?? "").trim();

  // Resync from session ONLY when the user isn't actively editing — `!dirty`
  // (vs. `!saving`) prevents an unrelated session refetch landing mid-edit
  // from clobbering what they're typing.
  useEffect(() => {
    if (user?.name != null && !dirty && !saving) {
      setName(user.name);
    }
  }, [user?.name, dirty, saving]);

  function handleNameChange(value: string) {
    setName(value);
    // Editing dismisses any stale success/error banner so the form's state
    // always reflects the *current* unsubmitted draft.
    if (error) setError(null);
    if (savedAt != null) setSavedAt(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;

    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const updateUser = authClient.updateUser;
      if (typeof updateUser !== "function") {
        setError("Profile updates are unavailable. Refresh the page and try again.");
        return;
      }
      const result = await updateUser({ name: trimmed });
      if (result.error) {
        setError(result.error.message ?? "Failed to update name.");
        return;
      }
      session.refetch?.();
      setSavedAt(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[settings] updateUser threw", message);
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;

  return (
    <section>
      <SectionHeading
        title="Identity"
        description="How you appear across Atlas. Your email is the immutable account anchor."
      />
      <form onSubmit={handleSave} className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-1.5">
          <Label htmlFor="profile-name">Display name</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Add a display name"
            maxLength={120}
            autoComplete="name"
          />
        </div>
        {/*
          Render email as a key/value pair, not a disabled `<Input>`. A
          greyed-out field with the address as a placeholder reads as
          "missing data" — but email is the immutable account anchor, not
          a field that's temporarily unavailable.
        */}
        <div className="space-y-1.5">
          <span className="block text-sm font-medium leading-none">Email</span>
          <p
            className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-foreground"
            aria-label="Email"
          >
            {user.email ?? "—"}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {savedAt != null && !error && (
          <p className="text-xs text-muted-foreground">Saved.</p>
        )}

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3.5" />
            )}
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}
