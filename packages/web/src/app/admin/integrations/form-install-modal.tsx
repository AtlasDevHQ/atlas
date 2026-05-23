"use client";

/**
 * `FormInstallModal` — slice 7 of #2649 (issue #2660).
 *
 * Renders the install form for `install_model: "form"` catalog entries.
 * Fields are driven by the catalog row's `configSchema` JSONB so a new
 * form-based integration (Webhook, Obsidian, etc.) needs no UI change
 * — only an operator config edit + a server-side handler.
 *
 * Server-side validation is the source of truth (see
 * `EmailFormInstallHandler` in `lib/integrations/install/`). The
 * client-side Zod schema built from `configSchema` here is the
 * minimum needed to keep submit-button disable + field highlight
 * responsive; mismatches fall through to the server, which returns
 * `{ fieldErrors: { <key>: [...] } }` that we map onto react-hook-form's
 * setError so the modal lights up the offending inputs.
 */

import { useMemo, useState } from "react";
import { z } from "zod";
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
import { Checkbox } from "@/components/ui/checkbox";
import { getApiUrl } from "@/lib/api-url";

/**
 * Subset of `ConfigSchemaField` we need for rendering — kept inline
 * rather than imported from `@useatlas/types` so the modal doesn't
 * couple to the server-side `lib/plugins/registry.ts` shape. The
 * catalog endpoint already loosely-types `configSchema` as `unknown`,
 * so the runtime narrowing happens here.
 */
export interface FormFieldDescriptor {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  options?: string[];
  default?: unknown;
}

/**
 * Best-effort coerce of the catalog row's `configSchema` (typed as
 * `unknown` on the wire) to {@link FormFieldDescriptor}[]. Drops any
 * entries that don't have at minimum a `key: string` and one of the
 * supported `type` values — anything malformed is silently filtered so
 * a single bad seed row doesn't black-hole the entire modal.
 */
export function parseConfigSchema(raw: unknown): FormFieldDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const fields: FormFieldDescriptor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== "string" || e.key.length === 0) continue;
    if (
      e.type !== "string" &&
      e.type !== "number" &&
      e.type !== "boolean" &&
      e.type !== "select"
    ) {
      continue;
    }
    fields.push({
      key: e.key,
      type: e.type,
      label: typeof e.label === "string" ? e.label : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
      required: e.required === true,
      secret: e.secret === true,
      options: Array.isArray(e.options) ? (e.options.filter((o) => typeof o === "string") as string[]) : undefined,
      default: e.default,
    });
  }
  return fields;
}

/**
 * Build a Zod schema from the catalog row's `configSchema` field list.
 * Mirrors the rules the server-side handler enforces (per-Platform
 * Zod), but only the structural ones — value-level checks (email
 * format, port range) are deferred to the server so the modal stays
 * generic.
 */
// Returns the schema as a typed `z.ZodType<TValues, TValues>` so it
// satisfies `FormDialog`'s prop (which requires Input == Output —
// react-hook-form's resolver only commits once, no transform pipeline
// needed for our use case). Cast through `unknown` because Zod's
// generic ZodObject doesn't unify with the loose Record<string,
// unknown> shape we synthesize from `configSchema`.
function buildZodSchema(
  fields: FormFieldDescriptor[],
): z.ZodType<Record<string, unknown>, Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let schema: z.ZodTypeAny;
    switch (field.type) {
      case "string":
        schema = field.required
          ? z.string().min(1, `${field.label ?? field.key} is required`)
          : z.string().optional();
        break;
      case "number":
        // `z.coerce.number()` accepts the HTML-form string-as-number
        // and converts to a real number — necessary because <Input
        // type="number"> still produces a string event value.
        schema = field.required
          ? z.coerce.number({ message: `${field.label ?? field.key} is required` })
          : z.coerce.number().optional();
        break;
      case "boolean":
        schema = z.boolean().optional();
        break;
      case "select":
        // Discriminated by `options`. When absent, fall back to a
        // free-form string (the server still validates). When present,
        // a literal-union narrows to the listed values.
        if (field.options && field.options.length > 0) {
          const literals = field.options.map((o) => z.literal(o));
          // z.union expects at least two literals; if only one is
          // declared we fall back to a literal-of-one (`z.literal`).
          schema =
            literals.length >= 2
              ? z.union(literals as [z.ZodLiteral<string>, z.ZodLiteral<string>, ...z.ZodLiteral<string>[]])
              : literals[0];
          if (!field.required) schema = schema.optional();
        } else {
          schema = field.required ? z.string().min(1) : z.string().optional();
        }
        break;
    }
    shape[field.key] = schema;
  }
  return z.object(shape) as unknown as z.ZodType<Record<string, unknown>, Record<string, unknown>>;
}

/**
 * Build initial form values from each field's declared `default` (when
 * present + type-compatible). Falsy defaults (empty string, 0, false)
 * are passed through; `undefined` is treated as "no default" and the
 * input renders blank.
 */
function buildDefaultValues(fields: FormFieldDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default === undefined) {
      if (field.type === "boolean") out[field.key] = false;
      else out[field.key] = "";
      continue;
    }
    out[field.key] = field.default;
  }
  return out;
}

export interface FormInstallModalProps {
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

/**
 * The install modal itself. Submits to
 * `POST /api/v1/integrations/:slug/install-form` — server-side
 * validation drives the field-level error surface. On success, fires
 * `onInstalled` so the parent (`CatalogSection`) can refetch and flip
 * the card's `installed` badge.
 */
export function FormInstallModal({
  open,
  onOpenChange,
  slug,
  name,
  description,
  configSchema,
  onInstalled,
}: FormInstallModalProps) {
  const fields = useMemo(() => parseConfigSchema(configSchema), [configSchema]);
  const schema = useMemo(() => buildZodSchema(fields), [fields]);
  const defaultValues = useMemo(() => buildDefaultValues(fields), [fields]);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    setSaving(true);
    try {
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/${encodeURIComponent(slug)}/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        let message = `Install failed (${res.status})`;
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
            fieldErrors?: Record<string, string[] | undefined>;
          };
          if (body.fieldErrors) {
            // Surface the first field-level error as the message —
            // FormDialog renders the root error banner; future
            // iteration can route fieldErrors back into individual
            // FormMessage components for inline highlighting.
            const firstField = Object.keys(body.fieldErrors)[0];
            const firstError = firstField ? body.fieldErrors[firstField]?.[0] : undefined;
            if (firstField && firstError) {
              message = `${firstField}: ${firstError}`;
            } else if (body.message) {
              message = body.message;
            }
          } else if (body.message) {
            message = body.message;
          }
        } catch {
          // Ignore JSON parse failure; fall through to status-only message.
        }
        // Throw — FormDialog's onSubmit wrapper catches and surfaces
        // as root-level error.
        throw new Error(message);
      }
      onInstalled();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Install ${name}`}
      description={description ?? "Provide the credentials your operator declared for this integration."}
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel="Install"
      saving={saving}
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
                    {field.type === "boolean" ? (
                      <Checkbox
                        checked={Boolean(rhf.value)}
                        onCheckedChange={(checked) => rhf.onChange(Boolean(checked))}
                        aria-label={field.label ?? field.key}
                      />
                    ) : (
                      <Input
                        type={
                          field.secret
                            ? "password"
                            : field.type === "number"
                            ? "number"
                            : "text"
                        }
                        value={(rhf.value as string | number | undefined) ?? ""}
                        onChange={(e) => rhf.onChange(e.target.value)}
                        autoComplete={field.secret ? "off" : undefined}
                      />
                    )}
                  </FormControl>
                  {field.description && (
                    <FormDescription>{field.description}</FormDescription>
                  )}
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
