"use client";

import { z } from "zod";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription as FormDesc,
} from "@/components/form-dialog";
import { ENV_SENTINEL_CREATE } from "./generate-prompt";

// Mirrors the backend GROUP_NAME_PATTERN in `lib/db/connection-groups-helpers.ts`.
// Inlined (rather than imported) so the web bundle doesn't pull from
// `@atlas/api` — see "Frontend is a pure HTTP client" in CLAUDE.md. A drift here
// surfaces in tests because the API returns a 400 with the same message.
const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

// `ENV_SENTINEL_NONE` / `ENV_SENTINEL_CREATE` (the Environment combobox
// sentinels) live in ./generate-prompt — shared with the new-group detection
// for the inline "Generate semantic layer" prompt (#3237) so there's one
// source of truth.

const envSelectionSchema = z.string();

export const connectionCreateSchema = z
  .object({
    id: z
      .string()
      .min(1, "Connection ID is required")
      .regex(/^[a-z][a-z0-9_-]*$/, "Lowercase letters, numbers, hyphens, underscores. Must start with a letter."),
    dbType: z.string().min(1, "Database type is required"),
    url: z.string().min(1, "Connection URL is required"),
    schema: z.string(),
    description: z.string(),
    envSelection: envSelectionSchema,
    newGroupName: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.envSelection === ENV_SENTINEL_CREATE) {
      const trimmed = data.newGroupName.trim();
      if (!trimmed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newGroupName"],
          message: "Environment name is required.",
        });
      } else if (!ENV_NAME_PATTERN.test(trimmed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newGroupName"],
          message: "Letters, digits, spaces, hyphens, or underscores (max 64 chars). Must start with a letter or digit.",
        });
      }
    }
  });

export const connectionEditSchema = z
  .object({
    id: z.string(),
    dbType: z.string(),
    url: z.string(), // empty string is valid on edit — empty means keep current URL
    schema: z.string(),
    description: z.string(),
    envSelection: envSelectionSchema,
    newGroupName: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.envSelection === ENV_SENTINEL_CREATE) {
      const trimmed = data.newGroupName.trim();
      if (!trimmed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newGroupName"],
          message: "Environment name is required.",
        });
      } else if (!ENV_NAME_PATTERN.test(trimmed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newGroupName"],
          message: "Letters, digits, spaces, hyphens, or underscores (max 64 chars). Must start with a letter or digit.",
        });
      }
    }
  });

/**
 * Form value shape for the Add/Edit Connection dialog, derived from the create
 * schema so the schema stays the single source of truth — there's no
 * hand-maintained mirror that can silently drift. `connectionEditSchema` infers
 * the same shape; `ConnectionFormDialog` pins both to this type (page.tsx) so
 * the form carries one value type rather than a `Create | Edit` union.
 */
export type ConnectionFormValues = z.infer<typeof connectionCreateSchema>;

/**
 * Why these three slivers live in their own components instead of inline in
 * `ConnectionFormDialog`'s render props (#3846):
 *
 * `FormDialog` invokes the caller's `children(form)` / `extraFooter?.(form)`
 * render-prop callbacks. Under React Compiler (`reactCompiler: true`) those
 * calls are memoized on their stable inputs — the `form` object and the
 * callback identity are both referentially stable across the re-renders that
 * `form.watch(...)` triggers — so the compiler never re-invokes the render prop
 * and the `form.watch(...)` read inside that memoized subtree never re-runs.
 * (`watch` itself isn't broken — its subscription fires, but the value can't
 * reach a render of the memoized output that never happens.) The Test button
 * stayed disabled even with a filled URL because `!form.watch("url")` was frozen
 * at its empty initial value; the conditional Environment-name and
 * Postgres-schema fields had the same latent staleness.
 *
 * `useWatch` fixes it structurally: each component owns its own field
 * subscription via its own hook, so it re-renders on field changes regardless
 * of whether the parent re-invokes the render prop. This mirrors the
 * established pattern in `branding/page.tsx` and `integrations/config-schema-fields.tsx`.
 */

export function TestConnectionButton({
  form,
  saving,
  onTest,
}: {
  form: UseFormReturn<ConnectionFormValues>;
  saving: boolean;
  onTest: (url: string, schema: string) => void;
}) {
  const url = useWatch({ control: form.control, name: "url" });
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => onTest(form.getValues("url"), form.getValues("schema"))}
      disabled={saving || !url}
    >
      {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
      Test
    </Button>
  );
}

export function NewEnvNameField({
  form,
}: {
  form: UseFormReturn<ConnectionFormValues>;
}) {
  const envSelection = useWatch({ control: form.control, name: "envSelection" });
  if (envSelection !== ENV_SENTINEL_CREATE) return null;
  return (
    <FormField
      control={form.control}
      name="newGroupName"
      render={({ field }) => (
        <FormItem>
          <FormLabel>New Environment Name</FormLabel>
          <FormControl>
            <Input
              placeholder="e.g. Production"
              {...field}
              autoFocus
              data-testid="env-new-name-input"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function PostgresSchemaField({
  form,
}: {
  form: UseFormReturn<ConnectionFormValues>;
}) {
  const dbType = useWatch({ control: form.control, name: "dbType" });
  if (dbType !== "postgres") return null;
  return (
    <FormField
      control={form.control}
      name="schema"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Schema</FormLabel>
          <FormControl>
            <Input placeholder="public" {...field} />
          </FormControl>
          <FormDesc>
            PostgreSQL schema (sets search_path). Leave empty for &quot;public&quot;.
          </FormDesc>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
