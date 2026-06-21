"use client";

/**
 * `FormInstallModal` — renders the install form for
 * `install_model: "form"` catalog entries. Fields are driven by the
 * catalog row's `configSchema` JSONB so a new form-based integration
 * (Webhook, Obsidian per #2661) needs no UI change — only an operator
 * config edit + a server-side handler.
 *
 * Server-side validation is the source of truth (the per-Platform
 * handler under `lib/integrations/install/`). The client-side Zod
 * schema built from `configSchema` here is the minimum needed to keep
 * the submit button responsive; mismatches fall through to the server,
 * which returns `{ fieldErrors, formErrors }`. The modal surfaces the
 * first field error as a root-level error message — per-field
 * inline highlighting via `form.setError` is a follow-up.
 */

import { useMemo, useState } from "react";
import { z } from "zod";
import { FormDialog } from "@/components/form-dialog";
import { getApiUrl } from "@/lib/api-url";
import { ConfigSchemaFields } from "./config-schema-fields";

/**
 * Subset of `ConfigSchemaField` we need for rendering — kept inline
 * rather than imported from `@useatlas/types` so the modal doesn't
 * couple to the server-side `lib/plugins/registry.ts` shape. The
 * catalog endpoint already loosely-types `configSchema` as `unknown`,
 * so the runtime narrowing happens here.
 */
/** A normalized `{ value, label }` option for a select field. */
export interface FormSelectOption {
  value: string;
  label: string;
}

/** Conditional-visibility rule: show the field only when `field`'s value is in `equals`. */
export interface FormShowWhen {
  field: string;
  equals: string[];
}

export interface FormFieldDescriptor {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  /** Normalized to `{ value, label }` pairs by {@link parseConfigSchema}. */
  options?: FormSelectOption[];
  default?: unknown;
  /** Progressive disclosure: only render when the controlling field matches. */
  showWhen?: FormShowWhen;
}

/**
 * True when `field` should be visible given the current form `values` —
 * i.e. it has no `showWhen` gate, or its controlling field's current value is
 * one of the gate's `equals`.
 */
export function isFieldVisible(
  field: FormFieldDescriptor,
  values: Record<string, unknown>,
): boolean {
  if (!field.showWhen) return true;
  const current = values[field.showWhen.field];
  return field.showWhen.equals.includes(typeof current === "string" ? current : String(current ?? ""));
}

/**
 * Best-effort coerce of the catalog row's `configSchema` (typed as
 * `unknown` on the wire) to {@link FormFieldDescriptor}[]. Drops
 * entries that lack `key: string` or a supported `type` so a single
 * malformed seed row doesn't black-hole the entire modal — but emits
 * `console.warn` for each drop, with the offending payload, so the
 * operator can see in the browser console why an expected field is
 * missing from the form.
 */
export function parseConfigSchema(raw: unknown): FormFieldDescriptor[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn("[FormInstallModal] configSchema is not an array — rendering empty form", { raw });
    return [];
  }
  const fields: FormFieldDescriptor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      console.warn("[FormInstallModal] dropping non-object configSchema entry", { entry });
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== "string" || e.key.length === 0) {
      console.warn("[FormInstallModal] dropping configSchema entry without a string `key`", { entry });
      continue;
    }
    if (
      e.type !== "string" &&
      e.type !== "number" &&
      e.type !== "boolean" &&
      e.type !== "select"
    ) {
      console.warn("[FormInstallModal] dropping configSchema entry with unknown `type`", {
        key: e.key,
        type: e.type,
      });
      continue;
    }
    let options: FormSelectOption[] | undefined;
    if (Array.isArray(e.options)) {
      const normalized: FormSelectOption[] = [];
      for (const o of e.options) {
        if (typeof o === "string") {
          normalized.push({ value: o, label: o });
        } else if (
          o &&
          typeof o === "object" &&
          typeof (o as Record<string, unknown>).value === "string"
        ) {
          const obj = o as Record<string, unknown>;
          normalized.push({
            value: obj.value as string,
            label: typeof obj.label === "string" ? obj.label : (obj.value as string),
          });
        } else {
          console.warn("[FormInstallModal] dropping malformed configSchema `options` entry", {
            key: e.key,
            option: o,
          });
        }
      }
      options = normalized;
    }
    let showWhen: FormShowWhen | undefined;
    if (e.showWhen && typeof e.showWhen === "object") {
      const sw = e.showWhen as Record<string, unknown>;
      if (
        typeof sw.field === "string" &&
        Array.isArray(sw.equals) &&
        sw.equals.every((v) => typeof v === "string")
      ) {
        showWhen = { field: sw.field, equals: sw.equals as string[] };
      } else {
        console.warn("[FormInstallModal] dropping malformed configSchema `showWhen`", {
          key: e.key,
          showWhen: e.showWhen,
        });
      }
    }
    fields.push({
      key: e.key,
      type: e.type,
      label: typeof e.label === "string" ? e.label : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
      required: e.required === true,
      secret: e.secret === true,
      options,
      default: e.default,
      showWhen,
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
// Exported so the static-bot install modal (#3140) builds its form schema
// from the same `configSchema` rules without duplicating them.
export function buildZodSchema(
  fields: FormFieldDescriptor[],
): z.ZodType<Record<string, unknown>, Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    // A `showWhen`-gated field is only required when visible, so it is always
    // OPTIONAL at the base level (a hidden, empty field must never block submit);
    // the required-when-visible rule is enforced by the superRefine below.
    const baseRequired = field.required === true && !field.showWhen;
    let schema: z.ZodTypeAny;
    switch (field.type) {
      case "string":
        schema = baseRequired
          ? z.string().min(1, `${field.label ?? field.key} is required`)
          : z.string().optional();
        break;
      case "number":
        // `z.coerce.number()` accepts the HTML-form string-as-number
        // and converts to a real number — necessary because <Input
        // type="number"> still produces a string event value.
        //
        // On the optional/gated branch a blank input must map to `undefined`
        // BEFORE coercion: `Number("") === 0`, so a plain `z.coerce.number()`
        // would silently turn a left-blank `showWhen`-gated required number into
        // 0 and slip past the superRefine's empty-check. Mapping "" → undefined
        // lets that conditional-required rule fire as intended.
        schema = baseRequired
          ? z.coerce.number({ message: `${field.label ?? field.key} is required` })
          : z.union([z.literal("").transform(() => undefined), z.coerce.number()]).optional();
        break;
      case "boolean":
        schema = z.boolean().optional();
        break;
      case "select":
        // Discriminated by `options`. When absent, fall back to a
        // free-form string (the server still validates). When present,
        // a literal-union narrows to the listed values.
        if (field.options && field.options.length > 0) {
          const literals = field.options.map((o) => z.literal(o.value));
          // z.union expects at least two literals; if only one is
          // declared we fall back to a literal-of-one (`z.literal`).
          schema =
            literals.length >= 2
              ? z.union(literals as [z.ZodLiteral<string>, z.ZodLiteral<string>, ...z.ZodLiteral<string>[]])
              : literals[0];
          if (!baseRequired) schema = schema.optional();
        } else {
          schema = baseRequired ? z.string().min(1) : z.string().optional();
        }
        break;
    }
    shape[field.key] = schema;
  }
  // Conditional-required: a `showWhen` field marked `required` must be present
  // only while it is visible (its controlling field's value satisfies the gate).
  const gatedRequired = fields.filter((f) => f.required === true && f.showWhen);
  const schema = z.object(shape).superRefine((values, ctx) => {
    for (const field of gatedRequired) {
      if (!isFieldVisible(field, values as Record<string, unknown>)) continue;
      const v = (values as Record<string, unknown>)[field.key];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field.key],
          message: `${field.label ?? field.key} is required`,
        });
      }
    }
  });
  return schema as unknown as z.ZodType<Record<string, unknown>, Record<string, unknown>>;
}

/**
 * Build initial form values from each field's declared `default` (when
 * present + type-compatible). Falsy defaults (empty string, 0, false)
 * are passed through; `undefined` is treated as "no default" and the
 * input renders blank.
 */
// Exported so the static-bot install modal (#3140) seeds its form from the
// same `configSchema` defaults.
export function buildDefaultValues(fields: FormFieldDescriptor[]): Record<string, unknown> {
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

/**
 * Build the config payload to POST: drop fields hidden by `showWhen` (so a stale
 * value from a previously-selected branch never leaks) and drop empty strings (so
 * an unfilled optional field arrives as absent, not `""` — the server's per-field
 * `.min(1)` validators reject empty strings). Booleans and numbers pass through.
 */
export function buildSubmitPayload(
  fields: FormFieldDescriptor[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isFieldVisible(field, values)) continue;
    const v = values[field.key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[field.key] = v;
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
      const payload = buildSubmitPayload(fields, values);
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/${encodeURIComponent(slug)}/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = `Install failed (${res.status})`;
        let requestId: string | undefined;
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
            requestId?: string;
            fieldErrors?: Record<string, string[] | undefined>;
            formErrors?: string[];
          };
          requestId = body.requestId;
          if (body.fieldErrors && Object.keys(body.fieldErrors).length > 0) {
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
          } else if (body.formErrors && body.formErrors.length > 0) {
            message = body.formErrors[0];
          } else if (body.message) {
            message = body.message;
          }
        } catch {
          // intentionally ignored: a non-JSON response body just
          // means we fall through to the status-only message.
        }
        // Append the requestId tail so an admin can quote it to
        // support when chasing a 5xx in the logs. Trim to a short
        // prefix — the full UUID is in the JSON body for clients
        // that want the lot.
        if (requestId) {
          message = `${message} (ref: ${requestId.slice(0, 8)})`;
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
      {(form) => <ConfigSchemaFields fields={fields} control={form.control} />}
    </FormDialog>
  );
}
