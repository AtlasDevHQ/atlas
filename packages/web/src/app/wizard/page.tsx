"use client";

import { useState, useEffect } from "react";
import { useQueryStates } from "nuqs";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { ConnectionInfo, WizardTableEntry, WizardEntityResult } from "@/ui/lib/types";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { wizardSearchParams } from "./search-params";
import {
  Database,
  Loader2,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  TableIcon,
  FileCode,
  Eye,
  Sparkles,
  ArrowRight,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Step indicators
// ---------------------------------------------------------------------------

const STEPS = [
  { num: 1, label: "Datasource", icon: Database },
  { num: 2, label: "Tables", icon: TableIcon },
  { num: 3, label: "Review", icon: FileCode },
  { num: 4, label: "Preview", icon: Eye },
  { num: 5, label: "Done", icon: CheckCircle2 },
] as const;

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <nav className="flex items-center justify-center gap-2 py-6" aria-label="Wizard steps">
      {STEPS.map((s, idx) => {
        const Icon = s.icon;
        const isActive = s.num === currentStep;
        const isComplete = s.num < currentStep;
        return (
          <div key={s.num} className="flex items-center gap-2">
            {idx > 0 && (
              <div
                className={cn(
                  "h-px w-8 transition-colors",
                  isComplete ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                isActive && "bg-primary text-primary-foreground",
                isComplete && "bg-primary/10 text-primary",
                !isActive && !isComplete && "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
              <span className="hidden sm:inline">{s.label}</span>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Select Datasource
// ---------------------------------------------------------------------------

function StepDatasource({
  onNext,
  selectedConnectionId,
  onConnectionChange,
}: {
  onNext: () => void;
  selectedConnectionId: string;
  onConnectionChange: (id: string) => void;
}) {
  const { data: connections, loading, error } = useAdminFetch<ConnectionInfo[]>(
    "/api/v1/admin/connections",
    { transform: (json) => (json as { connections?: ConnectionInfo[] }).connections ?? [] },
  );

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load connections: {error.message}
          </div>
        </CardContent>
      </Card>
    );
  }

  const connList = connections ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Datasource</CardTitle>
        <CardDescription>
          Choose a database connection to profile. The wizard will inspect your tables
          and generate a semantic layer so Atlas can understand your data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connList.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <Database className="mx-auto mb-3 size-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No connections configured. Add a datasource in{" "}
              <a href="/admin/connections" className="underline">
                Admin &rarr; Connections
              </a>{" "}
              first.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="wizard-conn">Connection</Label>
              <Select value={selectedConnectionId} onValueChange={onConnectionChange}>
                <SelectTrigger id="wizard-conn" className="w-full">
                  <SelectValue placeholder="Select a connection..." />
                </SelectTrigger>
                <SelectContent>
                  {connList.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="font-mono">{c.id}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{c.dbType}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end">
              <Button onClick={onNext} disabled={!selectedConnectionId}>
                Next
                <ChevronRight className="ml-1 size-4" />
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Select Tables
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

  // Fetch tables on mount
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
          setError(data.message || "Failed to list tables");
          return;
        }
        const data = await res.json();
        setTables(data.tables ?? []);
        // Select all by default
        if (selectedTables.length === 0) {
          setSelectedTables((data.tables ?? []).map((t: WizardTableEntry) => t.name));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = tables.filter((t) =>
    t.name.toLowerCase().includes(filterText.toLowerCase()),
  );

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
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="mr-2 size-5 animate-spin" />
          <span className="text-sm text-muted-foreground">Discovering tables...</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
          <div className="mt-4 flex justify-start">
            <Button variant="outline" onClick={onBack}>
              <ChevronLeft className="mr-1 size-4" />
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Tables</CardTitle>
        <CardDescription>
          Choose which tables and views to include in your semantic layer.
          Found {tables.length} objects in the database.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <Input
            placeholder="Filter tables..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="max-w-sm"
          />
          <Badge variant="secondary">{selectedTables.length} selected</Badge>
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
                    aria-label="Select all tables"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => (
                <TableRow key={t.name}>
                  <TableCell>
                    <Checkbox
                      checked={selectedTables.includes(t.name)}
                      onCheckedChange={() => toggleTable(t.name)}
                      aria-label={`Select ${t.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm">{t.name}</TableCell>
                  <TableCell>
                    <Badge variant={t.type === "table" ? "default" : "secondary"}>
                      {t.type === "materialized_view" ? "matview" : t.type}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    No tables match the filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="mr-1 size-4" />
            Back
          </Button>
          <Button onClick={onNext} disabled={selectedTables.length === 0}>
            Generate Entities
            <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Review Entities
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
}: {
  connectionId: string;
  selectedTables: string[];
  apiUrl: string;
  credentials: RequestCredentials;
  onNext: () => void;
  onBack: () => void;
  entities: WizardEntityResult[];
  setEntities: (e: WizardEntityResult[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [editingYaml, setEditingYaml] = useState<Record<string, string>>({});

  // Generate entities if not already loaded
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
          setError(data.message || "Failed to generate entities");
          return;
        }
        const data = await res.json();
        setEntities(data.entities ?? []);
        // Initialize editable YAML
        const yamlMap: Record<string, string> = {};
        for (const entity of data.entities ?? []) {
          yamlMap[entity.tableName] = entity.yaml;
        }
        setEditingYaml(yamlMap);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function handleYamlChange(tableName: string, yaml: string) {
    setEditingYaml((prev) => ({ ...prev, [tableName]: yaml }));
    setEntities(
      entities.map((e) => (e.tableName === tableName ? { ...e, yaml } : e)),
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-sm text-muted-foreground">
            Profiling {selectedTables.length} tables and generating entities...
          </p>
          <Progress value={33} className="w-48" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
          <div className="mt-4 flex justify-start">
            <Button variant="outline" onClick={onBack}>
              <ChevronLeft className="mr-1 size-4" />
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Entities</CardTitle>
        <CardDescription>
          {entities.length} entities generated. Click to expand and edit YAML, descriptions, column types, and sample values.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-[600px] overflow-auto space-y-2">
          {entities.map((entity) => {
            const isExpanded = expandedEntity === entity.tableName;
            const profile = entity.profile;
            return (
              <div key={entity.tableName} className="rounded-lg border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                  onClick={() => setExpandedEntity(isExpanded ? null : entity.tableName)}
                >
                  <div className="flex items-center gap-3">
                    <TableIcon className="size-4 text-muted-foreground" />
                    <span className="font-mono text-sm font-medium">{entity.tableName}</span>
                    <Badge variant="secondary" className="text-xs">
                      {entity.rowCount.toLocaleString()} rows
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {entity.columnCount} cols
                    </Badge>
                    {profile.flags.possiblyAbandoned && (
                      <Badge variant="destructive" className="text-xs">abandoned?</Badge>
                    )}
                    {profile.flags.possiblyDenormalized && (
                      <Badge variant="secondary" className="text-xs">denormalized</Badge>
                    )}
                  </div>
                  <ChevronRight
                    className={cn(
                      "size-4 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                </button>

                {isExpanded && (
                  <div className="border-t px-4 py-3 space-y-4">
                    {/* Column summary */}
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground mb-2">Columns</h4>
                      <div className="max-h-48 overflow-auto">
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
                                  <div className="flex gap-1">
                                    {col.isPrimaryKey && <Badge variant="default" className="text-[10px] px-1">PK</Badge>}
                                    {col.isForeignKey && <Badge variant="secondary" className="text-[10px] px-1">FK</Badge>}
                                    {col.isEnumLike && <Badge variant="outline" className="text-[10px] px-1">enum</Badge>}
                                    {col.nullable && <Badge variant="outline" className="text-[10px] px-1">null</Badge>}
                                  </div>
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                                  {col.sampleValues.join(", ")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>

                    {/* Relationships */}
                    {(profile.foreignKeys.length > 0 || profile.inferredForeignKeys.length > 0) && (
                      <div>
                        <h4 className="text-xs font-medium text-muted-foreground mb-1">Relationships</h4>
                        <div className="space-y-1">
                          {profile.foreignKeys.map((fk, i) => (
                            <p key={i} className="text-xs">
                              <span className="font-mono">{fk.fromColumn}</span>
                              <ArrowRight className="inline mx-1 size-3" />
                              <span className="font-mono">{fk.toTable}.{fk.toColumn}</span>
                              <Badge variant="default" className="ml-1 text-[10px] px-1">constraint</Badge>
                            </p>
                          ))}
                          {profile.inferredForeignKeys.map((fk, i) => (
                            <p key={`inf-${i}`} className="text-xs">
                              <span className="font-mono">{fk.fromColumn}</span>
                              <ArrowRight className="inline mx-1 size-3" />
                              <span className="font-mono">{fk.toTable}.{fk.toColumn}</span>
                              <Badge variant="secondary" className="ml-1 text-[10px] px-1">inferred</Badge>
                            </p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Editable YAML */}
                    <div>
                      <Label htmlFor={`yaml-${entity.tableName}`} className="text-xs">
                        Entity YAML (editable)
                      </Label>
                      <Textarea
                        id={`yaml-${entity.tableName}`}
                        value={editingYaml[entity.tableName] ?? entity.yaml}
                        onChange={(e) => handleYamlChange(entity.tableName, e.target.value)}
                        className="mt-1 font-mono text-xs"
                        rows={12}
                      />
                    </div>

                    {/* Notes */}
                    {profile.notes.length > 0 && (
                      <div className="rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
                        {profile.notes.map((note, i) => (
                          <p key={i}>{note}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="mr-1 size-4" />
            Back
          </Button>
          <Button onClick={onNext} disabled={entities.length === 0}>
            Preview
            <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Preview
// ---------------------------------------------------------------------------

function StepPreview({
  entities,
  apiUrl,
  credentials,
  onNext,
  onBack,
}: {
  entities: WizardEntityResult[];
  apiUrl: string;
  credentials: RequestCredentials;
  onNext: () => void;
  onBack: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState<{
    question: string;
    semanticContext: string;
    availableTables: string[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function handlePreview() {
    if (!question.trim()) return;
    setLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/wizard/preview`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          entities: entities.map((e) => ({ tableName: e.tableName, yaml: e.yaml })),
        }),
      });
      if (res.ok) {
        setPreview(await res.json());
      } else {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        setPreviewError(data.message || "Preview request failed");
      }
    } catch (err) {
      // intentionally ignored: preview is optional, non-blocking step
      console.debug("Wizard preview error:", err instanceof Error ? err.message : String(err));
      setPreviewError("Network error — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview Agent Behavior</CardTitle>
        <CardDescription>
          Try asking a question to see how the agent will use your semantic layer.
          This step is optional.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-4">
          <h4 className="text-sm font-medium mb-2">Your semantic layer includes:</h4>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((e) => (
              <Badge key={e.tableName} variant="outline" className="font-mono text-xs">
                {e.tableName}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {entities.length} entities, {entities.reduce((sum, e) => sum + e.columnCount, 0)} total columns
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Try a question, e.g. 'How many orders by status?'"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handlePreview()}
          />
          <Button onClick={handlePreview} disabled={!question.trim() || loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          </Button>
        </div>

        {previewError && (
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {previewError}
          </div>
        )}

        {preview && (
          <div className="rounded-lg border p-4 space-y-2">
            <p className="text-sm font-medium">Agent would see:</p>
            <p className="text-sm text-muted-foreground">{preview.semanticContext}</p>
            <div className="flex flex-wrap gap-1">
              {preview.availableTables.map((t) => (
                <Badge key={t} variant="secondary" className="font-mono text-xs">{t}</Badge>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="mr-1 size-4" />
            Back
          </Button>
          <Button onClick={onNext}>
            Save & Finish
            <CheckCircle2 className="ml-1 size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Done
// ---------------------------------------------------------------------------

function StepDone({ entityCount }: { entityCount: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="rounded-full bg-green-500/10 p-4">
          <CheckCircle2 className="size-10 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold">Semantic Layer Ready</h2>
        <p className="text-center text-muted-foreground max-w-md">
          {entityCount} entities have been saved. Atlas can now understand and query your data.
          You can refine the semantic layer anytime from the admin console.
        </p>
        <div className="flex gap-3 pt-2">
          <Button variant="outline" asChild>
            <a href="/admin/semantic">View Entities</a>
          </Button>
          <Button asChild>
            <a href="/">Start Chatting</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Wizard Page
// ---------------------------------------------------------------------------

export default function WizardPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [params, setParams] = useQueryStates(wizardSearchParams);
  const step = params.step;

  // Wizard state
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
        setSaveError(data.message || "Save failed");
        return;
      }
      goTo(5);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-12">
      <div className="pt-8 pb-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Setup Wizard</h1>
        <p className="mt-1 text-muted-foreground">
          Configure your semantic layer in a few steps
        </p>
      </div>

      <StepIndicator currentStep={step} />

      {saveError && (
        <div className="mb-4 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      {step === 1 && (
        <StepDatasource
          selectedConnectionId={connectionId}
          onConnectionChange={(id) => setConnectionId(id)}
          onNext={() => goTo(2)}
        />
      )}

      {step === 2 && (
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

      {step === 3 && (
        <StepReview
          connectionId={connectionId}
          selectedTables={selectedTables}
          apiUrl={apiUrl}
          credentials={credentials}
          entities={entities}
          setEntities={setEntities}
          onNext={() => goTo(4)}
          onBack={() => goTo(2)}
        />
      )}

      {step === 4 && (
        <StepPreview
          entities={entities}
          apiUrl={apiUrl}
          credentials={credentials}
          onNext={() => {
            if (!saving) handleSave();
          }}
          onBack={() => goTo(3)}
        />
      )}

      {step === 5 && <StepDone entityCount={entities.length} />}

      {saving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg border bg-card p-6 shadow-lg">
            <Loader2 className="size-5 animate-spin" />
            <span>Saving semantic layer...</span>
          </div>
        </div>
      )}
    </div>
  );
}
