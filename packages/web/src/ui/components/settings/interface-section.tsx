"use client";

/**
 * Self-hosted-local deployments don't expose this section: the underlying
 * column lives on Better Auth's `user` table and is in
 * MANAGED_AUTH_MIGRATIONS, so the GET endpoint 404s. The section gates on
 * that 404 instead of rendering an unwritable form.
 */

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import type { DefaultLanding, UserPreferences } from "@useatlas/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SectionHeading } from "@/ui/components/admin/compact";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";

interface InterfaceSectionProps {
  /** Whether the caller is admin/owner/platform-admin. The `admin` radio is
   *  hidden for everyone else — the backend rejects the write on that path
   *  too, so the option would just produce a 403. */
  isAdmin: boolean;
}

export function InterfaceSection({ isAdmin }: InterfaceSectionProps) {
  const { data, loading, error, refetch } = useAdminFetch<UserPreferences>(
    "/api/v1/me/preferences",
  );

  const [selected, setSelected] = useState<DefaultLanding | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data && selected == null) setSelected(data.defaultLanding);
  }, [data, selected]);

  const { mutate, saving, error: saveError } = useAdminMutation<UserPreferences>({
    path: "/api/v1/me/preferences",
    method: "PATCH",
    invalidates: refetch,
  });

  // 404 means the preference column doesn't exist (non-managed auth or
  // missing internal DB). Omit the section entirely — there's nothing the
  // user can do here, and an error banner would only confuse self-hosted
  // operators evaluating Atlas in local mode.
  if (error?.status === 404) return null;

  const current = data?.defaultLanding ?? "chat";
  const value = selected ?? current;
  const dirty = !loading && value !== current;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving || selected == null) return;
    setSavedAt(null);
    const result = await mutate({ body: { defaultLanding: selected } });
    if (result.ok) setSavedAt(Date.now());
  }

  return (
    <section>
      <SectionHeading
        title="Interface"
        description="Where you land when you open Atlas. Chat is the default; flip to Admin if the console is your day-to-day surface."
      />
      <form
        onSubmit={handleSave}
        className="space-y-4 rounded-lg border bg-card p-4"
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
            Loading preferences...
          </p>
        ) : (
          <RadioGroup
            value={value}
            onValueChange={(v) => {
              setSelected(v as DefaultLanding);
              if (savedAt != null) setSavedAt(null);
            }}
            aria-label="Default landing"
            className="gap-2"
          >
            <Label
              htmlFor="default-landing-chat"
              className="flex cursor-pointer items-start gap-3 rounded-md border bg-background p-3 hover:bg-accent/40"
            >
              <RadioGroupItem value="chat" id="default-landing-chat" className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">Chat</span>
                <span className="block text-xs text-muted-foreground">
                  Open Atlas to a fresh chat. Recommended for asking your data questions.
                </span>
              </span>
            </Label>
            {isAdmin && (
              <Label
                htmlFor="default-landing-admin"
                className="flex cursor-pointer items-start gap-3 rounded-md border bg-background p-3 hover:bg-accent/40"
              >
                <RadioGroupItem value="admin" id="default-landing-admin" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">Admin</span>
                  <span className="block text-xs text-muted-foreground">
                    Open Atlas to the admin console. Useful if managing the workspace is your day-to-day work.
                  </span>
                </span>
              </Label>
            )}
          </RadioGroup>
        )}

        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {friendlyError(saveError)}
          </p>
        )}
        {savedAt != null && !saveError && (
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
