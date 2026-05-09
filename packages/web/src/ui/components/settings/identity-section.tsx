"use client";

/**
 * `/settings/profile` → Identity section.
 *
 * Read + edit the signed-in user's display name. Email is intentionally
 * read-only — Atlas is B2B; email is the org-managed account anchor (often
 * SSO / SCIM-provisioned, always the audit trail key). Letting end-users
 * mutate their own email is a consumer pattern that breaks org provisioning
 * and forensic queries. If a workspace genuinely needs an email rotation it
 * goes through admin tooling, not self-service.
 *
 * Name persistence goes through Better Auth's `authClient.updateUser({ name })`
 * — same path the admin user-edit flow uses; the session refetches automatically
 * after success so the avatar dropdown picks up the new name without a reload.
 */

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeading } from "@/ui/components/admin/compact";

interface UpdateUserResult {
  data?: unknown;
  error?: { message?: string } | null;
}

export function IdentitySection() {
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; name?: string }
    | undefined;

  const [name, setName] = useState<string>(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync local input with session state on first load + remote updates
  // (e.g. switching org refetches the session).
  useEffect(() => {
    if (user?.name != null && !saving) {
      setName(user.name);
    }
  }, [user?.name, saving]);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== (user?.name ?? "").trim();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;

    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      // `updateUser` is part of Better Auth's core React client surface but
      // isn't on the duck-typed AtlasAuthClient interface. Cast through the
      // narrow shape we actually call with.
      const updateUser = (authClient as unknown as {
        updateUser: (opts: { name: string }) => Promise<UpdateUserResult>;
      }).updateUser;

      const result = await updateUser({ name: trimmed });
      if (result.error) {
        setError(result.error.message ?? "Failed to update name.");
        return;
      }
      session.refetch?.();
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a display name"
            maxLength={120}
            autoComplete="name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-email">Email</Label>
          <Input
            id="profile-email"
            value={user.email ?? ""}
            disabled
            readOnly
            className="text-muted-foreground"
          />
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
