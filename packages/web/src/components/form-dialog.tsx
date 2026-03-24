"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import type { DefaultValues, FieldValues, Path, UseFormReturn } from "react-hook-form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";

interface FormDialogProps<TSchema extends z.ZodType<FieldValues>> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  schema: TSchema;
  defaultValues: DefaultValues<z.infer<TSchema>>;
  onSubmit: (values: z.infer<TSchema>) => Promise<void>;
  /** Render form fields. Use shadcn FormField / FormItem / FormControl components. */
  children: (form: UseFormReturn<z.infer<TSchema>>) => ReactNode;
  /** Text for the submit button. Default: "Save" */
  submitLabel?: string;
  /** Whether the mutation is in flight (disables submit button + shows spinner). */
  saving?: boolean;
  /** Server-side error message to display above the footer. */
  serverError?: string | null;
  /** Extra buttons to render in the footer before the submit button. */
  extraFooter?: (form: UseFormReturn<z.infer<TSchema>>) => ReactNode;
  /** Dialog content class name override. */
  className?: string;
}

/**
 * Combines Dialog + react-hook-form + Zod validation.
 *
 * - Resets form to `defaultValues` whenever the dialog opens
 * - Validates on submit via Zod schema
 * - Renders field-level errors via shadcn Form primitives
 */
export function FormDialog<TSchema extends z.ZodType<FieldValues>>({
  open,
  onOpenChange,
  title,
  description,
  schema,
  defaultValues,
  onSubmit,
  children,
  submitLabel = "Save",
  saving = false,
  serverError,
  extraFooter,
  className,
}: FormDialogProps<TSchema>) {
  type TValues = z.infer<TSchema>;

  const form = useForm<TValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  // Reset form whenever dialog opens with new defaultValues
  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
    }
  }, [open]); // intentionally depends only on `open` — reset to latest defaultValues on each open

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <div className="grid gap-4 py-2">
              {children(form)}
            </div>

            {serverError && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {serverError}
              </div>
            )}

            <DialogFooter>
              {extraFooter?.(form)}
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Re-export form primitives for convenient single-import in page files. */
export {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/ui/form";

/** Re-export Path type for FormField name prop. */
export type { Path as FormPath };
