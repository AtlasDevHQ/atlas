"use client";

/**
 * `ConfigSchemaFields` — renders a catalog row's `configSchema` fields inside a
 * {@link FormDialog} body, dispatching on each field's declared `type`
 * (string / number / boolean / select). Shared by {@link FormInstallModal}
 * (#2660) and {@link StaticBotInstallModal} (#3140) so the rendered input
 * always matches the validator {@link buildZodSchema} produced — keeping a
 * boolean field on a Checkbox, a select on a Select, etc., rather than forcing
 * a text input that would submit the wrong type.
 *
 * Progressive disclosure (#2660): consecutive visible fields gated by the same
 * `showWhen` controller (e.g. the Elasticsearch username + password fields,
 * both gated on `authMode === "basic"`) render inside a subtle tinted well, so
 * a conditional credential cluster reads as belonging to the selector above it
 * rather than blending into the always-on fields. A lone gated field stays
 * inline — a well around one input is noise. Forms without `showWhen` render a
 * flat stack exactly as before.
 */

import { useState } from "react";
import { type Control, useWatch } from "react-hook-form";
import { Eye, EyeOff } from "lucide-react";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
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

/**
 * A masked text input with a reveal toggle. Secret fields (API keys, passwords,
 * AWS secrets) are entered blind by default; the eye toggle lets an operator
 * verify a pasted value without leaving the form. The toggle is `tabIndex={-1}`
 * so keyboard flow runs label → input → next field, not through the affordance.
 */
function SecretInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <Input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        className="pr-9"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        tabIndex={-1}
        onClick={() => setRevealed((r) => !r)}
        aria-label={revealed ? `Hide ${ariaLabel}` : `Show ${ariaLabel}`}
        aria-pressed={revealed}
        className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

/** Render a single config field as a labeled form row. */
function ConfigFieldRow({
  field,
  control,
}: {
  field: FormFieldDescriptor;
  control: Control<Record<string, unknown>>;
}) {
  const labelText = field.label ?? field.key;
  return (
    <FormField
      control={control}
      name={field.key}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>
            {labelText}
            {field.required && (
              <span className="ml-0.5 text-muted-foreground" aria-hidden="true">
                *
              </span>
            )}
          </FormLabel>
          <FormControl>
            {field.type === "boolean" ? (
              <Checkbox
                checked={Boolean(rhf.value)}
                onCheckedChange={(checked) => rhf.onChange(Boolean(checked))}
                aria-label={labelText}
              />
            ) : field.type === "select" && field.options && field.options.length > 0 ? (
              <Select
                value={(rhf.value as string | undefined) ?? ""}
                onValueChange={(v) => rhf.onChange(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={`Select ${labelText}`} />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field.secret ? (
              <SecretInput
                value={(rhf.value as string | undefined) ?? ""}
                onChange={(v) => rhf.onChange(v)}
                ariaLabel={labelText}
              />
            ) : (
              <Input
                type={field.type === "number" ? "number" : "text"}
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
              />
            )}
          </FormControl>
          {field.description && <FormDescription>{field.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * Group the visible fields for render: a maximal run of consecutive fields
 * gated by the SAME `showWhen` controller becomes one cluster; everything else
 * stays a standalone field. A run of length 1 is left standalone (no well
 * around a single input).
 */
type Renderable =
  | { kind: "single"; field: FormFieldDescriptor }
  | { kind: "cluster"; key: string; fields: FormFieldDescriptor[] };

function planRender(visible: FormFieldDescriptor[]): Renderable[] {
  const out: Renderable[] = [];
  let i = 0;
  while (i < visible.length) {
    const controller = visible[i].showWhen?.field;
    if (!controller) {
      out.push({ kind: "single", field: visible[i] });
      i++;
      continue;
    }
    const run: FormFieldDescriptor[] = [];
    while (i < visible.length && visible[i].showWhen?.field === controller) {
      run.push(visible[i]);
      i++;
    }
    out.push(
      run.length > 1
        ? { kind: "cluster", key: `cluster:${controller}:${run[0].key}`, fields: run }
        : { kind: "single", field: run[0] },
    );
  }
  return out;
}

export function ConfigSchemaFields({ fields, control }: ConfigSchemaFieldsProps) {
  // Watch all values so `showWhen`-gated fields appear/disappear as the
  // controlling field (e.g. the auth-mode selector) changes. Filtering before
  // the plan keeps hooks stable (no conditional `useWatch` per field).
  const values = (useWatch({ control }) ?? {}) as Record<string, unknown>;
  const visibleFields = fields.filter((field) => isFieldVisible(field, values));
  const plan = planRender(visibleFields);
  return (
    <>
      {plan.map((item) =>
        item.kind === "single" ? (
          <ConfigFieldRow key={item.field.key} field={item.field} control={control} />
        ) : (
          <div
            key={item.key}
            data-testid="config-field-cluster"
            className="space-y-4 rounded-lg bg-muted/40 px-4 py-3.5"
          >
            {item.fields.map((field) => (
              <ConfigFieldRow key={field.key} field={field} control={control} />
            ))}
          </div>
        ),
      )}
    </>
  );
}
