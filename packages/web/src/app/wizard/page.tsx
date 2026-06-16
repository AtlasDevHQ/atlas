"use client";

import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type {
  ConnectionInfo,
  ProfileError,
  WizardTableEntry,
  WizardEntityResult,
  WizardEnrichResult,
} from "@/ui/lib/types";
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
  errorFromBody,
  type WizardError,
  type ApiErrorBody,
} from "./wizard-helpers";
import {
  ENRICH_CONCURRENCY,
  type EnrichRowStatus,
  seedIgnoredTables,
  enrichableTables,
  excludeIgnored,
  runWithConcurrency,
} from "./wizard-enrich";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileCode,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Table as TableLucide,
  TableIcon,
  XCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Error UI shared across steps
// ---------------------------------------------------------------------------

function ErrorBanner({ error }: { error: WizardError }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p>{error.message}</p>
        {error.requestId && (
          <p className="font-mono text-[11px] opacity-80">
            requestId: {error.requestId}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Warn that some tables could NOT be profiled and will be ABSENT from the saved
 * semantic layer — the agent won't be able to query them (#3682). The `/generate`
 * step returns these below the fatal threshold; surfacing them here makes the
 * partial state unmissable before the user saves and publishes.
 */
function PartialProfileBanner({ errors }: { errors: ProfileError[] }) {
  if (errors.length === 0) return null;
  const preview = errors.slice(0, 5);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">
          {errors.length} {errors.length === 1 ? "table" : "tables"} could not be profiled and{" "}
          {errors.length === 1 ? "is" : "are"} NOT queryable
        </p>
        <p className="opacity-90">
          These tables failed introspection (often a permission gap) and are excluded from the
          generated layer. Fix access and re-run the wizard to include them.
        </p>
        <ul className="list-disc space-y-0.5 pl-4 font-mono text-[11px] opacity-80">
          {preview.map((e) => (
            <li key={e.table}>
              {e.table}: {e.error}
            </li>
          ))}
          {errors.length > preview.length && (
            <li>… and {errors.length - preview.length} more</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * Read a non-OK response body as JSON. Logs (not silently swallows) when the
 * server returns non-JSON (e.g. an HTML 500 page from a misconfigured proxy)
 * so ops can see the version drift.
 */
async function readErrorBody(res: Response, label: string): Promise<ApiErrorBody> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch (parseErr) {
    console.warn(
      `[wizard] non-JSON ${label} error body (status ${res.status}):`,
      parseErr instanceof Error ? parseErr.message : String(parseErr),
    );
    return {};
  }
}

/** Thin `Response`-aware wrapper over the pure {@link errorFromBody}. */
function errorFromResponse(
  res: Response,
  body: ApiErrorBody,
  fallback: string,
): WizardError {
  return errorFromBody(res.status, body, fallback);
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
          <ErrorBanner
            error={{
              message: `Couldn't load your saved connections. ${error.message}`,
            }}
          />
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
  const [error, setError] = useState<WizardError | null>(null);
  const [filterText, setFilterText] = useState("");

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
          const body = await readErrorBody(res, "profile");
          console.warn("[wizard] profile failed:", {
            status: res.status,
            requestId: body.requestId,
            message: body.message,
          });
          setError(errorFromResponse(res, body, "Couldn't list tables. Try again in a moment."));
          return;
        }
        const data = await res.json();
        const fetched = (data.tables ?? []) as WizardTableEntry[];
        setTables(fetched);
        // Seed selection with every table the first time this connection's
        // tables load. Only seeds when the parent's `selectedTables` is empty
        // so a back-navigation that already has a saved selection doesn't
        // clobber the user's deselections.
        if (selectedTables.length === 0) {
          setSelectedTables(fetched.map((t) => t.name));
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(
            "[wizard] profile error:",
            err instanceof Error ? err.message : String(err),
          );
          setError({
            message: userMessageFor(err, "Couldn't list tables. Try again in a moment."),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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
          <ErrorBanner error={error} />
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

/**
 * Outcome of one table's enrichment request. The fetch helper never throws —
 * it maps every failure into an `error` outcome — so the concurrency runner's
 * onSettled gets a single, exhaustive shape per row.
 */
type EnrichOutcome =
  | { kind: "ok"; yaml: string; enriched: boolean }
  | { kind: "skipped" }
  | { kind: "error"; message: string; requestId?: string; unavailable: boolean };

function StepReview({
  connectionId,
  selectedTables,
  apiUrl,
  credentials,
  onNext,
  onBack,
  entities,
  setEntities,
  profilingErrors,
  setProfilingErrors,
  ignored,
  setIgnored,
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
  setEntities: Dispatch<SetStateAction<WizardEntityResult[]>>;
  profilingErrors: ProfileError[];
  setProfilingErrors: Dispatch<SetStateAction<ProfileError[]>>;
  ignored: Set<string>;
  setIgnored: Dispatch<SetStateAction<Set<string>>>;
  saving: boolean;
  saveError: WizardError | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<WizardError | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [editingYaml, setEditingYaml] = useState<Record<string, string>>({});

  // Phase-2 enrichment state. All transient (rebuilt per visit): the durable
  // result of enrichment is the upgraded YAML in `entities`, not these badges.
  const [enrichStatus, setEnrichStatus] = useState<Record<string, EnrichRowStatus>>({});
  const [enrichRowError, setEnrichRowError] = useState<Record<string, string>>({});
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<WizardError | null>(null);
  const [selectedForEnrich, setSelectedForEnrich] = useState<Set<string>>(new Set());
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

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
          const body = await readErrorBody(res, "generate");
          console.warn("[wizard] generate failed:", {
            status: res.status,
            requestId: body.requestId,
            message: body.message,
          });
          setError(errorFromResponse(res, body, "Couldn't profile the tables. Try again in a moment."));
          return;
        }
        const data = await res.json();
        const generated = (data.entities ?? []) as WizardEntityResult[];
        setEntities(generated);
        // #3682 — capture the sub-threshold per-table failures so the review
        // step warns about them and the save forwards them as the durable
        // partial-profile marker.
        setProfilingErrors((data.errors ?? []) as ProfileError[]);
        const yamlMap: Record<string, string> = {};
        for (const entity of generated) yamlMap[entity.tableName] = entity.yaml;
        setEditingYaml(yamlMap);
        // Pre-seed the ignore list from the profiler's possibly-abandoned signal
        // (§ D) so the user confirms exclusions rather than hunting for them.
        setIgnored(new Set(seedIgnoredTables(generated)));
      } catch (err) {
        if (!cancelled) {
          console.warn(
            "[wizard] generate error:",
            err instanceof Error ? err.message : String(err),
          );
          setError({
            message: userMessageFor(err, "Couldn't profile the tables. Try again in a moment."),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleYamlChange(tableName: string, yaml: string) {
    setEditingYaml((prev) => ({ ...prev, [tableName]: yaml }));
    // Functional update so concurrent enrichment settles don't clobber each
    // other via a stale `entities` closure.
    setEntities((prev) => prev.map((e) => (e.tableName === tableName ? { ...e, yaml } : e)));
  }

  /**
   * Apply an enrichment result, but only if the row still holds the exact YAML
   * we sent (`snapshot`). If the user hand-edited the row while the request was
   * in flight, their edit wins — the stale enrichment is dropped rather than
   * silently overwriting their work.
   */
  function applyEnrichedYaml(tableName: string, yaml: string, snapshot: string | undefined) {
    setEntities((prev) =>
      prev.map((e) =>
        e.tableName === tableName && (snapshot === undefined || e.yaml === snapshot)
          ? { ...e, yaml }
          : e,
      ),
    );
    setEditingYaml((prev) => {
      const cur = prev[tableName];
      if (snapshot !== undefined && cur !== undefined && cur !== snapshot) return prev;
      return { ...prev, [tableName]: yaml };
    });
  }

  function toggleIgnore(tableName: string) {
    setIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
    // An ignored table can't be a target — drop it from the enrich selection.
    setSelectedForEnrich((prev) => {
      if (!prev.has(tableName)) return prev;
      const next = new Set(prev);
      next.delete(tableName);
      return next;
    });
  }

  function toggleEnrichSelect(tableName: string) {
    setSelectedForEnrich((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  }

  /**
   * Fetch enrichment for one table. Never throws: every failure becomes an
   * `error` outcome so the runner can settle the row uniformly. A 503 is the
   * "no provider configured" signal — flagged `unavailable` so the caller can
   * abort the rest of the batch and show one banner.
   */
  async function enrichOne(tableName: string, yaml: string): Promise<EnrichOutcome> {
    try {
      const res = await fetch(`${apiUrl}/api/v1/wizard/enrich`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, tableName, yaml }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res, "enrich");
        console.warn("[wizard] enrich failed:", {
          table: tableName,
          status: res.status,
          requestId: body.requestId,
          message: body.message,
        });
        // 503 = no provider configured. The server's message is deployment
        // guidance (path/secret-free) — show it verbatim rather than collapsing
        // it to the generic fallback via userMessageFor.
        if (res.status === 503) {
          const message =
            typeof body.message === "string" && body.message
              ? body.message
              : "Enrichment needs a configured LLM provider. Save the mechanical baseline as-is, or configure a provider in admin.";
          const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
          return { kind: "error", message, requestId, unavailable: true };
        }
        const mapped = errorFromResponse(res, body, "Couldn't enrich this table.");
        return { kind: "error", message: mapped.message, requestId: mapped.requestId, unavailable: false };
      }
      const data = (await res.json()) as WizardEnrichResult;
      return { kind: "ok", yaml: data.yaml, enriched: data.enriched };
    } catch (err) {
      console.warn(
        "[wizard] enrich error:",
        tableName,
        err instanceof Error ? err.message : String(err),
      );
      return {
        kind: "error",
        message: userMessageFor(err, "Couldn't enrich this table."),
        unavailable: false,
      };
    }
  }

  /**
   * Enrich a set of tables with bounded concurrency, upgrading each row in
   * place as its result settles (§ D streaming). Each table is independent, so
   * partial completion is safe — a failure (or the whole-batch abort on a
   * missing provider) leaves the rest of the rows on their mechanical baseline.
   */
  async function runEnrich(targets: string[]) {
    if (enriching || targets.length === 0) return;
    setEnriching(true);
    setEnrichError(null);
    setEnrichStatus((prev) => {
      const next = { ...prev };
      for (const t of targets) next[t] = "enriching";
      return next;
    });
    setEnrichRowError((prev) => {
      const next = { ...prev };
      for (const t of targets) delete next[t];
      return next;
    });

    // Snapshot the YAML to send now so concurrent settles don't read mutated
    // state, and so a hand-edit made mid-run isn't silently sent.
    const yamlByTable = new Map(entities.map((e) => [e.tableName, e.yaml]));
    // Once a 503 proves the provider is unconfigured, skip the remaining
    // tables rather than firing N doomed requests.
    const aborted = { current: false };

    await runWithConcurrency(
      targets,
      ENRICH_CONCURRENCY,
      async (tableName): Promise<EnrichOutcome> => {
        if (aborted.current) return { kind: "skipped" };
        const outcome = await enrichOne(tableName, yamlByTable.get(tableName) ?? "");
        if (outcome.kind === "error" && outcome.unavailable) aborted.current = true;
        return outcome;
      },
      (tableName, outcome, workerError) => {
        // The task catches its own errors, so workerError should be undefined —
        // but never silently swallow an unexpected throw (CLAUDE.md error rule).
        if (workerError) {
          const message =
            workerError instanceof Error ? workerError.message : String(workerError);
          console.warn("[wizard] enrich worker error:", tableName, message);
          setEnrichStatus((prev) => ({ ...prev, [tableName]: "error" }));
          setEnrichRowError((prev) => ({
            ...prev,
            [tableName]: userMessageFor(workerError, "Couldn't enrich this table."),
          }));
          return;
        }
        if (!outcome || outcome.kind === "skipped") {
          setEnrichStatus((prev) => ({ ...prev, [tableName]: "idle" }));
          return;
        }
        if (outcome.kind === "error") {
          setEnrichStatus((prev) => ({ ...prev, [tableName]: "error" }));
          setEnrichRowError((prev) => ({ ...prev, [tableName]: outcome.message }));
          if (outcome.unavailable) {
            setEnrichError({ message: outcome.message, requestId: outcome.requestId });
          }
          return;
        }
        // Model ran but returned nothing usable → keep the baseline, don't badge
        // it "enriched" (would mislead which rows still need attention).
        if (!outcome.enriched) {
          setEnrichStatus((prev) => ({ ...prev, [tableName]: "unchanged" }));
          return;
        }
        setEnrichStatus((prev) => ({ ...prev, [tableName]: "enriched" }));
        // Apply only if the row still matches the YAML we sent — a manual edit
        // made mid-flight wins over the stale enrichment (no silent clobber).
        applyEnrichedYaml(tableName, outcome.yaml, yamlByTable.get(tableName));
      },
    );

    setEnriching(false);
  }

  const enrichAllTargets = enrichableTables(entities, ignored);
  const selectedTargets = excludeIgnored([...selectedForEnrich], ignored);

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
          <ErrorBanner error={error} />
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
        {saveError && <ErrorBanner error={saveError} />}
        {enrichError && <ErrorBanner error={enrichError} />}
        <PartialProfileBanner errors={profilingErrors} />

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
          <div className="min-w-0 space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              Enrich with AI
              <span className="font-normal text-muted-foreground">· optional</span>
            </p>
            <p className="text-xs text-muted-foreground">
              The baseline below is ready to save now. Enrichment runs an LLM per table to add
              descriptions, use cases, and query patterns — it reads your database to ground the
              output and may incur model costs.
              {ignored.size > 0 &&
                ` ${ignored.size} low-signal ${ignored.size === 1 ? "table is" : "tables are"} pre-ignored.`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runEnrich(selectedTargets)}
              disabled={enriching || selectedTargets.length === 0}
            >
              {enriching ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="mr-1 size-4" aria-hidden="true" />
              )}
              Enrich selected{selectedTargets.length > 0 ? ` (${selectedTargets.length})` : ""}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setConfirmAllOpen(true)}
              disabled={enriching || enrichAllTargets.length === 0}
            >
              <Sparkles className="mr-1 size-4" aria-hidden="true" />
              Enrich all ({enrichAllTargets.length})
            </Button>
          </div>
        </div>

        <AlertDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Enrich {enrichAllTargets.length}{" "}
                {enrichAllTargets.length === 1 ? "table" : "tables"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This runs an LLM over{" "}
                {enrichAllTargets.length === 1
                  ? "this table"
                  : `each of these ${enrichAllTargets.length} tables`}{" "}
                to add descriptions, use cases, query patterns, and metrics. It reads from your
                database to ground the output and may incur model costs. Ignored tables are skipped.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmAllOpen(false);
                  runEnrich(enrichAllTargets);
                }}
              >
                Enrich {enrichAllTargets.length}{" "}
                {enrichAllTargets.length === 1 ? "table" : "tables"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <ul className="max-h-[600px] space-y-2 overflow-auto pr-1">
          {entities.map((entity) => {
            const isExpanded = expandedEntity === entity.tableName;
            const profile = entity.profile;
            const isIgnored = ignored.has(entity.tableName);
            const status: EnrichRowStatus = enrichStatus[entity.tableName] ?? "idle";
            const rowError = enrichRowError[entity.tableName];
            const toggleExpand = () =>
              setExpandedEntity(isExpanded ? null : entity.tableName);
            return (
              <li
                key={entity.tableName}
                className={cn("overflow-hidden rounded-lg border", isIgnored && "opacity-60")}
              >
                <div className="flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Checkbox
                    checked={selectedForEnrich.has(entity.tableName)}
                    onCheckedChange={() => toggleEnrichSelect(entity.tableName)}
                    disabled={isIgnored || enriching}
                    aria-label={`Select ${entity.tableName} for enrichment`}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={toggleExpand}
                    aria-expanded={isExpanded}
                    aria-controls={`entity-${entity.tableName}`}
                  >
                    <TableIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate font-mono text-sm font-medium">
                      {entity.tableName}
                    </span>
                    {isIgnored && (
                      <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                        Ignored
                      </Badge>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {status === "enriching" && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        Enriching…
                      </span>
                    )}
                    {status === "enriched" && (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Sparkles className="size-3" aria-hidden="true" />
                        Enriched
                      </Badge>
                    )}
                    {status === "unchanged" && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              No changes
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            The model returned nothing usable — this row kept its mechanical baseline. You can retry.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {status === "error" && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="gap-1 text-[10px]">
                              <XCircle className="size-3" aria-hidden="true" />
                              Couldn&apos;t enrich
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {rowError ?? "Enrichment failed. The baseline is unchanged — try again."}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {profile.flags.possiblyAbandoned && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="text-[10px]">low signal</Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            Looks abandoned — last write activity was old or row count is low. Pre-ignored; restore it to keep it.
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
                    <span className="text-xs text-muted-foreground">
                      {entity.rowCount.toLocaleString()} rows · {entity.columnCount} cols
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => toggleIgnore(entity.tableName)}
                      disabled={enriching}
                    >
                      {isIgnored ? (
                        <>
                          <RotateCcw className="mr-1 size-3" aria-hidden="true" />
                          Restore
                        </>
                      ) : (
                        <>
                          <Ban className="mr-1 size-3" aria-hidden="true" />
                          Ignore
                        </>
                      )}
                    </Button>
                    <button
                      type="button"
                      className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={toggleExpand}
                      aria-label={isExpanded ? `Collapse ${entity.tableName}` : `Expand ${entity.tableName}`}
                    >
                      <ChevronRight
                        className={cn(
                          "size-4 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90",
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </div>

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
                          // Locked while this row is enriching so an in-flight
                          // edit can't be clobbered by the returning YAML.
                          disabled={status === "enriching"}
                        />
                        {status === "enriching" && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Locked while enriching — editable again when the result lands.
                          </p>
                        )}
                      </div>
                    </details>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack} disabled={saving || enriching}>
            <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
            Back
          </Button>
          <Button onClick={onNext} disabled={enrichAllTargets.length === 0 || saving || enriching}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              <>
                Save {enrichAllTargets.length}{" "}
                {enrichAllTargets.length === 1 ? "entity" : "entities"}
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
  // #3682 — sub-threshold per-table profiling failures from `/generate`; lifted
  // so the save step can forward them as the durable partial-profile marker.
  const [profilingErrors, setProfilingErrors] = useState<ProfileError[]>([]);
  // Tables excluded from enrichment AND from the final save (§ D). Pre-seeded in
  // StepReview from the profiler's possibly-abandoned signal; user-adjustable.
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [saveError, setSaveError] = useState<WizardError | null>(null);

  function goTo(nextStep: number) {
    setParams({ step: nextStep, connectionId });
  }

  // Going back from Review invalidates cached entities — the user may change
  // their table selection, and the regenerate run must reflect the new set.
  // The ignore list is regenerated from the fresh profile, so clear it too.
  function goBackFromReview() {
    setEntities([]);
    setProfilingErrors([]);
    setIgnored(new Set());
    goTo(2);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    // Ignored tables are excluded from the saved layer (§ D, acceptance C3).
    const entitiesToSave = entities.filter((e) => !ignored.has(e.tableName));
    try {
      const res = await fetch(`${apiUrl}/api/v1/wizard/save`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          entities: entitiesToSave.map((e) => ({ tableName: e.tableName, yaml: e.yaml })),
          // #3682 — forward the sub-threshold profiling failures so the saved
          // layer is durably marked incomplete (visible to the publish flow).
          // `totalTables` is everything ATTEMPTED: generated entities + failures.
          failedTables: profilingErrors,
          totalTables: entities.length + profilingErrors.length,
        }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res, "save");
        console.warn("[wizard] save failed:", {
          status: res.status,
          requestId: body.requestId,
          message: body.message,
        });
        setSaveError(errorFromResponse(res, body, "Couldn't save the semantic layer."));
        return;
      }
      setSavedCount(entitiesToSave.length);
      goTo(4);
    } catch (err) {
      console.warn(
        "[wizard] save error:",
        err instanceof Error ? err.message : String(err),
      );
      setSaveError({
        message: userMessageFor(err, "Couldn't save the semantic layer."),
      });
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
          profilingErrors={profilingErrors}
          setProfilingErrors={setProfilingErrors}
          ignored={ignored}
          setIgnored={setIgnored}
          onNext={() => {
            if (!saving) handleSave();
          }}
          onBack={goBackFromReview}
          saving={saving}
          saveError={saveError}
        />
      )}

      {stepId === "done" && (
        <StepDone
          entityCount={savedCount}
          isDemoConnection={connectionId === DEMO_CONNECTION_ID}
        />
      )}
    </OnboardingShell>
  );
}
