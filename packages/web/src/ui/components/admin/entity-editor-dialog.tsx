"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm, useFieldArray, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
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
import { useAtlasConfig } from "@/ui/context";
import { cn } from "@/lib/utils";


// ── Schema ────────────────────────────────────────────────────────

const DIMENSION_TYPES = ["string", "number", "date", "boolean", "timestamp"] as const;
const MEASURE_TYPES = ["count", "sum", "avg", "count_distinct", "count_where", "min", "max"] as const;

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

// ── Column metadata types + DB type mapping ─────────────────────

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

type DimensionType = (typeof DIMENSION_TYPES)[number];

/**
 * Map a DB column type (from information_schema) to a semantic dimension type.
 * Returns undefined if the type doesn't have a clear mapping.
 */
function dbTypeToDimensionType(dbType: string): DimensionType | undefined {
  const t = dbType.toLowerCase();
  if (/^(varchar|text|char|character varying|character|citext|name|uuid|bpchar)/.test(t)) return "string";
  if (/^(int|bigint|smallint|tinyint|numeric|decimal|float|double|real|serial|bigserial|money)/.test(t)) return "number";
  if (/^(date)$/.test(t)) return "date";
  if (/^(timestamp|timestamptz|datetime)/.test(t)) return "timestamp";
  if (/^(bool|boolean|bit)$/.test(t)) return "boolean";
  return undefined;
}

// ── Convert from API entity data to form values ──────────────────

// Use the shared EntityData type from @useatlas/types (via @/ui/lib/types)
// so the dialog accepts the same type used by the semantic page.
import type { EntityData } from "@/ui/lib/types";
import { normalizeList } from "@/ui/lib/helpers";

// Local alias kept for the converter below — the shared type has
// dimensions as `Dimension[] | Record<string, Dimension>`, which
// normalizeList() converts to an array.
interface _EntityDataLegacy {
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
  // normalizeList handles both Array and Record<string, T> shapes from @useatlas/types
  const dims = normalizeList(entity.dimensions, "name");
  const measures = normalizeList(entity.measures, "name");
  const joins = normalizeList(entity.joins, "name");
  const patterns = normalizeList(entity.query_patterns, "name");
  return {
    table: entity.table,
    description: entity.description ?? "",
    dimensions: dims.map((d) => ({
      name: d.name,
      sql: (d.sql as string | undefined) ?? d.name,
      type: (DIMENSION_TYPES as readonly string[]).includes(d.type ?? "")
        ? (d.type as (typeof DIMENSION_TYPES)[number])
        : "string",
      description: d.description ?? "",
      sample_values_csv: (d as { sample_values?: string[] }).sample_values?.join(", ") ?? "",
    })),
    measures: measures.map((m) => ({
      name: m.name,
      sql: m.sql ?? "",
      type: (MEASURE_TYPES as readonly string[]).includes(m.type ?? "")
        ? (m.type as (typeof MEASURE_TYPES)[number])
        : "count",
      description: m.description ?? "",
    })),
    joins: joins.map((j) => ({
      name: (j.name as string | undefined) ?? (j as { to?: string }).to ?? "",
      sql: (j.sql as string | undefined) ?? (j as { on?: string }).on ?? "",
      description: j.description ?? "",
    })),
    query_patterns: patterns.map((p) => ({
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

function DimensionsSection({
  form,
  columns,
  columnNames,
}: {
  form: UseFormReturn<EntityFormValues>;
  columns: ColumnInfo[];
  columnNames: Set<string>;
}) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "dimensions" });
  const columnMap = new Map(columns.map((c) => [c.name, c]));

  const handleSqlBlur = (index: number) => {
    const sqlVal = form.getValues(`dimensions.${index}.sql`);
    const col = columnMap.get(sqlVal);
    if (col) {
      const suggested = dbTypeToDimensionType(col.type);
      if (suggested) {
        const current = form.getValues(`dimensions.${index}.type`);
        // Only auto-fill if current type is the default
        if (current === "string") {
          form.setValue(`dimensions.${index}.type`, suggested);
        }
      }
    }
  };

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
              {fields.map((field, index) => {
                const sqlVal = form.watch(`dimensions.${index}.sql`);
                const hasColumnWarning = columnNames.size > 0 && sqlVal && !columnNames.has(sqlVal);
                return (
                <TableRow key={field.id}>
                  <TableCell className="p-1.5">
                    <FormField
                      control={form.control}
                      name={`dimensions.${index}.name`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...f} placeholder="column" className="h-8 text-xs" list="col-suggestions" />
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
                            <Input
                              {...f}
                              placeholder="column_name"
                              className={cn("h-8 font-mono text-xs", hasColumnWarning && "border-amber-400")}
                              list="col-suggestions"
                              onBlur={() => { f.onBlur(); handleSqlBlur(index); }}
                            />
                          </FormControl>
                          {hasColumnWarning && (
                            <p className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                              <AlertTriangle className="size-2.5" />
                              Column not found in table
                            </p>
                          )}
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
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Measures section ─────────────────────────────────────────────

function MeasuresSection({
  form,
}: {
  form: UseFormReturn<EntityFormValues>;
}) {
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
                            <Input
                              {...f}
                              placeholder="COUNT(*)"
                              className="h-8 font-mono text-xs"
                              list="col-suggestions"
                            />
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
  /** Deploy mode — column autocomplete only available in SaaS mode */
  isSaas?: boolean;
}

/** Marker error for 404 "table not found" — not a real failure. */
class TableNotFoundError extends Error {
  constructor(table: string) { super(`Table "${table}" not found`); this.name = "TableNotFoundError"; }
}

/**
 * Fetch column metadata for a table from the analytics datasource.
 * Returns empty array on error or when not in SaaS mode.
 * Debounces table name changes via a 300ms delayed state.
 */
function useColumnMetadata(tableName: string, isSaas: boolean, dialogOpen: boolean) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Debounce table name to avoid fetching on every keystroke.
  // Sync immediately on dialog open to avoid stale query from previous entity.
  const [debouncedTable, setDebouncedTable] = useState(tableName);
  useEffect(() => {
    if (dialogOpen) {
      setDebouncedTable(tableName);
    }
  }, [dialogOpen, tableName]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTable(tableName), 300);
    return () => clearTimeout(timer);
  }, [tableName]);

  const isValidIdentifier = !!debouncedTable && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(debouncedTable);

  const query = useQuery<ColumnInfo[]>({
    queryKey: ["admin", "semantic", "columns", debouncedTable],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `${apiUrl}/api/v1/admin/semantic/columns/${encodeURIComponent(debouncedTable)}`,
        { credentials, signal },
      );
      if (res.status === 404) throw new TableNotFoundError(debouncedTable);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const rawMsg = (body as Record<string, unknown> | null)?.message;
        const msg = typeof rawMsg === "string" ? rawMsg : `HTTP ${res.status}`;
        console.debug("Column metadata fetch failed:", msg);
        throw new Error(msg);
      }
      const data = await res.json();
      return Array.isArray(data?.columns) ? data.columns : [];
    },
    enabled: dialogOpen && isSaas && isValidIdentifier,
    retry: false,
  });

  const tableNotFound = query.error instanceof TableNotFoundError;
  const columns = query.data ?? [];
  const loading = query.isFetching;

  return { columns, tableNotFound, loading };
}

export function EntityEditorDialog({
  open,
  onOpenChange,
  entity,
  entityName,
  saving,
  serverError,
  onSave,
  isSaas = false,
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

  // Watch table name for column metadata fetching
  const tableName = form.watch("table");
  const { columns, tableNotFound } = useColumnMetadata(tableName, isSaas, open);
  const columnNames = new Set(columns.map((c) => c.name));

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
                {/* Table not found warning */}
                {isSaas && tableNotFound && tableName && (
                  <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                    <AlertTriangle className="size-4 shrink-0" />
                    <span>
                      Table <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900/50">{tableName}</code> was not found in the connected datasource. You can still save this entity.
                    </span>
                  </div>
                )}

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
                <DimensionsSection form={form} columns={columns} columnNames={columnNames} />

                <Separator />
                <MeasuresSection form={form} />

                <Separator />
                <JoinsSection form={form} />

                <Separator />
                <QueryPatternsSection form={form} />
              </div>
            </ScrollArea>

            {/* Shared datalist for column name autocomplete */}
            {columns.length > 0 && (
              <datalist id="col-suggestions">
                {columns.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            )}

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
