"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export interface Dimension {
  name: string;
  type: string;
  description?: string;
  sample_values?: string[];
  primary_key?: boolean;
  foreign_key?: boolean;
}

export interface Join {
  to: string;
  description?: string;
  relationship?: string;
  on?: string;
}

export interface Measure {
  name: string;
  sql: string;
  type?: string;
  description?: string;
}

export interface QueryPattern {
  name: string;
  description: string;
  sql: string;
}

export interface EntityData {
  name: string;
  table: string;
  description: string;
  type?: "table" | "view";
  dimensions: Record<string, Dimension> | Dimension[];
  joins?: Join[] | Record<string, Join>;
  measures?: Record<string, Measure> | Measure[];
  query_patterns?: Record<string, QueryPattern> | QueryPattern[];
}

/**
 * Normalize a record-or-array field from the API into a flat array.
 * When the data is a Record, the key is merged in under `keyName`.
 */
function normalizeList<T>(
  data: Record<string, T> | T[] | undefined,
  keyName: string,
): (T & Record<string, unknown>)[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as (T & Record<string, unknown>)[];
  return Object.entries(data).map(([key, value]) => ({ ...value, [keyName]: key }));
}

export function EntityDetail({ entity }: { entity: EntityData }) {
  const dimensions = normalizeList(entity.dimensions, "name") as Dimension[];
  const joins = normalizeList(entity.joins, "to") as Join[];
  const measures = normalizeList(entity.measures, "name") as Measure[];
  const patterns = normalizeList(entity.query_patterns, "name") as QueryPattern[];

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{entity.name}</h2>
            {entity.type === "view" && <Badge variant="outline">view</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{entity.description}</p>
          {entity.table !== entity.name && (
            <p className="mt-1 text-xs text-muted-foreground">
              Table: <code className="rounded bg-muted px-1 py-0.5">{entity.table}</code>
            </p>
          )}
        </div>

        <Separator />

        {/* Dimensions */}
        <section>
          <h3 className="mb-3 text-sm font-semibold">Dimensions ({dimensions.length})</h3>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Column</TableHead>
                  <TableHead className="w-[100px]">Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[200px]">Sample Values</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dimensions.map((dim) => (
                  <TableRow key={dim.name}>
                    <TableCell className="font-mono text-xs">
                      <span className="flex items-center gap-1.5">
                        {dim.name}
                        {dim.primary_key && (
                          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1 py-0">
                            PK
                          </Badge>
                        )}
                        {dim.foreign_key && (
                          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] px-1 py-0">
                            FK
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {dim.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {dim.description || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {dim.sample_values?.length
                        ? dim.sample_values.slice(0, 3).join(", ")
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        {/* Joins */}
        {joins.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-semibold">Joins ({joins.length})</h3>
            <div className="space-y-2">
              {joins.map((join, i) => (
                <Card key={i} className="shadow-none">
                  <CardContent className="py-3">
                    <div className="flex items-start gap-2">
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
                        {join.relationship || "many_to_one"}
                      </Badge>
                      <div>
                        <p className="text-sm font-medium">{join.to}</p>
                        {join.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{join.description}</p>
                        )}
                        {join.on && (
                          <code className="mt-1 block rounded bg-muted px-2 py-1 text-xs">{join.on}</code>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Measures */}
        {measures.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-semibold">Measures ({measures.length})</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[180px]">Name</TableHead>
                    <TableHead className="w-[100px]">Type</TableHead>
                    <TableHead>SQL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {measures.map((m) => (
                    <TableRow key={m.name}>
                      <TableCell className="text-sm font-medium">{m.name}</TableCell>
                      <TableCell>
                        {m.type && (
                          <Badge variant="secondary" className="text-[10px]">
                            {m.type}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-2 py-0.5 text-xs">{m.sql}</code>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}

        {/* Query Patterns */}
        {patterns.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-semibold">Query Patterns ({patterns.length})</h3>
            <div className="space-y-3">
              {patterns.map((p, i) => (
                <Card key={`${p.name}-${i}`} className="shadow-none">
                  <CardHeader className="py-3 pb-2">
                    <CardTitle className="text-sm">{p.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                  </CardHeader>
                  <CardContent className="pt-0 pb-3">
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      <code>{p.sql}</code>
                    </pre>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
