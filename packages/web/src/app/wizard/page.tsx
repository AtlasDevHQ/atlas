"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQueryStates } from "nuqs";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ConnectionInfo, WizardTableEntry, WizardEntityResult } from "@/ui/lib/types";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { OnboardingShell } from "@/ui/components/onboarding/onboarding-shell";
import { StepTrack } from "@/ui/components/onboarding/step-track";
import { wizardSearchParams } from "./search-params";
import { WIZARD_STEPS, type WizardStepId, wizardStepIdForNum } from "./wizard-steps";
import {
  DEMO_CONNECTION_ID,
  connectionDisplayName,
  partitionConnections,
  userMessageFor,
} from "./wizard-helpers";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileCode,
  Loader2,
  MessageSquare,
  Sparkles,
  Table as TableLucide,
  TableIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Status banner for top-of-shell errors (e.g. save failures)
// ---------------------------------------------------------------------------

function ErrorBanner({ message, requestId }: { message: string; requestId?: string }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p>{message}</p>
        {requestId && (
          <p className="font-mono text-[11px] opacity-80">requestId: {requestId}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Pick a datasource
// ---------------------------------------------------------------------------

function StepDatasource({
  selectedConnectionId,
  onConnectionChange,
  onNext,
}: {
  selectedConnectionId: string;
  onConnectionChange: (id: string) => void;
  onNext: () => void;
}) {
  const { data: connections, loading, error } = useAdminFetch<ConnectionInfo[]>(
    "/api/v1/admin/connections",
    { transform: (json) => (json as { connections?: ConnectionInfo[] }).connections ?? [] },
  );

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <ErrorBanner message={`Couldn't load your saved connections. ${error.message}`} />
        </CardContent>
      </Card>
    );
  }

  const { demo, user } = partitionConnections(connections);
  const hasOptions = !!demo || user.length > 0;

  if (!hasOptions) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-tight">Connect Atlas to your data</CardTitle>
          <CardDescription>
            Atlas needs a database connection before it can profile your schema and build a
            semantic layer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
            <Database className="mx-auto mb-3 size-10 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              No connections configured yet. Add one in admin and come back to set up the
              semantic layer.
            </p>
            <Button asChild className="mt-4">
              <a href="/admin/connections">Add a connection</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl tracking-tight">Set up your semantic layer</CardTitle>
        <CardDescription>
          Pick a database to profile. Atlas reads your tables, infers types and joins, and
          generates editable YAML so the agent can understand your schema.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {demo && (
          <DatasourceCard
            label="Use the demo dataset"
            description={
              demo.description ??
              "Pre-loaded sample data so you can try Atlas without connecting your own database."
            }
            icon={Sparkles}
            badge="Recommended"
            badgeTone="primary"
            selected={selectedConnectionId === demo.id}
            onClick={() => onConnectionChange(demo.id)}
            footer={`${demo.dbType} · provided by Atlas`}
          />
        )}
        {user.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Your saved connections
            </p>
            {user.map((c) => (
              <DatasourceCard
                key={c.id}
                label={connectionDisplayName(c)}
                description={
                  c.description ?? `${c.dbType.toUpperCase()} connection`
                }
                icon={Database}
                selected={selectedConnectionId === c.id}
                onClick={() => onConnectionChange(c.id)}
                footer={`${c.dbType}${c.health?.latencyMs != null ? ` · ${c.health.latencyMs}ms` : ""}`}
              />
            ))}
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="outline" asChild>
            <a href="/admin/connections">Manage connections</a>
          </Button>
          <Button onClick={onNext} disabled={!selectedConnectionId}>
            Continue
            <ChevronRight className="ml-1 size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface DatasourceCardProps {
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  badgeTone?: "primary" | "muted";
  selected: boolean;
  onClick: () => void;
  footer: string;
}

function DatasourceCard({
  label,
  description,
  icon: Icon,
  badge,
  badgeTone = "muted",
  selected,
  onClick,
  footer,
}: DatasourceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/40 hover:bg-accent",
      )}
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-md transition-colors",
          selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground group-hover:text-primary",
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{label}</span>
          {badge && (
            <Badge
              variant={badgeTone === "primary" ? "default" : "secondary"}
              className="shrink-0 text-[10px]"
            >
              {badge}
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{footer}</p>
      </div>
      {selected ? (
        <CheckCircle2 className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <div
          className="mt-1 size-5 shrink-0 rounded-full border border-muted-foreground/30"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Pick tables
// ---------------------------------------------------------------------------

function StepTables({
  connectionId,
  apiUrl,
  credentials,
  onNext,
  onBack,
  selectedTables,
  setSelectedTables,
}: {
  connectionId: string;
  apiUrl: string;
  credentials: RequestCredentials;
  onNext: () => void;
  onBack: () => void;
  selectedTables: string[];
  setSelectedTables: (t: string[]) => void;
}) {
  const [tables, setTables] = useState<WizardTableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  // Track whether we've ever seeded selection from the API. On retry, we want
  // to preserve the user's manual deselections — only seed on first load.
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/api/v1/wizard/profile`, {
          method: "POST",
          credentials,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
          setError(typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        const fetched = (data.tables ?? []) as WizardTableEntry[];
        setTables(fetched);
        if (!seededRef.current) {
          setSelectedTables(fetched.map((t) => t.name));
          seededRef.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[wizard] profile failed:", err instanceof Error ? err.message : String(err));
          setError(userMessageFor(err, "Couldn't list tables. Try again in a moment."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // connectionId/apiUrl/credentials are passed once per session-step; the
    // empty deps + `cancelled` flag keep this effect a one-shot fetch.
  }, []);

  const filtered = tables.filter((t) =>
    t.name.toLowerCase().includes(filterText.toLowerCase()),
  );
  const types = new Set(tables.map((t) => t.type));
  const showTypeColumn = types.size > 1;

  function toggleAll(checked: boolean) {
    setSelectedTables(checked ? filtered.map((t) => t.name) : []);
  }

  function toggleTable(name: string) {
    setSelectedTables(
      selectedTables.includes(name)
        ? selectedTables.filter((t) => t !== name)
        : [...selectedTables, name],
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Reading tables from your database…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="space-y-4 py-8">
          <ErrorBanner message={error} />
          <p className="text-xs text-muted-foreground">
            Common causes: the connection no longer exists, or the database role doesn&apos;t
            have read access to system catalogs. Manage connections in{" "}
            <a className="underline" href="/admin/connections">
              admin
            </a>
            .
          </p>
          <div className="flex justify-start">
            <Button variant="outline" onClick={onBack}>
              <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
              Pick another connection
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <TableLucide className="size-4 text-muted-foreground" aria-hidden="true" />
          Choose tables
        </CardTitle>
        <CardDescription>
          Pick the tables Atlas should profile. {tables.length}{" "}
          {tables.length === 1 ? "table is" : "tables are"} available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Input
            placeholder="Filter by name…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="max-w-sm"
            aria-label="Filter tables"
          />
          <span className="text-sm text-muted-foreground">
            {selectedTables.length} of {tables.length} selected
          </span>
        </div>

        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      filtered.length > 0 &&
                      filtered.every((t) => selectedTables.includes(t.name))
                    }
                    onCheckedChange={(checked) => toggleAll(!!checked)}
                    aria-label="Select all visible tables"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                {showTypeColumn && <TableHead className="w-24">Type</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const isSelected = selectedTables.includes(t.name);
                return (
                  <TableRow
                    key={t.name}
                    onClick={() => toggleTable(t.name)}
                    className="cursor-pointer"
                    data-state={isSelected ? "selected" : undefined}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleTable(t.name)}
                        aria-label={`Toggle ${t.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{t.name}</TableCell>
                    {showTypeColumn && (
                      <TableCell>
                        <Badge variant={t.type === "table" ? "default" : "secondary"}>
                          {t.type === "materialized_view" ? "matview" : t.type}
                        </Badge>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showTypeColumn ? 3 : 2}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No tables match &ldquo;{filterText}&rdquo;.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
            Back
          </Button>
          <Button onClick={onNext} disabled={selectedTables.length === 0}>
            Profile {selectedTables.length}{" "}
            {selectedTables.length === 1 ? "table" : "tables"}
            <ChevronRight className="ml-1 size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Review entities
// ---------------------------------------------------------------------------

function StepReview({
  connectionId,
  selectedTables,
  apiUrl,
  credentials,
  onNext,
  onBack,
  entities,
  setEntities,
  saving,
  saveError,
}: {
  connectionId: string;
  selectedTables: string[];
  apiUrl: string;
  credentials: RequestCredentials;
  onNext: () => void;
  onBack: () => void;
  entities: WizardEntityResult[];
  setEntities: (e: WizardEntityResult[]) => void;
  saving: boolean;
  saveError: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [editingYaml, setEditingYaml] = useState<Record<string, string>>({});

  useEffect(() => {
    if (entities.length > 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${apiUrl}/api/v1/wizard/generate`, {
          method: "POST",
          credentials,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId, tables: selectedTables }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
          setError(typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        const generated = (data.entities ?? []) as WizardEntityResult[];
        setEntities(generated);
        const yamlMap: Record<string, string> = {};
        for (const entity of generated) yamlMap[entity.tableName] = entity.yaml;
        setEditingYaml(yamlMap);
      } catch (err) {
        if (!cancelled) {
          console.warn("[wizard] generate failed:", err instanceof Error ? err.message : String(err));
          setError(userMessageFor(err, "Couldn't profile the tables. Try again in a moment."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Effect runs once per mount; the entities-length guard re-uses cached
    // results when navigating back from a future step (none after step 3 today).
  }, []);

  function handleYamlChange(tableName: string, yaml: string) {
    setEditingYaml((prev) => ({ ...prev, [tableName]: yaml }));
    setEntities(entities.map((e) => (e.tableName === tableName ? { ...e, yaml } : e)));
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Profiling {selectedTables.length}{" "}
            {selectedTables.length === 1 ? "table" : "tables"}…
          </p>
          <p className="text-xs text-muted-foreground">
            This can take 10-30 seconds depending on table size.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="space-y-4 py-8">
          <ErrorBanner message={error} />
          <div className="flex justify-start">
            <Button variant="outline" onClick={onBack}>
              <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const totalColumns = entities.reduce((sum, e) => sum + e.columnCount, 0);
  const totalRows = entities.reduce((sum, e) => sum + e.rowCount, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileCode className="size-4 text-muted-foreground" aria-hidden="true" />
          Review the semantic layer
        </CardTitle>
        <CardDescription>
          {entities.length} {entities.length === 1 ? "entity" : "entities"},{" "}
          {totalColumns} columns, {totalRows.toLocaleString()} rows. You can fine-tune the
          YAML here, or in the admin semantic editor anytime.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {saveError && <ErrorBanner message={saveError} />}

        <ul className="max-h-[600px] space-y-2 overflow-auto pr-1">
          {entities.map((entity) => {
            const isExpanded = expandedEntity === entity.tableName;
            const profile = entity.profile;
            return (
              <li key={entity.tableName} className="overflow-hidden rounded-lg border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => setExpandedEntity(isExpanded ? null : entity.tableName)}
                  aria-expanded={isExpanded}
                  aria-controls={`entity-${entity.tableName}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <TableIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate font-mono text-sm font-medium">
                      {entity.tableName}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {entity.rowCount.toLocaleString()} rows · {entity.columnCount} cols
                    </span>
                    {profile.flags.possiblyAbandoned && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="text-[10px]">low signal</Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            Looks abandoned — last write activity was old or row count is low.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {profile.flags.possiblyDenormalized && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="text-[10px]">denormalized</Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            Many columns relative to rows — likely a wide reporting table.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <ChevronRight
                      className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90",
                      )}
                      aria-hidden="true"
                    />
                  </div>
                </button>

                {isExpanded && (
                  <div
                    id={`entity-${entity.tableName}`}
                    className="space-y-4 border-t bg-muted/20 px-4 py-3"
                  >
                    {profile.notes.length > 0 && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        {profile.notes.map((note, i) => (
                          <p key={i}>{note}</p>
                        ))}
                      </div>
                    )}

                    <div>
                      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Columns
                      </h4>
                      <div className="max-h-48 overflow-auto rounded-md border bg-card">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs">Name</TableHead>
                              <TableHead className="text-xs">Type</TableHead>
                              <TableHead className="text-xs">Flags</TableHead>
                              <TableHead className="text-xs">Samples</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {profile.columns.map((col) => (
                              <TableRow key={col.name}>
                                <TableCell className="font-mono text-xs">{col.name}</TableCell>
                                <TableCell className="text-xs">{col.type}</TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {col.isPrimaryKey && (
                                      <Badge variant="default" className="px-1 text-[10px]">PK</Badge>
                                    )}
                                    {col.isForeignKey && (
                                      <Badge variant="secondary" className="px-1 text-[10px]">FK</Badge>
                                    )}
                                    {col.isEnumLike && (
                                      <Badge variant="outline" className="px-1 text-[10px]">enum</Badge>
                                    )}
                                    {col.nullable && (
                                      <Badge variant="outline" className="px-1 text-[10px]">null</Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                                  {col.sampleValues.join(", ")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>

                    {(profile.foreignKeys.length > 0 || profile.inferredForeignKeys.length > 0) && (
                      <div>
                        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Relationships
                        </h4>
                        <ul className="space-y-1">
                          {profile.foreignKeys.map((fk, i) => (
                            <li key={`c-${i}`} className="flex items-center gap-2 text-xs">
                              <span className="font-mono">{fk.fromColumn}</span>
                              <ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
                              <span className="font-mono">
                                {fk.toTable}.{fk.toColumn}
                              </span>
                              <Badge variant="default" className="px-1 text-[10px]">constraint</Badge>
                            </li>
                          ))}
                          {profile.inferredForeignKeys.map((fk, i) => (
                            <li key={`i-${i}`} className="flex items-center gap-2 text-xs">
                              <span className="font-mono">{fk.fromColumn}</span>
                              <ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
                              <span className="font-mono">
                                {fk.toTable}.{fk.toColumn}
                              </span>
                              <Badge variant="secondary" className="px-1 text-[10px]">inferred</Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <details className="rounded-md border bg-card">
                      <summary className="cursor-pointer rounded-md px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent">
                        Edit YAML
                      </summary>
                      <div className="border-t p-3">
                        <Label htmlFor={`yaml-${entity.tableName}`} className="sr-only">
                          Entity YAML for {entity.tableName}
                        </Label>
                        <Textarea
                          id={`yaml-${entity.tableName}`}
                          value={editingYaml[entity.tableName] ?? entity.yaml}
                          onChange={(e) => handleYamlChange(entity.tableName, e.target.value)}
                          className="font-mono text-xs"
                          rows={12}
                        />
                      </div>
                    </details>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack} disabled={saving}>
            <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
            Back
          </Button>
          <Button onClick={onNext} disabled={entities.length === 0 || saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              <>
                Save semantic layer
                <CheckCircle2 className="ml-1 size-4" aria-hidden="true" />
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Done
// ---------------------------------------------------------------------------

const STARTER_PROMPTS_DEFAULT = [
  "What are our top 10 customers by revenue this quarter?",
  "Which products had the biggest week-over-week drop?",
  "Show me churn risk by plan tier.",
];

const STARTER_PROMPTS_DEMO = [
  "How many open critical incidents do we have?",
  "Which compliance frameworks are passing?",
  "Top 5 customers by ticket volume this month.",
];

function StepDone({
  entityCount,
  isDemoConnection,
}: {
  entityCount: number;
  isDemoConnection: boolean;
}) {
  const router = useRouter();
  const prompts = isDemoConnection ? STARTER_PROMPTS_DEMO : STARTER_PROMPTS_DEFAULT;

  return (
    <Card>
      <CardHeader className="space-y-1.5 text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="size-6 text-primary" aria-hidden="true" />
        </div>
        <CardTitle className="text-2xl tracking-tight">You&apos;re ready to query</CardTitle>
        <CardDescription>
          {entityCount > 0
            ? `${entityCount} ${entityCount === 1 ? "entity" : "entities"} saved. Atlas understands your schema and can write SQL on it.`
            : "Atlas is ready to query your data."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="prompts-heading" className="space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="size-4 text-primary" aria-hidden="true" />
            <h2 id="prompts-heading" className="text-sm font-semibold">
              Try starting with one of these
            </h2>
          </div>
          <ul className="space-y-2">
            {prompts.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  onClick={() => router.push(`/?prompt=${encodeURIComponent(prompt)}`)}
                  className="group flex w-full items-center justify-between gap-3 rounded-md border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>{prompt}</span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <Button size="lg" className="w-full" onClick={() => router.push("/")}>
          Open Atlas
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          You can refine the semantic layer any time in{" "}
          <a className="underline" href="/admin/semantic">
            admin → semantic
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main wizard page
// ---------------------------------------------------------------------------

export default function WizardPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [params, setParams] = useQueryStates(wizardSearchParams);
  const stepNum = Math.min(Math.max(params.step, 1), WIZARD_STEPS.length);
  const stepId: WizardStepId = wizardStepIdForNum(stepNum);

  const [connectionId, setConnectionId] = useState(params.connectionId || "");
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [entities, setEntities] = useState<WizardEntityResult[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function goTo(nextStep: number) {
    setParams({ step: nextStep, connectionId });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/wizard/save`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          entities: entities.map((e) => ({ tableName: e.tableName, yaml: e.yaml })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        const message = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
        console.warn("[wizard] save failed:", message);
        setSaveError(userMessageFor(new Error(message), "Couldn't save the semantic layer."));
        return;
      }
      goTo(4);
    } catch (err) {
      console.warn("[wizard] save error:", err instanceof Error ? err.message : String(err));
      setSaveError(userMessageFor(err, "Couldn't save the semantic layer."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OnboardingShell
      width="wide"
      indicator={<StepTrack steps={WIZARD_STEPS} current={stepId} ariaLabel="Setup progress" />}
      skip={stepNum < WIZARD_STEPS.length ? { href: "/", label: "Skip for now" } : undefined}
    >
      {stepId === "datasource" && (
        <StepDatasource
          selectedConnectionId={connectionId}
          onConnectionChange={setConnectionId}
          onNext={() => goTo(2)}
        />
      )}

      {stepId === "tables" && (
        <StepTables
          connectionId={connectionId}
          apiUrl={apiUrl}
          credentials={credentials}
          selectedTables={selectedTables}
          setSelectedTables={setSelectedTables}
          onNext={() => goTo(3)}
          onBack={() => goTo(1)}
        />
      )}

      {stepId === "review" && (
        <StepReview
          connectionId={connectionId}
          selectedTables={selectedTables}
          apiUrl={apiUrl}
          credentials={credentials}
          entities={entities}
          setEntities={setEntities}
          onNext={() => {
            if (!saving) handleSave();
          }}
          onBack={() => goTo(2)}
          saving={saving}
          saveError={saveError}
        />
      )}

      {stepId === "done" && (
        <StepDone
          entityCount={entities.length}
          isDemoConnection={connectionId === DEMO_CONNECTION_ID}
        />
      )}
    </OnboardingShell>
  );
}
