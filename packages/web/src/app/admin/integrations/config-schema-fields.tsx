"use client";

/**
 * `ConfigSchemaFields` — renders a catalog row's `configSchema` fields inside a
 * {@link FormDialog} body, dispatching on each field's declared `type`
 * (string / number / boolean / select). Shared by {@link FormInstallModal}
 * (#2660) and {@link StaticBotInstallModal} (#3140) so the rendered input
 * always matches the validator {@link buildZodSchema} produced — keeping a
 * boolean field on a Checkbox, a select on a Select, etc., rather than forcing
 * a text input that would submit the wrong type.
 */

import { type Control, useWatch } from "react-hook-form";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type FormFieldDescriptor, isFieldVisible } from "./form-install-modal";

export interface ConfigSchemaFieldsProps {
  readonly fields: FormFieldDescriptor[];
  readonly control: Control<Record<string, unknown>>;
}

export function ConfigSchemaFields({ fields, control }: ConfigSchemaFieldsProps) {
  // Watch all values so `showWhen`-gated fields appear/disappear as the
  // controlling field (e.g. the auth-mode selector) changes. Filtering before
  // the map keeps hooks stable (no conditional `useWatch` per field).
  const values = (useWatch({ control }) ?? {}) as Record<string, unknown>;
  const visibleFields = fields.filter((field) => isFieldVisible(field, values));
  return (
    <>
      {visibleFields.map((field) => (
        <FormField
          key={field.key}
          control={control}
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
                ) : field.type === "select" && field.options && field.options.length > 0 ? (
                  <Select
                    value={(rhf.value as string | undefined) ?? ""}
                    onValueChange={(v) => rhf.onChange(v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={`Select ${field.label ?? field.key}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={
                      field.secret ? "password" : field.type === "number" ? "number" : "text"
                    }
                    value={(rhf.value as string | number | undefined) ?? ""}
                    // For number fields, map a blank input to `undefined` rather
                    // than `""` — Zod 4's `z.coerce.number().parse("")` returns
                    // `0`, so a blank optional number would silently submit 0 and
                    // a blank required number would pass instead of failing.
                    onChange={(e) =>
                      rhf.onChange(
                        field.type === "number"
                          ? e.target.value === "" || Number.isNaN(e.target.valueAsNumber)
                            ? undefined
                            : e.target.valueAsNumber
                          : e.target.value,
                      )
                    }
                    autoComplete={field.secret ? "off" : undefined}
                  />
                )}
              </FormControl>
              {field.description && <FormDescription>{field.description}</FormDescription>}
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
    </>
  );
}
