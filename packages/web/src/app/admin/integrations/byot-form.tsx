"use client";

/**
 * BYOT (bring-your-own-token) install modal. Slice 8 of 1.5.3 (#2746) lifted
 * the per-platform forms (`<SlackByotForm>`, `<TeamsByotForm>`,
 * `<DiscordByotForm>`) out of `page.tsx` and consolidated them here so the
 * unified catalog card flow exposes one mounting point for self-host
 * operators that haven't wired the platform's OAuth env vars.
 *
 * #4203 converged it onto the shared {@link FormDialog} primitive — the same
 * credential → validate → save spine its catalog-card siblings
 * (`FormInstallModal`, `StaticBotInstallModal`) already ride — so it's a modal
 * opened from the card's "Add token" affordance rather than an inline form,
 * and a fix to FormDialog's error surface reaches every install dialog at once.
 *
 * BYOT lives on the legacy `/api/v1/admin/integrations/:slug/byot`
 * endpoints because the catalog endpoint family (`/install`,
 * `/install-form`) only covers OAuth + form-installable rows today. The
 * spec keeps that backend split intact — the UI consolidation is the
 * deliverable.
 */

import { useMemo } from "react";
import { z } from "zod";
import {
  FormDialog,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull } from "@/ui/lib/fetch-error";

// ---------------------------------------------------------------------------
// Slug eligibility
// ---------------------------------------------------------------------------

/**
 * The chat slugs that today expose a BYOT path in addition to OAuth.
 *
 * Only Slack and Discord remain. Telegram, Teams, Google Chat, and
 * WhatsApp are static-bot platforms whose legacy credential-only connect
 * routes were removed in #2994 — they bypassed the chat-integration cap
 * (#2953) and never produced a runtime-routable install. Until the
 * unified ADR-0007 static-bot install (routing-identifier capture +
 * cap-gated `workspace_plugins` write) is wired, those cards render the
 * "not yet shipped" disabled Connect state, so they must NOT appear here.
 *
 * TODO(#2748): drop this list once the static-bot chat slugs route through
 * `/api/v1/integrations/:slug/install-form` — FormInstallModal will own the
 * rendering and BYOT_FIELDS becomes dead code.
 */
const BYOT_SLUGS = ["slack", "discord"] as const;
export type ByotEligibleSlug = (typeof BYOT_SLUGS)[number];

export function isByotEligibleSlug(slug: string): slug is ByotEligibleSlug {
  return (BYOT_SLUGS as readonly string[]).includes(slug);
}

// ---------------------------------------------------------------------------
// Field descriptors per slug
//
// Hard-coded here rather than driven from `entry.configSchema` because the
// legacy BYOT endpoint contracts predate the unified `configSchema` field —
// each takes a slug-specific JSON body shape.
//
// TODO(#2742): drop the descriptors when `/api/v1/integrations/:slug/install-form`
// covers BYOT; FormInstallModal will render from the catalog row's
// configSchema and this whole table becomes unused.
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

export interface ByotInstallModalProps {
  readonly slug: ByotEligibleSlug;
  /** Platform display name from the catalog row — used in the modal title. */
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSuccess: () => void;
}

export function ByotInstallModal({ slug, name, open, onOpenChange, onSuccess }: ByotInstallModalProps) {
  const fields = BYOT_FIELDS[slug];

  // Every BYOT field is required (the legacy endpoint rejects a partial body).
  // The schema is built dynamically from `BYOT_FIELDS[slug]`, so a static
  // `z.infer` isn't possible; the tuple annotation on `.map` keeps the entry
  // type concrete (no `any` leak through `Object.fromEntries`) and the single
  // `as` just pins the erased key set back to `Record<string, string>`.
  const schema = useMemo(
    () =>
      z.object(
        Object.fromEntries(
          fields.map((f): [string, z.ZodString] => [
            f.key,
            z.string().min(1, `${f.label} is required`),
          ]),
        ),
      ) as z.ZodType<Record<string, string>, Record<string, string>>,
    [fields],
  );
  const defaultValues = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.key, ""])) as Record<string, string>,
    [fields],
  );

  const mutation = useAdminMutation<{ message: string }>({
    path: `/api/v1/admin/integrations/${slug}/byot`,
    method: "POST",
  });

  async function handleSubmit(values: Record<string, string>): Promise<void> {
    const body: Record<string, string> = {};
    for (const f of fields) body[f.key] = (values[f.key] ?? "").trim();
    const result = await mutation.mutate({ body });
    if (!result.ok) {
      // Throw so FormDialog surfaces it as the shared root-level error banner.
      throw new Error(friendlyErrorOrNull(result.error) ?? `Couldn't connect ${name}`);
    }
    onSuccess();
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Connect ${name}`}
      description={`Paste the bot credentials for ${name}. They're encrypted at rest and used only to route this workspace's messages.`}
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel="Connect"
      saving={mutation.saving}
      className="max-w-md"
    >
      {(form) =>
        fields.map((f) => (
          <FormField
            key={f.key}
            control={form.control}
            name={f.key}
            render={({ field }) => (
              <FormItem>
                <FormLabel htmlFor={`${slug}-${f.key}`}>{f.label}</FormLabel>
                {f.helper ? <FormDescription>{f.helper}</FormDescription> : null}
                <FormControl>
                  <Input
                    id={`${slug}-${f.key}`}
                    type={f.type === "password" ? "password" : "text"}
                    placeholder={f.placeholder}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))
      }
    </FormDialog>
  );
}
