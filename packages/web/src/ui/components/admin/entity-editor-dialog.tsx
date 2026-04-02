"use client";

import { useEffect } from "react";
import { useForm, useFieldArray, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";


// ── Schema ────────────────────────────────────────────────────────

const DIMENSION_TYPES = ["string", "number", "date", "boolean", "timestamp"] as const;
const MEASURE_TYPES = ["count", "sum", "avg", "count_distinct", "min", "max"] as const;

const dimensionSchema = z.object({
  name: z.string().min(1, "Required"),
  sql: z.string().min(1, "Required"),
  type: z.enum(DIMENSION_TYPES),
  description: z.string().optional().default(""),
  sample_values_csv: z.string().optional().default(""),
});

const measureSchema = z.object({
  name: z.string().min(1, "Required"),
  sql: z.string().min(1, "Required"),
  type: z.enum(MEASURE_TYPES),
  description: z.string().optional().default(""),
});

const joinSchema = z.object({
  name: z.string().min(1, "Required"),
  sql: z.string().min(1, "Required"),
  description: z.string().optional().default(""),
});

const queryPatternSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional().default(""),
  sql: z.string().min(1, "Required"),
});

export const entityFormSchema = z.object({
  table: z.string().min(1, "Table name is required"),
  description: z.string().optional().default(""),
  dimensions: z.array(dimensionSchema).optional().default([]),
  measures: z.array(measureSchema).optional().default([]),
  joins: z.array(joinSchema).optional().default([]),
  query_patterns: z.array(queryPatternSchema).optional().default([]),
});

export type EntityFormValues = z.infer<typeof entityFormSchema>;

// ── Convert from API entity data to form values ──────────────────

interface EntityData {
  table: string;
  name: string;
  description?: string;
  dimensions?: Array<{
    name: string;
    sql?: string;
    type?: string;
    description?: string;
    sample_values?: string[];
  }>;
  measures?: Array<{
    name: string;
    sql?: string;
    type?: string;
    description?: string;
  }>;
  joins?: Array<{
    to?: string;
    name?: string;
    on?: string;
    sql?: string;
    description?: string;
  }>;
  query_patterns?: Array<{
    name: string;
    sql?: string;
    description?: string;
  }>;
}

export function entityToFormValues(entity: EntityData): EntityFormValues {
  return {
    table: entity.table,
    description: entity.description ?? "",
    dimensions: (entity.dimensions ?? []).map((d) => ({
      name: d.name,
      sql: d.sql ?? d.name,
      type: (DIMENSION_TYPES as readonly string[]).includes(d.type ?? "")
        ? (d.type as (typeof DIMENSION_TYPES)[number])
        : "string",
      description: d.description ?? "",
      sample_values_csv: d.sample_values?.join(", ") ?? "",
    })),
    measures: (entity.measures ?? []).map((m) => ({
      name: m.name,
      sql: m.sql ?? "",
      type: (MEASURE_TYPES as readonly string[]).includes(m.type ?? "")
        ? (m.type as (typeof MEASURE_TYPES)[number])
        : "count",
      description: m.description ?? "",
    })),
    joins: (entity.joins ?? []).map((j) => ({
      name: j.name ?? j.to ?? "",
      sql: j.sql ?? j.on ?? "",
      description: j.description ?? "",
    })),
    query_patterns: (entity.query_patterns ?? []).map((p) => ({
      name: p.name,
      sql: p.sql ?? "",
      description: p.description ?? "",
    })),
  };
}

/**
 * Convert form values to the structured JSON body expected by
 * PUT /api/v1/admin/semantic/entities/edit/:name
 */
export function formValuesToEntityBody(values: EntityFormValues) {
  return {
    table: values.table,
    description: values.description || "",
    dimensions: (values.dimensions ?? []).map((d) => ({
      name: d.name,
      sql: d.sql,
      type: d.type,
      description: d.description || "",
      sample_values: d.sample_values_csv
        ? d.sample_values_csv.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    })),
    measures: (values.measures ?? []).map((m) => ({
      name: m.name,
      sql: m.sql,
      type: m.type,
      description: m.description || "",
    })),
    joins: (values.joins ?? []).map((j) => ({
      name: j.name,
      sql: j.sql,
      description: j.description || "",
    })),
    query_patterns: (values.query_patterns ?? []).map((p) => ({
      name: p.name,
      sql: p.sql,
      description: p.description || "",
    })),
  };
}

// ── Default values for new items ─────────────────────────────────

const DEFAULT_DIMENSION = { name: "", sql: "", type: "string" as const, description: "", sample_values_csv: "" };
const DEFAULT_MEASURE = { name: "", sql: "", type: "count" as const, description: "" };
const DEFAULT_JOIN = { name: "", sql: "", description: "" };
const DEFAULT_PATTERN = { name: "", sql: "", description: "" };

// ── Array section component ──────────────────────────────────────

function ArraySectionHeader({
  title,
  count,
  onAdd,
}: {
  title: string;
  count: number;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-sm font-semibold">
        {title} ({count})
      </h4>
      <Button type="button" variant="outline" size="sm" onClick={onAdd} className="gap-1">
        <Plus className="size-3" />
        Add
      </Button>
    </div>
  );
}

// ── Dimensions section ───────────────────────────────────────────

function DimensionsSection({ form }: { form: UseFormReturn<EntityFormValues> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "dimensions" });

  return (
    <div className="space-y-3">
      <ArraySectionHeader title="Dimensions" count={fields.length} onAdd={() => append(DEFAULT_DIMENSION)} />
      {fields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Name</TableHead>
                <TableHead className="w-[140px]">SQL</TableHead>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[160px]">Sample Values</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id}>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.name`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="column" className="h-8 text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.sql`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="column_name" className="h-8 font-mono text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.type`}
                      render={({ field: f }) => (
                        <FormItem>
                          <Select value={f.value} onValueChange={f.onChange}>
                            <FormControl>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {DIMENSION_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>{t}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="Description" className="h-8 text-xs" />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.sample_values_csv`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="val1, val2" className="h-8 text-xs" />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Measures section ─────────────────────────────────────────────

function MeasuresSection({ form }: { form: UseFormReturn<EntityFormValues> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "measures" });

  return (
    <div className="space-y-3">
      <ArraySectionHeader title="Measures" count={fields.length} onAdd={() => append(DEFAULT_MEASURE)} />
      {fields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Name</TableHead>
                <TableHead>SQL</TableHead>
                <TableHead className="w-[140px]">Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id}>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`measures.${index}.name`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="metric_name" className="h-8 text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`measures.${index}.sql`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="COUNT(*)" className="h-8 font-mono text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`measures.${index}.type`}
                      render={({ field: f }) => (
                        <FormItem>
                          <Select value={f.value} onValueChange={f.onChange}>
                            <FormControl>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {MEASURE_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>{t}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`measures.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="Description" className="h-8 text-xs" />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Joins section ────────────────────────────────────────────────

function JoinsSection({ form }: { form: UseFormReturn<EntityFormValues> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "joins" });

  return (
    <div className="space-y-3">
      <ArraySectionHeader title="Joins" count={fields.length} onAdd={() => append(DEFAULT_JOIN)} />
      {fields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Name</TableHead>
                <TableHead>SQL</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id}>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`joins.${index}.name`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="to_other_table" className="h-8 text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`joins.${index}.sql`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="a.col = b.col" className="h-8 font-mono text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`joins.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="Description" className="h-8 text-xs" />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Query Patterns section ───────────────────────────────────────

function QueryPatternsSection({ form }: { form: UseFormReturn<EntityFormValues> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "query_patterns" });

  return (
    <div className="space-y-3">
      <ArraySectionHeader title="Query Patterns" count={fields.length} onAdd={() => append(DEFAULT_PATTERN)} />
      {fields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>SQL</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow key={field.id}>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`query_patterns.${index}.name`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="pattern_name" className="h-8 text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`query_patterns.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="Description" className="h-8 text-xs" />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`query_patterns.${index}.sql`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="SELECT ..." className="h-8 font-mono text-xs" />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell className="p-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Main dialog ──────────────────────────────────────────────────

interface EntityEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create new, non-null = edit existing */
  entity: EntityData | null;
  /** Entity name when editing (used as the URL path param) */
  entityName: string | null;
  saving: boolean;
  serverError: string | null;
  onSave: (name: string, body: ReturnType<typeof formValuesToEntityBody>) => Promise<void>;
}

export function EntityEditorDialog({
  open,
  onOpenChange,
  entity,
  entityName,
  saving,
  serverError,
  onSave,
}: EntityEditorDialogProps) {
  const isEditing = entity !== null;
  const defaultValues: EntityFormValues = entity
    ? entityToFormValues(entity)
    : { table: "", description: "", dimensions: [], measures: [], joins: [], query_patterns: [] };

  const form = useForm<EntityFormValues>({
    resolver: zodResolver(entityFormSchema as z.ZodType<EntityFormValues, EntityFormValues>),
    defaultValues,
  });

  // Reset form when dialog opens with new entity data
  useEffect(() => {
    if (open) {
      form.reset(entity ? entityToFormValues(entity) : {
        table: "", description: "", dimensions: [], measures: [], joins: [], query_patterns: [],
      });
    }
  }, [open]); // intentionally depends only on `open`

  const handleSubmit = form.handleSubmit(async (values) => {
    // Use the table name as the entity name for new entities,
    // or the existing name for edits
    const name = entityName ?? values.table.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    await onSave(name, formValuesToEntityBody(values));
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEditing ? `Edit ${entityName}` : "Add Entity"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Modify the entity definition. Changes take effect immediately."
              : "Define a new semantic entity for your workspace."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <ScrollArea className="flex-1 pr-3">
              <div className="space-y-6 py-2">
                {/* Core fields */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="table"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Table Name</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="users" disabled={isEditing} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea {...field} placeholder="What this table contains..." rows={2} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Separator />
                <DimensionsSection form={form} />

                <Separator />
                <MeasuresSection form={form} />

                <Separator />
                <JoinsSection form={form} />

                <Separator />
                <QueryPatternsSection form={form} />
              </div>
            </ScrollArea>

            {(serverError || form.formState.errors.root?.message) && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive mt-2">
                {serverError || form.formState.errors.root?.message}
              </div>
            )}

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                {isEditing ? "Save Changes" : "Create Entity"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
