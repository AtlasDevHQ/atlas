"use client";

import { useEffect, useState, useTransition } from "react";
import { useQueryStates } from "nuqs";
import {
  semanticSearchParams,
  fileParamToSelection,
  selectionToFileParam,
  selectionToGroupParam,
  withGroupOnSelection,
} from "./search-params";
import { useAtlasConfig } from "@/ui/context";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import { BookOpen, BarChart3, FileText, FolderOpen, Code, LayoutDashboard, Terminal, Plus, Pencil, Trash2, History, Sparkles, Download, DatabaseZap } from "lucide-react";
import Link from "next/link";
import { EntityDetail, type EntityData } from "@/ui/components/admin/entity-detail";
import {
  EntityEditorDialog,
  formValuesToEntityBody,
} from "@/ui/components/admin/entity-editor-dialog";
import { EmptyState } from "@/ui/components/admin/empty-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { AdminContentWrapper } from "@/ui/components/admin-content-wrapper";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import {
  SemanticFileTree,
  type SemanticSelection,
  type SemanticTreeDrift,
} from "@/ui/components/admin/semantic-file-tree";
import { normalizeDrift } from "./normalize-drift";
import { type FetchError } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyErrorOrNull, buildFetchError, extractFetchError } from "@/ui/lib/fetch-error";
import { useDeployMode } from "@/ui/hooks/use-deploy-mode";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { EntityVersionHistory } from "@/ui/components/admin/entity-version-history";
import { SemanticHealthWidget } from "@/ui/components/admin/semantic-health-widget";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDemoReadonly, demoIndustryLabel } from "@/ui/hooks/use-demo-readonly";
import { useDevModeNoDrafts } from "@/ui/hooks/use-dev-mode-no-drafts";
import { DeveloperEmptyState } from "@/ui/components/admin/developer-empty-state";
import { SemanticPublishedBanner } from "@/ui/components/admin/semantic-published-banner";
import { DriftDrawer } from "@/ui/components/admin/drift-drawer";
import { driftDrawerTargetFor } from "./drift-routing";

// ── Types ─────────────────────────────────────────────────────────

interface EntitySummary {
  /** Display name — the YAML `name:` if present, otherwise the table. */
  name: string;
  table: string;
  description: string;
  columnCount: number;
  /**
   * `connection_group_id` for the entity row (#2340 / #2412). Multi-
   * group orgs surface the same `name` under multiple groups; the file
   * tree keys on `(name, connectionGroupId)` to render one row per
   * environment with the group badge. `null` is the legacy / unscoped
   * row (`__global__` demo + pre-backfill data).
   */
  connectionGroupId: string | null;
  /** True when the API row carries `status: "draft"`. */
  draft: boolean;
  /**
   * Optional DB↔YAML drift signal (#2459). `null` when the API didn't
   * compute drift (e.g. caller omitted `?connection`); a defined value
   * is what slice 1 surfaces as the blue file-tree accent.
   */
  drift: SemanticTreeDrift | null;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  ambiguous?: boolean;
  tables?: string[];
}

interface MetricEntry {
  name: string;
  description?: string;
  sql: string;
  entity?: string;
  type?: string;
  file?: string;
}

interface CatalogMeta {
  name?: string;
  description?: string;
  use_for?: string[];
  common_questions?: string[];
}

// ── Content viewers ───────────────────────────────────────────────

function CatalogViewer({ catalog }: { catalog: CatalogMeta | null }) {
  if (!catalog) {
    return (
      <EmptyState icon={FileText} message="No catalog metadata found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a catalog,
          or create <code className="rounded bg-muted px-1 py-0.5">semantic/catalog.yml</code> manually.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      {catalog.name && (
        <div>
          <h3 className="text-sm font-semibold">Name</h3>
          <p className="mt-1 text-sm text-muted-foreground">{catalog.name}</p>
        </div>
      )}
      {catalog.description && (
        <div>
          <h3 className="text-sm font-semibold">Description</h3>
          <p className="mt-1 text-sm text-muted-foreground">{catalog.description}</p>
        </div>
      )}
      {catalog.use_for && catalog.use_for.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Use For</h3>
          <div className="flex flex-wrap gap-1.5">
            {catalog.use_for.map((use) => (
              <Badge key={use} variant="secondary">{use}</Badge>
            ))}
          </div>
        </div>
      )}
      {catalog.common_questions && catalog.common_questions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Common Questions</h3>
          <ul className="space-y-1.5">
            {catalog.common_questions.map((q) => (
              <li key={q} className="text-sm text-muted-foreground">- {q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GlossaryViewer({ glossary }: { glossary: GlossaryTerm[] }) {
  if (glossary.length === 0) {
    return (
      <EmptyState icon={BookOpen} message="No glossary terms found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate a glossary,
          or create <code className="rounded bg-muted px-1 py-0.5">semantic/glossary.yml</code> manually.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {glossary.map((term) => (
        <Card key={term.term} className="shadow-none">
          <CardHeader className="py-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              {term.term}
              {term.ambiguous && (
                <Badge
                  variant="outline"
                  className="text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700 text-[10px]"
                >
                  ambiguous
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <p className="text-xs text-muted-foreground">{term.definition}</p>
            {term.tables && term.tables.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {term.tables.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function MetricsViewer({ metrics }: { metrics: MetricEntry[] }) {
  if (metrics.length === 0) {
    return (
      <EmptyState icon={BarChart3} message="No metrics found">
        <p className="mt-1 text-xs">
          Run <code className="rounded bg-muted px-1 py-0.5">atlas init</code> to generate metrics,
          or add YAML files to <code className="rounded bg-muted px-1 py-0.5">semantic/metrics/</code>.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {metrics.map((metric) => (
        <Card key={metric.name} className="shadow-none">
          <CardHeader className="py-3 pb-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              {metric.name}
              {metric.entity && <Badge variant="secondary" className="text-[10px]">{metric.entity}</Badge>}
              {metric.type && <Badge variant="outline" className="text-[10px]">{metric.type}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            {metric.description && (
              <p className="mb-2 text-xs text-muted-foreground">{metric.description}</p>
            )}
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              <code>{metric.sql}</code>
            </pre>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Helpers to normalize API responses ────────────────────────────

function normalizeGlossary(raw: unknown): GlossaryTerm[] {
  if (!raw || !Array.isArray(raw)) return [];
  const terms: GlossaryTerm[] = [];
  for (const entry of raw) {
    const data = (entry as { data: unknown })?.data;
    if (Array.isArray(data)) {
      terms.push(...(data as GlossaryTerm[]));
    } else if (data && typeof data === "object") {
      const t = (data as { terms?: unknown }).terms;
      if (Array.isArray(t)) {
        terms.push(...(t as GlossaryTerm[]));
      } else if (t && typeof t === "object") {
        // terms is an object map: { MRR: { status, definition, ... }, ... }
        for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
          if (value && typeof value === "object") {
            const v = value as Record<string, unknown>;
            terms.push({
              term: name,
              definition: typeof v.definition === "string" ? v.definition
                : typeof v.note === "string" ? v.note : "",
              ambiguous: v.status === "ambiguous",
              tables: Array.isArray(v.tables) ? v.tables as string[]
                : Array.isArray(v.possible_mappings) ? v.possible_mappings as string[] : undefined,
            });
          }
        }
      }
    }
  }
  return terms;
}

function toMetricEntry(m: unknown): MetricEntry | null {
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  // YAML metrics use id/label; normalize to name
  const name = typeof r.name === "string" ? r.name
    : typeof r.label === "string" ? r.label
    : typeof r.id === "string" ? r.id : null;
  if (!name || typeof r.sql !== "string") return null;
  return {
    name,
    description: typeof r.description === "string" ? r.description : undefined,
    sql: r.sql,
    entity: typeof r.entity === "string" ? r.entity
      : (r.source && typeof r.source === "object" && typeof (r.source as Record<string, unknown>).entity === "string")
        ? (r.source as Record<string, unknown>).entity as string : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

function normalizeMetrics(raw: unknown): MetricEntry[] {
  if (!raw || !Array.isArray(raw)) return [];
  const metrics: MetricEntry[] = [];
  for (const entry of raw) {
    const e = entry as { data: unknown; file?: string };
    const data = e?.data;
    const fileName = typeof e?.file === "string" ? e.file : undefined;
    const items = Array.isArray(data) ? data
      : (data && typeof data === "object" && Array.isArray((data as { metrics?: unknown }).metrics))
        ? (data as { metrics: unknown[] }).metrics : null;
    if (items) {
      for (const m of items) {
        const parsed = toMetricEntry(m);
        if (parsed) {
          parsed.file = parsed.file ?? fileName;
          metrics.push(parsed);
        }
      }
    }
  }
  return metrics;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Encode a `connectionGroupId` for the admin entity detail / delete /
 * save URLs (#2412). The trinary mapping mirrors the backend's
 * `parseConnectionGroupIdQuery`:
 *
 * - `undefined` → no param (backend disambiguates / 409s).
 * - `null` → `?connectionGroupId=` (empty string → null on the backend,
 *   addresses legacy `__global__` rows explicitly).
 * - `string` → `?connectionGroupId=<group>`.
 */
function encodeGroupParam(group: string | null | undefined): string {
  if (group === undefined) return "";
  if (group === null) return "?connectionGroupId=";
  return `?connectionGroupId=${encodeURIComponent(group)}`;
}

/** Map a selection to its raw YAML file path on the semantic/ directory. */
function selectionToRawPath(sel: SemanticSelection): string | null {
  if (!sel) return null;
  switch (sel.type) {
    case "catalog": return "catalog.yml";
    case "glossary": return "glossary.yml";
    case "entity": return `entities/${sel.name}.yml`;
    case "metrics": return sel.file ? `metrics/${sel.file}.yml` : null;
  }
}

type ViewMode = "pretty" | "yaml" | "history";

function ViewToggle({ mode, onChange, showHistory }: { mode: ViewMode; onChange: (m: ViewMode) => void; showHistory?: boolean }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(v) => { if (v) onChange(v as ViewMode); }}
    >
      <ToggleGroupItem value="pretty" className="gap-1.5 text-xs">
        <LayoutDashboard className="size-3" />
        Pretty
      </ToggleGroupItem>
      <ToggleGroupItem value="yaml" className="gap-1.5 text-xs">
        <Code className="size-3" />
        YAML
      </ToggleGroupItem>
      {showHistory && (
        <ToggleGroupItem value="history" className="gap-1.5 text-xs">
          <History className="size-3" />
          History
        </ToggleGroupItem>
      )}
    </ToggleGroup>
  );
}

function RawYamlViewer({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <pre className="p-6 text-xs leading-relaxed font-mono whitespace-pre-wrap">
        <code>{content}</code>
      </pre>
    </ScrollArea>
  );
}

// ── Page ──────────────────────────────────────────────────────────

/** Tooltip text when semantic editor mutations are blocked by published-mode demo readonly. */
const DEMO_READONLY_TOOLTIP = "Switch to developer mode to edit demo semantic entities";

export default function SemanticPage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const { deployMode } = useDeployMode();
  const isSaas = deployMode === "saas";
  const { readOnly: demoReadOnly, demoIndustry } = useDemoReadonly();
  const demoLabel = demoIndustryLabel(demoIndustry);
  const showDevNoDrafts = useDevModeNoDrafts([
    "entities",
    "entityEdits",
    "entityDeletes",
  ]);

  const [entities, setEntities] = useState<EntitySummary[]>([]);
  // Slice 1 (#2459) signal: when the connection introspects zero tables we
  // suppress the file-tree-renders-every-YAML-as-removed UX in favor of a
  // targeted "we couldn't read any tables from this connection" panel
  // (#2462). Initialise to `false` so the file tree renders normally until
  // the entities fetch resolves; flip when the API confirms zero tables.
  const [noIntrospectedTables, setNoIntrospectedTables] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<EntityData | null>(null);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [catalog, setCatalog] = useState<CatalogMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [fetchKey, setFetchKey] = useState(0);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [{ file: fileParam, view: viewMode, group: groupParam }, setParams] = useQueryStates(semanticSearchParams);
  const [, startTransition] = useTransition();
  const selection = withGroupOnSelection(fileParamToSelection(fileParam), groupParam);
  const [rawYaml, setRawYaml] = useState<string | null>(null);
  const [rawYamlLoading, setRawYamlLoading] = useState(false);

  // Editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState<EntityData | null>(null);
  const [editingEntityName, setEditingEntityName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Drift drawer (#2461): opens overlaid when a drifted entity is clicked.
  // The underlying selection still updates so closing the drawer leaves the
  // admin on the entity's detail view. Reconcile actions land in #2462.
  const [driftDrawerEntity, setDriftDrawerEntity] = useState<string | null>(null);
  const [driftDrawerOpen, setDriftDrawerOpen] = useState(false);

  const fetchOpts: RequestInit = {
    credentials: isCrossOrigin ? "include" : "same-origin",
  };

  // Mutations for entity CRUD
  const { mutate: mutateSave, saving: savingEntity, error: saveError, reset: resetSave } = useAdminMutation({
    method: "PUT",
  });
  const { mutate: mutateDelete, saving: deletingEntity, error: deleteError } = useAdminMutation({
    method: "DELETE",
  });

  // Import from disk: bulk-syncs the workspace's per-org disk dir into the
  // entities DB. Recovery tool for legacy workspaces (#2144) — after #2142
  // the wizard + demo flows populate the DB themselves, but operators still
  // need a manual sync surface for orgs created pre-fix.
  type ImportResult = {
    imported: number;
    skipped: number;
    total: number;
    errors?: Array<{ file: string; reason: string }>;
  };
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const { mutate: mutateImport, saving: importing, error: importError } = useAdminMutation<ImportResult>({
    path: "/api/v1/admin/semantic/org/import",
    method: "POST",
    invalidates: () => setFetchKey((k) => k + 1),
  });

  const refetchAll = () => setFetchKey((k) => k + 1);

  const runImport = async () => {
    const result = await mutateImport();
    if (result.ok && result.data) {
      setImportResult(result.data);
    }
  };

  // Fetch all semantic data.
  //
  // `/admin/semantic/entities` is the unified DB-overlay-aware list: it
  // merges org-scoped DB rows with disk entities, applies the developer-
  // mode overlay + connection-visibility rules, and returns the same
  // shape on SaaS and self-hosted. List and detail read from the same
  // source so a draft entity in the tree always resolves on click.
  //
  // Glossary / metrics / catalog stay disk-based for now: those aren't
  // yet org-scoped in the DB schema, so until the broader migration
  // they're shared per-deployment content. Tracked separately.
  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      // Slice 1 (#2459): `?connection=default` opts into per-entity drift +
      // the noIntrospectedTables flag. The multi-environment toggle (slice 4)
      // will swap in the selected connection id; for now everything on this
      // page runs against the default connection.
      const entitiesUrl = `${apiUrl}/api/v1/admin/semantic/entities?connection=default`;
      const [entitiesRes, glossaryRes, metricsRes, catalogRes] = await Promise.allSettled([
        fetch(entitiesUrl, fetchOpts).then(async (r) => {
          if (!r.ok) throw await extractFetchError(r);
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/glossary`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/metrics`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${apiUrl}/api/v1/admin/semantic/catalog`, fetchOpts).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      ]);

      if (cancelled) return;

      if (entitiesRes.status === "fulfilled") {
        const data = entitiesRes.value;
        const rawEntities = Array.isArray(data?.entities) ? data.entities : Array.isArray(data) ? data : [];
        const normalized: EntitySummary[] = (rawEntities as Record<string, unknown>[]).map((e) => {
          const tableField = typeof e.table === "string" ? e.table : "";
          const nameField =
            typeof e.name === "string" && e.name
              ? e.name
              : tableField;
          // `connectionId` is the server's group-id slot (named that way
          // because the response shape predates the rename). `null` /
          // missing → legacy unscoped row. (#2412)
          const rawGroup = e.connectionId;
          const connectionGroupId =
            typeof rawGroup === "string" && rawGroup.length > 0 ? rawGroup : null;
          return {
            name: nameField,
            table: tableField || nameField,
            description: typeof e.description === "string" ? e.description : "",
            columnCount: typeof e.columnCount === "number" ? e.columnCount : 0,
            connectionGroupId,
            draft: e.status === "draft",
            drift: normalizeDrift(e.drift),
          };
        }).filter((e) => e.name.length > 0);
        const dropped = rawEntities.length - normalized.length;
        if (dropped > 0) {
          // Silent shape-drops would mask a server-side `entities` schema
          // regression (e.g. a renamed `name` column) and make a healthy
          // workspace look empty. Surface in dev tools at minimum.
          console.debug(
            `admin/semantic: dropped ${dropped} entities with unrecognized shape from /api/v1/admin/semantic/entities`,
          );
        }
        // The drift route returns 200-with-warnings when the diff itself
        // fails (DB outage, unsupported driver). Without surfacing them
        // the file tree looks "clean" and an operator can't tell drift is
        // unavailable. Slice 3 will land a proper banner; for now console
        // is the minimum-viable signal that something's wrong.
        const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
        if (warnings.length > 0) {
          console.warn("admin/semantic: drift warnings from /api/v1/admin/semantic/entities", warnings);
        }
        setEntities(normalized);
        // Slice 1 (#2459) → slice 3 (#2462) consumer. The flag is
        // load-bearing: without it every YAML row renders as "removed"
        // when the DB itself has zero tables (the 2026-05-16 dogfood
        // false-positive). We trust the server's resolution rather
        // than re-deriving — `drift.ts` already separates the
        // "DB has no tables" vs "whitelist excluded every table" cases.
        setNoIntrospectedTables(data?.noIntrospectedTables === true);
      } else {
        // `extractFetchError` returns a populated `FetchError`; any other
        // rejection (network abort, JSON parse failure inside .then) gets
        // wrapped so the banner has a non-empty message + status.
        const reason = entitiesRes.reason;
        const isFetchError = reason && typeof reason === "object"
          && typeof (reason as { message?: unknown }).message === "string"
          && (reason as { message: string }).message.length > 0;
        setError(isFetchError
          ? (reason as FetchError)
          : buildFetchError({ message: reason instanceof Error ? reason.message : String(reason) }));
      }

      if (glossaryRes.status === "fulfilled") {
        const data = glossaryRes.value;
        setGlossary(normalizeGlossary(data?.glossary ?? data));
      } else {
        console.warn("Failed to load glossary:", glossaryRes.reason instanceof Error ? glossaryRes.reason.message : String(glossaryRes.reason));
      }
      if (metricsRes.status === "fulfilled") {
        const data = metricsRes.value;
        setMetrics(normalizeMetrics(data?.metrics ?? data));
      } else {
        console.warn("Failed to load metrics:", metricsRes.reason instanceof Error ? metricsRes.reason.message : String(metricsRes.reason));
      }
      if (catalogRes.status === "fulfilled") {
        const data = catalogRes.value;
        setCatalog(data?.catalog ?? data ?? null);
      } else {
        console.warn("Failed to load catalog:", catalogRes.reason instanceof Error ? catalogRes.reason.message : String(catalogRes.reason));
      }
    }

    fetchAll().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiUrl, fetchKey]);

  const handleSelect = (sel: SemanticSelection) => {
    startTransition(() => {
      setParams({
        file: selectionToFileParam(sel),
        view: "pretty",
        group: selectionToGroupParam(sel),
      });
    });
    // #2461: opening the drift drawer on click for drifted entities.
    // We piggy-back on the existing selection update — closing the drawer
    // returns to the regular entity detail view, no extra navigation needed.
    const driftTarget = driftDrawerTargetFor(sel, entities);
    if (driftTarget) {
      setDriftDrawerEntity(driftTarget);
      setDriftDrawerOpen(true);
    }
  };

  // Fetch entity detail when selection changes (including from URL on mount)
  useEffect(() => {
    if (selection?.type !== "entity") {
      setSelectedEntity(null);
      return;
    }

    let cancelled = false;
    setDetailError(null);
    setSelectedEntity(null);

    const detailUrl = `${apiUrl}/api/v1/admin/semantic/entities/${encodeURIComponent(selection.name)}${encodeGroupParam(selection.connectionGroupId)}`;
    fetch(detailUrl, fetchOpts)
      .then(async (r) => {
        // The backend's 500 response carries a tagged message + requestId
        // (`extractFetchError` reads both). Surfacing them lets the user
        // give support a correlation id instead of "HTTP 500".
        if (!r.ok) throw await extractFetchError(r);
        return r.json();
      })
      .then((data) => { if (!cancelled) setSelectedEntity(data?.entity ?? data); })
      .catch((err) => {
        if (cancelled) return;
        const message = err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : err instanceof Error ? err.message : "Network error";
        const requestId = err && typeof err === "object" && typeof (err as { requestId?: unknown }).requestId === "string"
          ? (err as { requestId: string }).requestId
          : undefined;
        setDetailError(
          requestId
            ? `Failed to load "${selection.name}": ${message} (Request ID: ${requestId})`
            : `Failed to load "${selection.name}": ${message}`,
        );
      });

    return () => { cancelled = true; };
  }, [fileParam, groupParam, apiUrl]);

  // Reset raw YAML when file changes
  useEffect(() => {
    setRawYaml(null);
  }, [fileParam, groupParam]);

  // Fetch raw YAML when switching to YAML view
  useEffect(() => {
    if (viewMode !== "yaml" || !selection) return;
    if (rawYaml !== null) return; // already fetched

    const rawPath = selectionToRawPath(selection);
    if (!rawPath) {
      setRawYaml("# No YAML file for this selection");
      return;
    }

    let cancelled = false;
    setRawYamlLoading(true);
    fetch(`${apiUrl}/api/v1/admin/semantic/raw/${rawPath}`, fetchOpts)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => { if (!cancelled) setRawYaml(text); })
      .catch((err) => {
        if (!cancelled) setRawYaml(`# Failed to load: ${err instanceof Error ? err.message : "unknown error"}`);
      })
      .finally(() => { if (!cancelled) setRawYamlLoading(false); });

    return () => { cancelled = true; };
  }, [viewMode, selection, rawYaml, apiUrl]);

  // ── Editor handlers ──────────────────────────────────────────

  const handleAddEntity = () => {
    setEditingEntity(null);
    setEditingEntityName(null);
    resetSave();
    setEditorOpen(true);
  };

  const handleEditEntity = () => {
    if (!selectedEntity || selection?.type !== "entity") return;
    setEditingEntity(selectedEntity);
    setEditingEntityName(selection.name);
    resetSave();
    setEditorOpen(true);
  };

  const handleSaveEntity = async (
    name: string,
    body: ReturnType<typeof formValuesToEntityBody>,
  ) => {
    const result = await mutateSave({
      path: `/api/v1/admin/semantic/entities/edit/${encodeURIComponent(name)}`,
      body: body as unknown as Record<string, unknown>,
    });
    if (result.ok) {
      setEditorOpen(false);
      refetchAll();
      // Navigate to the new/updated entity
      startTransition(() => {
        setParams({ file: `entities/${name}`, view: "pretty" });
      });
    }
  };

  const handleDeleteEntity = async () => {
    if (!deleteTarget) return;
    const groupSuffix =
      selection?.type === "entity"
        ? encodeGroupParam(selection.connectionGroupId)
        : "";
    const result = await mutateDelete({
      path: `/api/v1/admin/semantic/entities/edit/${encodeURIComponent(deleteTarget)}${groupSuffix}`,
    });
    if (result.ok) {
      setDeleteTarget(null);
      refetchAll();
      // Clear selection if deleted entity was selected
      if (selection?.type === "entity" && selection.name === deleteTarget) {
        startTransition(() => {
          setParams({ file: null, view: "pretty", group: null });
        });
      }
    }
  };

  // Sort matches the backend's mergeAdminEntities order so paging is
  // stable across server/client (#2412).
  const treeEntities = entities
    .map((e) => ({
      name: e.name,
      connectionGroupId: e.connectionGroupId,
      draft: e.draft,
      drift: e.drift,
    }))
    .toSorted((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      const ag = a.connectionGroupId ?? "";
      const bg = b.connectionGroupId ?? "";
      return ag.localeCompare(bg);
    });
  const metricFileNames = (() => {
    const files = new Set<string>();
    for (const m of metrics) {
      if (m.file) files.add(m.file);
    }
    return [...files].toSorted();
  })();

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Semantic Layer</h1>
            <p className="text-sm text-muted-foreground">
              {demoLabel
                ? `${demoLabel} \u2014 ${entities.length} ${entities.length === 1 ? "entity" : "entities"}`
                : isSaas
                  ? "Manage entities, glossary, metrics, and catalog"
                  : "Browse entities, glossary, metrics, and catalog"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin/semantic/improve">
              <Button variant="outline" className="gap-1.5">
                <Sparkles className="size-4" />
                Improve
              </Button>
            </Link>
            {isSaas && entities.length === 0 && (
              <Button
                variant="outline"
                className="gap-1.5"
                disabled={importing}
                onClick={runImport}
              >
                <Download className="size-4" />
                {importing ? "Importing..." : "Import from disk"}
              </Button>
            )}
            {isSaas && (demoReadOnly ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button onClick={handleAddEntity} className="gap-1.5" disabled>
                        <Plus className="size-4" />
                        Add Entity
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Button onClick={handleAddEntity} className="gap-1.5">
                <Plus className="size-4" />
                Add Entity
              </Button>
            ))}
          </div>
        </div>
      </div>

      {!loading && entities.length > 0 && <SemanticHealthWidget />}

      <AdminContentWrapper
        loading={loading}
        error={error}
        feature="Semantic Layer"
        onRetry={() => setFetchKey((k) => k + 1)}
        loadingMessage="Loading semantic layer..."
      >
      {/*
        Zero-introspected-tables fix (#2462 slice 3, signal from #2459).
        When the DB itself returns zero tables, the legacy file-tree path
        would render every YAML entity as `removed` — the alarming
        "N removed tables" UX surfaced by the 2026-05-16 dogfood pass.
        Render a targeted empty state instead so admins see the real
        signal: "we couldn't read any tables from this connection."

        Falls below loading + above the empty / file-tree branches so it
        wins over "no semantic entities yet" (the entities may still exist
        in YAML — the introspection failure is the load-bearing fact).
      */}
      {!loading && noIntrospectedTables ? (
        <div className="p-6" data-testid="semantic-no-introspected-tables">
          <EmptyState
            icon={DatabaseZap}
            title="We couldn't read any tables from this connection."
            description="The semantic layer compares your YAML against the database's schema. Test the connection or re-run introspection to see which tables exist."
          >
            <div className="mt-3 flex items-center justify-center gap-2">
              <Link href="/admin/connections">
                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                  <DatabaseZap className="size-3.5" />
                  Test connection
                </Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setFetchKey((k) => k + 1)}
              >
                <Sparkles className="size-3.5" />
                Re-run introspection
              </Button>
            </div>
          </EmptyState>
        </div>
      ) : /*
        Dev-mode empty: admin is in developer mode with no entity drafts and
        no published entities at all. Route them to /admin/connections — a
        connection must exist before entities can be imported. Short-circuits
        the file-tree layout below to avoid showing an empty tree next to
        the empty state.
      */
      showDevNoDrafts && entities.length === 0 ? (
        <div className="p-6">
          <DeveloperEmptyState
            icon={BookOpen}
            title="Import your schema after connecting a database."
            description="Entities are generated from your database schema. Add a connection first, then come back here to import."
            action={{ kind: "link", label: "Go to connections", href: "/admin/connections" }}
          />
        </div>
      ) : isSaas && !loading && entities.length === 0 ? (
        <div className="p-6" data-testid="semantic-empty-state">
          <EmptyState
            icon={BookOpen}
            title="No semantic entities yet"
            description="Atlas reads semantic/entities/*.yml from the deployment image. Use this to populate the editor from disk."
          >
            <Button
              variant="link"
              size="xs"
              onClick={runImport}
              disabled={importing}
              className="mt-3"
            >
              {importing ? "Syncing..." : "Sync from disk"}
            </Button>
          </EmptyState>
        </div>
      ) : (
      <>
      {/*
        When an admin is in dev-mode-no-drafts but published entities exist
        (e.g. demo data), show a banner so they know the tree reflects
        live state. The file tree stays interactive so they can browse —
        the existing demoReadOnly tooltips prevent accidental edits.
      */}
      {showDevNoDrafts && entities.length > 0 && !loading ? (
        <SemanticPublishedBanner />
      ) : null}

      {!isSaas && (
        <div className="flex items-center gap-2 border-b bg-muted/30 px-6 py-2.5 text-xs text-muted-foreground">
          <Terminal className="size-3.5 shrink-0" />
          <span>
            The semantic layer is managed through code.
            Use <code className="rounded bg-muted px-1 py-0.5 font-mono">atlas init</code> to generate from your database
            or edit YAML files directly in <code className="rounded bg-muted px-1 py-0.5 font-mono">semantic/</code>.
          </span>
        </div>
      )}

      <ErrorBoundary>
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        <SemanticFileTree
          entities={treeEntities}
          metricFileNames={metricFileNames}
          hasCatalog={catalog !== null}
          hasGlossary={glossary.length > 0}
          selection={selection}
          onSelect={handleSelect}
          className="w-64 shrink-0 border-r"
        />

        {/* Content area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* View toggle bar — only shown when a file is selected */}
          {selection && !detailError && (
            <div className="flex h-[41px] items-center justify-between border-b px-4">
              {/* Edit/delete actions (SaaS mode, entity selected) */}
              <div className="flex items-center gap-1.5">
                {isSaas && selection.type === "entity" && selectedEntity && (() => {
                  const editBtn = (
                    <Button variant="outline" size="sm" onClick={handleEditEntity} className="gap-1 text-xs" disabled={demoReadOnly}>
                      <Pencil className="size-3" />
                      Edit
                    </Button>
                  );
                  const deleteBtn = (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteTarget(selection.name)}
                      className="gap-1 text-xs text-destructive hover:text-destructive"
                      disabled={demoReadOnly}
                    >
                      <Trash2 className="size-3" />
                      Delete
                    </Button>
                  );
                  return demoReadOnly ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>{editBtn}</span>
                        </TooltipTrigger>
                        <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>{deleteBtn}</span>
                        </TooltipTrigger>
                        <TooltipContent>{DEMO_READONLY_TOOLTIP}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <>
                      {editBtn}
                      {deleteBtn}
                    </>
                  );
                })()}
              </div>
              <ViewToggle mode={viewMode} onChange={(m) => { startTransition(() => { setParams({ view: m }); }); }} showHistory={isSaas && selection?.type === "entity"} />
            </div>
          )}

          <div className="flex-1 overflow-hidden">
          {detailError ? (
            <div className="p-6"><ErrorBanner message={detailError} /></div>
          ) : !selection ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FolderOpen className="mx-auto size-10 opacity-50" />
                <p className="mt-3 text-sm">Select a file to view its contents</p>
              </div>
            </div>
          ) : viewMode === "history" && selection.type === "entity" ? (
            <EntityVersionHistory
              entityName={selection.name}
              onRollback={() => {
                refetchAll();
                startTransition(() => { setParams({ view: "pretty" }); });
              }}
            />
          ) : viewMode === "yaml" ? (
            rawYamlLoading ? (
              <LoadingState message="Loading YAML..." />
            ) : rawYaml !== null ? (
              <RawYamlViewer content={rawYaml} />
            ) : (
              <LoadingState message="Loading YAML..." />
            )
          ) : selection.type === "entity" ? (
            selectedEntity ? (
              <EntityDetail entity={selectedEntity} />
            ) : (
              <LoadingState message={`Loading ${selection.name}...`} />
            )
          ) : (
            <ScrollArea className="h-full">
              <div className="p-6">
                {selection.type === "catalog" && <CatalogViewer catalog={catalog} />}
                {selection.type === "glossary" && <GlossaryViewer glossary={glossary} />}
                {selection.type === "metrics" && (
                  <MetricsViewer
                    metrics={selection.file
                      ? metrics.filter((m) => m.file === selection.file)
                      : metrics}
                  />
                )}
              </div>
            </ScrollArea>
          )}
          </div>
        </div>
      </div>
      </ErrorBoundary>
      </>
      )}
      </AdminContentWrapper>

      <DriftDrawer
        entityName={driftDrawerEntity}
        open={driftDrawerOpen}
        onOpenChange={(open) => {
          setDriftDrawerOpen(open);
          if (!open) setDriftDrawerEntity(null);
        }}
        onReconciled={() => {
          // Refetch the entities list so the drift signal updates after a
          // successful reconcile (#2462). The drawer closes itself.
          refetchAll();
        }}
        reconcileDisabled={demoReadOnly}
        reconcileDisabledReason={DEMO_READONLY_TOOLTIP}
      />

      {/* Entity editor dialog */}
      <EntityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        entity={editingEntity}
        entityName={editingEntityName}
        saving={savingEntity}
        serverError={friendlyErrorOrNull(saveError)}
        onSave={handleSaveEntity}
        isSaas={isSaas}
      />

      {/* Import-from-disk error banner: surfaced inline below the header
          so operators can see what went wrong without dismissing a modal.
          The success path opens the result dialog further below. */}
      {importError && (
        <div className="px-6 pb-4">
          <MutationErrorSurface error={importError} feature="Semantic Layer" variant="inline" />
        </div>
      )}

      {/* Import result dialog — counts + per-file errors when any */}
      <AlertDialog open={importResult !== null} onOpenChange={(open) => { if (!open) setImportResult(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Imported semantic layer</AlertDialogTitle>
            <AlertDialogDescription>
              {importResult ? (
                <>
                  Imported <strong>{importResult.imported}</strong> of{" "}
                  <strong>{importResult.total}</strong> entries
                  {importResult.skipped > 0 ? <>, skipped <strong>{importResult.skipped}</strong></> : null}.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {importResult?.errors && importResult.errors.length > 0 && (
            <ScrollArea className="max-h-48 rounded border bg-muted/30 p-3 text-xs">
              <ul className="space-y-1.5">
                {importResult.errors.map((e, i) => (
                  <li key={`${e.file}-${i}`}>
                    <code className="rounded bg-background px-1 py-0.5">{e.file}</code>
                    <span className="ml-2 text-muted-foreground">{e.reason}</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setImportResult(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entity &ldquo;{deleteTarget}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the entity definition from your workspace.
              The agent will no longer be able to query this table. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MutationErrorSurface error={deleteError} feature="Semantic Layer" variant="inline" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingEntity}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault(); // prevent auto-close, we close on success
                handleDeleteEntity();
              }}
              disabled={deletingEntity}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingEntity ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
