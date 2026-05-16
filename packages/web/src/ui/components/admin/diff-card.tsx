"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown } from "lucide-react";
import type { SemanticTableDiff } from "@/ui/lib/types";

/**
 * Per-table drift card extracted from `/admin/schema-diff` (#2461). Both
 * the legacy schema-diff page and the new drift drawer on `/admin/semantic`
 * render this. Keep it pure: the only input is the diff payload + the
 * optional initial-open flag the drawer uses to expand by default.
 */
export function DiffCard({
  diff,
  defaultOpen = false,
}: {
  diff: SemanticTableDiff;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const changeCount =
    diff.addedColumns.length + diff.removedColumns.length + diff.typeChanges.length;

  return (
    <Card className="border-amber-500/30 shadow-none">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer py-3 hover:bg-muted/30">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span className="font-mono">{diff.table}</span>
                <Badge
                  variant="outline"
                  className="text-xs text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700"
                >
                  {changeCount} {changeCount === 1 ? "change" : "changes"}
                </Badge>
              </CardTitle>
              <ChevronDown
                className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Change</TableHead>
                  <TableHead>Column</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.addedColumns.map((col) => (
                  <TableRow key={`add-${col.name}`}>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-green-700 dark:text-green-400 border-green-300 dark:border-green-700"
                      >
                        added
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{col.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      type: {col.type} (in DB, missing from YAML)
                    </TableCell>
                  </TableRow>
                ))}
                {diff.removedColumns.map((col) => (
                  <TableRow key={`rm-${col.name}`}>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-red-700 dark:text-red-400 border-red-300 dark:border-red-700"
                      >
                        removed
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{col.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      type: {col.type} (in YAML, missing from DB)
                    </TableCell>
                  </TableRow>
                ))}
                {diff.typeChanges.map((tc) => (
                  <TableRow key={`type-${tc.name}`}>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700"
                      >
                        type
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tc.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      YAML: <code className="rounded bg-muted px-1">{tc.yamlType}</code>
                      {" → "}
                      DB: <code className="rounded bg-muted px-1">{tc.dbType}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
