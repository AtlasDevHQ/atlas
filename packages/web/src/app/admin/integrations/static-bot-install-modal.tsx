"use client";

/**
 * `StaticBotInstallModal` — captures a static-bot platform's routing
 * identifier (#3140 — the install spine for Telegram / Teams / Google Chat /
 * WhatsApp). Static-bot platforms are operator-shared (one bot per platform
 * via env-var tokens); each workspace supplies a routing identifier (Telegram
 * `chat_id`, Teams `tenant_id`, …) persisted to `workspace_plugins.config`,
 * which the chat runtime reads at message time.
 *
 * The form is driven by the catalog row's `configSchema` JSONB — identical to
 * {@link FormInstallModal} — so a new static-bot platform needs no UI change,
 * only a catalog row + a registered handler. The routing identifier is the
 * first `required` field; the server resolves which field that is and runs the
 * chat-integration cap gate inside `confirmInstall`. Submits through
 * {@link useAdminMutation} (never a hand-rolled fetch) to
 * `POST /api/v1/integrations/:slug/install-form`, which the API route accepts
 * for `install_model: "static-bot"`.
 *
 * Server-side validation is the source of truth: a malformed routing id, an
 * over-cap workspace (429), or an unreachable platform (502) surfaces as the
 * mutation error, rendered as the dialog's root error banner.
 */

import { useMemo, useState } from "react";
import {
  FormDialog,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import {
  buildDefaultValues,
  buildZodSchema,
  parseConfigSchema,
} from "./form-install-modal";

export interface StaticBotInstallModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Catalog slug — used in the POST URL and surfaced in error toasts. */
  slug: string;
  /** Display name from the catalog row. */
  name: string;
  description?: string | null;
  /** The catalog row's `configSchema` JSONB — drives the rendered fields. */
  configSchema: unknown;
  /** Fired after a successful install so the parent can refetch the catalog list. */
  onInstalled: () => void;
}

/** Response shape from `POST /:slug/install-form` on success. */
interface InstallFormResponse {
  installed: boolean;
  platform: string;
  installId: string;
}

export function StaticBotInstallModal({
  open,
  onOpenChange,
  slug,
  name,
  description,
  configSchema,
  onInstalled,
}: StaticBotInstallModalProps) {
  const fields = useMemo(() => parseConfigSchema(configSchema), [configSchema]);
  const schema = useMemo(() => buildZodSchema(fields), [fields]);
  const defaultValues = useMemo(() => buildDefaultValues(fields), [fields]);
  const [submitting, setSubmitting] = useState(false);

  const { mutate, saving } = useAdminMutation<InstallFormResponse>({
    path: `/api/v1/integrations/${encodeURIComponent(slug)}/install-form`,
    method: "POST",
  });

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    setSubmitting(true);
    try {
      const result = await mutate({ body: values });
      if (!result.ok) {
        // Surface the structured FetchError as the dialog's root error
        // (FormDialog's onSubmit wrapper catches the throw). `friendlyError`
        // already folds the cap (429), upgrade (403), and upstream (502)
        // messages into actionable copy with the requestId tail.
        throw new Error(friendlyError(result.error));
      }
      onInstalled();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Install ${name}`}
      description={
        description ??
        "Enter the routing identifier so the shared bot knows which workspace to route messages to."
      }
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel="Install"
      saving={saving || submitting}
    >
      {(form) => (
        <>
          {fields.map((field) => (
            <FormField
              key={field.key}
              control={form.control}
              name={field.key}
              render={({ field: rhf }) => (
                <FormItem>
                  <FormLabel>
                    {field.label ?? field.key}
                    {field.required && <span className="ml-1 text-destructive">*</span>}
                  </FormLabel>
                  <FormControl>
                    <Input
                      // Static-bot config fields are routing identifiers + labels —
                      // all strings. Secret-marked fields (none today) still mask.
                      type={field.secret ? "password" : "text"}
                      value={(rhf.value as string | undefined) ?? ""}
                      onChange={(e) => rhf.onChange(e.target.value)}
                      autoComplete={field.secret ? "off" : undefined}
                    />
                  </FormControl>
                  {field.description && <FormDescription>{field.description}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
        </>
      )}
    </FormDialog>
  );
}
