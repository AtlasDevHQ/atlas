"use client";

/**
 * BYOT (bring-your-own-token) inline form. Slice 8 of 1.5.3 (#2746) lifted
 * the per-platform forms (`<SlackByotForm>`, `<TeamsByotForm>`,
 * `<DiscordByotForm>`) out of `page.tsx` and consolidated them here so the
 * unified catalog card flow exposes one mounting point for self-host
 * operators that haven't wired the platform's OAuth env vars.
 *
 * BYOT lives on the legacy `/api/v1/admin/integrations/:slug/byot`
 * endpoints because the catalog endpoint family (`/install`,
 * `/install-form`) only covers OAuth + form-installable rows today. The
 * spec keeps that backend split intact — the UI consolidation is the
 * deliverable.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";

// ---------------------------------------------------------------------------
// Slug eligibility
// ---------------------------------------------------------------------------

/**
 * The three chat slugs that today expose a BYOT path in addition to OAuth.
 * Telegram is intentionally NOT in this list — Telegram installs through
 * the dedicated `/admin/integrations/telegram` POST endpoint with its own
 * field shape, and #2748 will move it onto the catalog form route once
 * the static-bot install handler ships server-side.
 */
const BYOT_SLUGS = ["slack", "teams", "discord"] as const;
export type ByotEligibleSlug = (typeof BYOT_SLUGS)[number];

export function isByotEligibleSlug(slug: string): slug is ByotEligibleSlug {
  return (BYOT_SLUGS as readonly string[]).includes(slug);
}

// ---------------------------------------------------------------------------
// Field descriptors per slug
//
// Hard-coded here rather than driven from `entry.configSchema` because the
// legacy BYOT endpoint contracts predate the unified `configSchema` field
// — each takes a slug-specific JSON body shape. When the catalog form route
// covers these slugs (post #2742 follow-ups), drop the descriptors and let
// FormInstallModal own the rendering.
// ---------------------------------------------------------------------------

interface ByotField {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "password";
  readonly placeholder?: string;
  readonly helper?: React.ReactNode;
}

const BYOT_FIELDS: Record<ByotEligibleSlug, readonly ByotField[]> = {
  slack: [
    {
      key: "botToken",
      label: "Bot token",
      type: "password",
      placeholder: "xoxb-...",
      helper: (
        <>
          Create a{" "}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Slack app
          </a>{" "}
          and copy the Bot User OAuth Token.
        </>
      ),
    },
  ],
  teams: [
    {
      key: "appId",
      label: "App ID",
      type: "text",
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      helper: (
        <>
          Create an{" "}
          <a
            href="https://dev.botframework.com/bots/new"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Azure Bot
          </a>{" "}
          and copy the App ID (client_id).
        </>
      ),
    },
    {
      key: "appPassword",
      label: "App password",
      type: "password",
      placeholder: "App password (client_secret)",
    },
  ],
  discord: [
    {
      key: "botToken",
      label: "Bot token",
      type: "password",
      placeholder: "Bot token",
      helper: (
        <>
          Create a{" "}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Discord application
          </a>{" "}
          and copy the bot token.
        </>
      ),
    },
    {
      key: "applicationId",
      label: "Application ID",
      type: "text",
      placeholder: "Application ID",
    },
    {
      key: "publicKey",
      label: "Public key",
      type: "text",
      placeholder: "Public key (for interaction verification)",
    },
  ],
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ByotFormProps {
  readonly slug: ByotEligibleSlug;
  readonly onSuccess: () => void;
  /** Pushed up so the parent Shell can render the inline destructive strip. */
  readonly onError: (message: string) => void;
}

export function ByotForm({ slug, onSuccess, onError }: ByotFormProps) {
  const fields = BYOT_FIELDS[slug];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ""])),
  );

  const mutation = useAdminMutation<{ message: string }>({
    path: `/api/v1/admin/integrations/${slug}/byot`,
    method: "POST",
  });

  const allFilled = fields.every((f) => values[f.key]?.trim().length > 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!allFilled) return;
    const body: Record<string, string> = {};
    for (const f of fields) body[f.key] = values[f.key]!.trim();
    const result = await mutation.mutate({ body });
    if (result.ok) {
      onSuccess();
    } else {
      onError(friendlyErrorOrNull(result.error) ?? `Couldn't connect ${slug}`);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3"
      data-testid={`catalog-card-${slug}-byot-form`}
    >
      {fields.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <label htmlFor={`${slug}-${f.key}`} className="text-sm font-medium">
            {f.label}
          </label>
          {f.helper && <p className="text-xs text-muted-foreground">{f.helper}</p>}
          <Input
            id={`${slug}-${f.key}`}
            type={f.type === "password" ? "password" : "text"}
            placeholder={f.placeholder}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            disabled={mutation.saving}
          />
        </div>
      ))}
      <Button type="submit" size="sm" disabled={mutation.saving || !allFilled}>
        {mutation.saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
        Connect
      </Button>
    </form>
  );
}
