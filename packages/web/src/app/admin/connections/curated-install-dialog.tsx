"use client";

import { toast } from "sonner";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import {
  FormDialog,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/form-dialog";
import { getApiUrl } from "@/lib/api-url";
import { installFormErrorMessage } from "./install-form-error";

/* ────────────────────────────────────────────────────────────────────────
 *  Curated REST datasource install — the one-credential form for a built-in
 *  "data candidate" (Stripe, Notion, …). The spec URL + auth kind are
 *  pre-wired server-side; the admin only pastes the secret. POSTs the slim
 *  `{ auth_value, display_name? }` body to the candidate's `install-form`
 *  handler (mirrors {@link DataCandidateFormDataSchema} on the API).
 *
 *  Rides the shared {@link FormDialog} primitive (arch-win #91 / #4203) — the
 *  same credential → validate → save spine as `FormInstallModal`,
 *  `RestInstallDialog`, and `ByotInstallModal` — so a fix to FormDialog's
 *  error-surface / reset behavior reaches every install dialog at once.
 * ──────────────────────────────────────────────────────────────────────── */

export interface CuratedCandidate {
  slug: string;
  name: string;
  description: string | null;
}

/** Per-vendor copy for the single credential field. Falls back to a generic
 *  label for any candidate not enumerated here. */
const SECRET_FIELD: Record<string, { label: string; placeholder: string; help: string }> = {
  "stripe-data": {
    label: "Stripe secret key",
    placeholder: "sk_live_…",
    help: "Find it in Stripe Dashboard → Developers → API keys. Used read-only; encrypted at rest.",
  },
  "notion-data": {
    label: "Notion integration token",
    placeholder: "ntn_…",
    help: "Create an internal integration at notion.so/my-integrations and share the pages you want Atlas to read.",
  },
};

// `CuratedFormValues` is derived from the schema (`z.infer`) so the schema is
// the single source of truth — a field can't drift between the two.
const curatedSchema = z.object({
  auth_value: z.string().min(1, "Credential is required"),
  display_name: z.string(),
});
type CuratedFormValues = z.infer<typeof curatedSchema>;

/** A fresh empty form for every open; the reset itself is FormDialog's job
 *  (keyed on `[open, resetKey]`), so a plain constant is enough here. */
const CURATED_DEFAULTS: CuratedFormValues = { auth_value: "", display_name: "" };

export function CuratedInstallDialog({
  candidate,
  open,
  onOpenChange,
  onInstalled,
}: {
  candidate: CuratedCandidate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const field = candidate
    ? (SECRET_FIELD[candidate.slug] ?? {
        label: "API key / token",
        placeholder: "",
        help: "Used read-only; encrypted at rest.",
      })
    : null;

  async function handleSubmit(values: CuratedFormValues): Promise<void> {
    // Unreachable — FormDialog only mounts when `candidate` is non-null (see the
    // early return below) — but make the impossible state loud rather than
    // resolving as a phantom success if a future refactor makes it reachable.
    if (!candidate) throw new Error("No datasource candidate selected");
    const body: Record<string, unknown> = { auth_value: values.auth_value };
    if (values.display_name.trim()) body.display_name = values.display_name.trim();

    const res = await fetch(
      `${getApiUrl()}/api/v1/integrations/${encodeURIComponent(candidate.slug)}/install-form`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      // Throw so FormDialog's onSubmit wrapper surfaces it as the shared
      // root-level error banner (the reset-on-open effect keyed on
      // `[open, resetKey]` still wipes the pasted secret on the next open).
      throw new Error(await installFormErrorMessage(res));
    }
    toast.success(`${candidate.name} connected`);
    onInstalled();
  }

  if (!candidate || !field) return null;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      // Keyed on the vendor slug so switching candidates while the dialog stays
      // open re-fires the reset — a pasted `sk_live_…` never bleeds into the
      // next vendor's install (regression-guarded in the sibling test).
      resetKey={candidate.slug}
      title={`Connect ${candidate.name}`}
      description={
        candidate.description ??
        `Query ${candidate.name} as a read-only REST datasource. The spec is pre-wired — just paste your credential.`
      }
      schema={curatedSchema}
      defaultValues={CURATED_DEFAULTS}
      onSubmit={handleSubmit}
      submitLabel="Connect"
      submitTestId="curated-install-submit"
      className="max-w-md"
    >
      {(form) => (
        <>
          <FormField
            control={form.control}
            name="auth_value"
            render={({ field: rhf }) => (
              <FormItem>
                <FormLabel>{field.label}</FormLabel>
                <FormControl>
                  <Input
                    id="curated-auth-value"
                    type="password"
                    placeholder={field.placeholder}
                    data-testid="curated-auth-value"
                    autoFocus
                    {...rhf}
                  />
                </FormControl>
                <FormDescription>{field.help}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="display_name"
            render={({ field: rhf }) => (
              <FormItem>
                <FormLabel>Display name (optional)</FormLabel>
                <FormControl>
                  <Input id="curated-display-name" placeholder={candidate.name} {...rhf} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
    </FormDialog>
  );
}
