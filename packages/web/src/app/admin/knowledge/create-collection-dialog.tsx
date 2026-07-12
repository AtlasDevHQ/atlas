"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, FolderPlus, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineError } from "@/ui/components/admin/compact";
import { FormDialog } from "@/components/form-dialog";
import { useAdminFetch, friendlyError } from "@/ui/hooks/use-admin-fetch";
import {
  IntegrationsCatalogResponseSchema,
  type IntegrationsCatalogEntry,
} from "@/ui/lib/admin-schemas";
import { ConfigSchemaFields } from "@/app/admin/integrations/config-schema-fields";
import {
  buildDefaultValues,
  buildSubmitPayload,
  buildZodSchema,
  CONNECTION_ID_FIELD,
  parseConfigSchema,
  type FormFieldDescriptor,
} from "@/app/admin/integrations/form-install-modal";
import { getApiUrl } from "@/lib/api-url";
import { cn } from "@/lib/utils";
import { extractApiError } from "@/ui/lib/extract-api-error";
import type { KnowledgeCollectionSource, KnowledgeSyncAuthScheme } from "@/ui/lib/types";
import {
  groupForKnowledgeSlug,
  iconForKnowledgeSlug,
  KNOWLEDGE_DISPLAY_ORDER,
  knowledgeSourceForSlug,
  shortConnectorLabel,
} from "./knowledge-connectors";

/* ────────────────────────────────────────────────────────────────────────
 *  Create / edit collection — the explicit "install" flow for the Knowledge
 *  Base pillar (ADR-0028 §5). A collection is a form-install of a built-in
 *  knowledge catalog row, keyed by a slug (the reserved `__install_id__`
 *  field).
 *
 *  CREATE (#4619) is data-driven: it lists every `?pillar=knowledge` catalog
 *  row as a connector tile, then renders that connector's credential form from
 *  its `config_schema` (the same schema-driven pipeline the /admin/connections
 *  Add-datasource picker uses). Adding a connector to
 *  `BUILTIN_KNOWLEDGE_CATALOG_ROWS` surfaces it here automatically — no picker
 *  edit. Install posts to `POST /api/v1/integrations/:slug/install-form`.
 *
 *  EDIT (`edit` prop) re-drives the SAME install pipeline with the existing
 *  slug for a bundle-sync collection — the server upserts the container config
 *  in place and rotates/deletes the credential row without touching the
 *  collection's documents. This is how a leaked sync secret rotates WITHOUT the
 *  uninstall-and-recreate dance (which would archive and un-publish every
 *  document in the collection). Only bundle-sync exposes an endpoint/secret to
 *  edit, so this path is unchanged from before #4619.
 * ──────────────────────────────────────────────────────────────────────── */

/** Mirror of the server-side collection-slug rule (okf-upload-form-handler). */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
const SLUG_MAX = 128;

/** The wire source discriminator (`@useatlas/types`) — no local re-declaration. */
type SourceKind = KnowledgeCollectionSource;
/** The wire auth-scheme union (`@useatlas/types`) — no local re-declaration. */
type AuthScheme = KnowledgeSyncAuthScheme;

/** Pre-fill for edit mode — the non-secret sync settings of an existing
 *  bundle-sync collection (the secret is never echoed, so it starts blank). */
export interface EditSyncSettings {
  readonly slug: string;
  readonly endpointUrl: string | null;
  readonly authScheme: AuthScheme | null;
  readonly description: string | null;
}

export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreated,
  existingSlugs,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `source` lets the caller decide the follow-up act (upload vs first sync). */
  onCreated: (slug: string, source: SourceKind) => void;
  existingSlugs: ReadonlyArray<string>;
  /** When set, the dialog edits this synced collection's settings in place. */
  edit?: EditSyncSettings | null;
}) {
  // Two distinct surfaces behind one public component: the in-place
  // sync-settings rotation (edit) keeps its hand-rolled bundle-sync form; the
  // create flow is the data-driven connector picker.
  return edit ? (
    <EditSyncSettingsDialog open={open} onOpenChange={onOpenChange} onSaved={onCreated} edit={edit} />
  ) : (
    <CreateCollectionFlow
      open={open}
      onOpenChange={onOpenChange}
      onCreated={onCreated}
      existingSlugs={existingSlugs}
    />
  );
}

// ---------------------------------------------------------------------------
// Create — data-driven connector picker → schema-driven install form
// ---------------------------------------------------------------------------

function CreateCollectionFlow({
  open,
  onOpenChange,
  onCreated,
  existingSlugs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string, source: SourceKind) => void;
  existingSlugs: ReadonlyArray<string>;
}) {
  const [picked, setPicked] = useState<IntegrationsCatalogEntry | null>(null);
  const [search, setSearch] = useState("");

  // Only fetch while the dialog is open so the picker doesn't hit the catalog
  // on every page render.
  const catalog = useAdminFetch("/api/v1/integrations/catalog?pillar=knowledge", {
    schema: IntegrationsCatalogResponseSchema,
    enabled: open,
  });

  // Reset the picker synchronously BEFORE paint on each open — `picked` state
  // survives close/reopen (the component is mounted unconditionally by the
  // page), so a plain post-paint effect would flash the previously-selected
  // connector's install form for one frame on reopen. useLayoutEffect clears it
  // before the browser paints.
  useLayoutEffect(() => {
    if (open) {
      setPicked(null);
      setSearch("");
    }
  }, [open]);

  // A connector is chosen → hand off to its schema-driven install form.
  if (picked) {
    return (
      <CollectionInstallForm
        open={open}
        entry={picked}
        existingSlugs={existingSlugs}
        onBack={() => setPicked(null)}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    );
  }

  // Derived render state for the picker branch — plain computation (React
  // Compiler memoizes; no manual useMemo for perf per CLAUDE.md). Only runs
  // here, after the early return above.
  const orderOf = (slug: string) => {
    const i = KNOWLEDGE_DISPLAY_ORDER.indexOf(slug);
    return i === -1 ? KNOWLEDGE_DISPLAY_ORDER.length : i;
  };
  // `formInstallable === true` fails closed: a catalog row without a registered
  // form-install handler (or an older API omitting the flag) never renders a
  // submittable tile. The pillar guard is belt-and-braces — the
  // `?pillar=knowledge` listing only returns knowledge rows. Stable, familiar
  // order (Upload/Endpoint/Notion first); unlisted rows (a future connector)
  // fall to the end but still render.
  const connectors = (catalog.data?.catalog ?? [])
    .filter((e) => e.pillar === "knowledge" && e.installModel === "form" && e.formInstallable === true)
    .toSorted((a, b) => orderOf(a.slug) - orderOf(b.slug));

  const query = search.trim().toLowerCase();
  const filtered = query
    ? connectors.filter((e) =>
        `${shortConnectorLabel(e.name)} ${e.name} ${e.description ?? ""}`
          .toLowerCase()
          .includes(query),
      )
    : connectors;

  const manual = filtered.filter((e) => groupForKnowledgeSlug(e.slug) === "manual");
  const connectorTiles = filtered.filter((e) => groupForKnowledgeSlug(e.slug) === "connector");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
          <DialogDescription>
            A collection is a named knowledge corpus the agent reads as descriptive context. Upload a
            bundle yourself, point at an endpoint, or connect a source Atlas mirrors on a schedule —
            synced changes always land as drafts for review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sources…"
              className="pl-8"
              data-testid="connector-search"
              aria-label="Search knowledge sources"
            />
          </div>

          {catalog.loading ? (
            <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading sources…
            </div>
          ) : catalog.error ? (
            <InlineError>{friendlyError(catalog.error)}</InlineError>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-8 text-sm text-muted-foreground">
              {search.trim()
                ? `No sources match “${search.trim()}”.`
                : "No knowledge sources are available."}
            </p>
          ) : (
            <>
              {manual.length > 0 ? (
                <ConnectorGroup label="Files & endpoints" entries={manual} onPick={setPicked} />
              ) : null}
              {connectorTiles.length > 0 ? (
                <ConnectorGroup label="Connectors" entries={connectorTiles} onPick={setPicked} />
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorGroup({
  label,
  entries,
  onPick,
}: {
  label: string;
  entries: IntegrationsCatalogEntry[];
  onPick: (entry: IntegrationsCatalogEntry) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map((entry) => (
          <ConnectorTile key={entry.slug} entry={entry} onPick={onPick} />
        ))}
      </div>
    </section>
  );
}

function ConnectorTile({
  entry,
  onPick,
}: {
  entry: IntegrationsCatalogEntry;
  onPick: (entry: IntegrationsCatalogEntry) => void;
}) {
  const Icon = iconForKnowledgeSlug(entry.slug);
  const comingSoon = entry.implementationStatus === "coming_soon";
  const upgrade = entry.access.kind === "upgrade";
  return (
    <button
      type="button"
      onClick={() => onPick(entry)}
      disabled={comingSoon || upgrade}
      data-testid={`connector-${entry.slug}`}
      className={cn(
        "group flex items-start gap-3 rounded-xl border bg-card/40 px-3.5 py-3 text-left transition-colors",
        "hover:border-primary/40 hover:bg-card/80",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-card/40",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold tracking-tight">
            {shortConnectorLabel(entry.name)}
          </span>
          {comingSoon ? (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Soon
            </Badge>
          ) : entry.access.kind === "upgrade" && entry.access.requiredPlan ? (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {entry.access.requiredPlan} plan
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {entry.description ?? "Connect this source as a review-gated knowledge collection."}
        </span>
      </span>
    </button>
  );
}

/**
 * The KB collection-id field prepended to every connector's install form. It
 * rides the reserved `__install_id__` key (the same key the server reads as the
 * collection slug); the slug rule (pattern, length, no duplicates) is layered
 * onto the generic {@link buildZodSchema} in {@link buildCreateSchema}.
 */
const COLLECTION_ID_DESCRIPTOR: FormFieldDescriptor = {
  key: CONNECTION_ID_FIELD,
  type: "string",
  label: "Collection id",
  description:
    "Letters, digits, dots, dashes, and underscores. Becomes the collection's URL and cannot be changed later.",
  required: true,
};

/**
 * The generic {@link buildZodSchema} makes the collection id required (non-
 * empty); this layers the KB slug rules on top — the character-set / length
 * pattern and the client-side duplicate check against existing collections.
 * The server re-validates both, so this is only for a responsive form.
 */
function buildCreateSchema(
  fields: FormFieldDescriptor[],
  existingSlugs: ReadonlyArray<string>,
): z.ZodType<Record<string, unknown>, Record<string, unknown>> {
  return buildZodSchema(fields).superRefine((values, ctx) => {
    const raw = (values as Record<string, unknown>)[CONNECTION_ID_FIELD];
    const rawStr = typeof raw === "string" ? raw : "";
    // A truly-empty id is already flagged by the base schema's `.min(1)`; only
    // layer the slug-specific checks once something has been typed.
    if (rawStr.length === 0) return;
    const id = rawStr.trim();
    if (id.length > SLUG_MAX || !SLUG_PATTERN.test(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [CONNECTION_ID_FIELD],
        message: `Only letters, digits, dots, dashes, and underscores (max ${SLUG_MAX}).`,
      });
      return;
    }
    if (existingSlugs.includes(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [CONNECTION_ID_FIELD],
        message: `A collection named "${id}" already exists.`,
      });
    }
  });
}

function CollectionInstallForm({
  open,
  entry,
  existingSlugs,
  onBack,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  entry: IntegrationsCatalogEntry;
  existingSlugs: ReadonlyArray<string>;
  onBack: () => void;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string, source: SourceKind) => void;
}) {
  const fields = useMemo(
    () => [COLLECTION_ID_DESCRIPTOR, ...parseConfigSchema(entry.configSchema)],
    [entry.configSchema],
  );
  const schema = useMemo(() => buildCreateSchema(fields, existingSlugs), [fields, existingSlugs]);
  const defaultValues = useMemo(() => buildDefaultValues(fields), [fields]);

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const payload = buildSubmitPayload(fields, values);
    // `buildSubmitPayload` keeps the reserved id but doesn't trim it; the
    // server slug rule rejects surrounding whitespace, so trim here.
    const rawId = payload[CONNECTION_ID_FIELD];
    const id = typeof rawId === "string" ? rawId.trim() : "";
    payload[CONNECTION_ID_FIELD] = id;

    let res: Response;
    try {
      res = await fetch(
        `${getApiUrl()}/api/v1/integrations/${encodeURIComponent(entry.slug)}/install-form`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      // Transport failure (offline / DNS / CORS) — log a breadcrumb and rethrow
      // actionable copy; FormDialog surfaces the throw as a root-level error.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`CollectionInstall ${entry.slug} network error:`, message);
      throw new Error(
        "Could not reach the server to create the collection. Check your connection and try again.",
      );
    }
    if (!res.ok) {
      // Thrown → FormDialog surfaces it as a root-level error.
      throw new Error(await extractApiError(res, "Could not create the collection"));
    }
    toast.success(`Collection "${id}" created`);
    onCreated(id, knowledgeSourceForSlug(entry.slug));
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-h-[85vh] max-w-md overflow-y-auto"
      title={`New collection — ${shortConnectorLabel(entry.name)}`}
      description={entry.description ?? undefined}
      schema={schema}
      defaultValues={defaultValues}
      onSubmit={handleSubmit}
      submitLabel="Create collection"
      submitTestId="create-collection-submit"
      resetKey={entry.slug}
      extraFooter={(form) => (
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={form.formState.isSubmitting}
          data-testid="connector-back"
        >
          <ArrowLeft className="mr-1.5 size-4" />
          Back
        </Button>
      )}
    >
      {(form) => <ConfigSchemaFields fields={fields} control={form.control} />}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// Edit — in-place bundle-sync rotation (unchanged behavior from before #4619)
// ---------------------------------------------------------------------------

function EditSyncSettingsDialog({
  open,
  onOpenChange,
  onSaved,
  edit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (slug: string, source: SourceKind) => void;
  edit: EditSyncSettings;
}) {
  const [description, setDescription] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [authScheme, setAuthScheme] = useState<AuthScheme>("none");
  const [authSecret, setAuthSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDescription(edit.description ?? "");
      setEndpointUrl(edit.endpointUrl ?? "");
      setAuthScheme(edit.authScheme ?? "none");
      setAuthSecret("");
      setError(null);
    }
  }, [open, edit]);

  const endpointValid = endpointUrl.trim().length > 0;
  const secretValid = authScheme === "none" || authSecret.trim().length > 0;

  async function handleSubmit() {
    if (!endpointValid) {
      setError("Endpoint URL is required for a synced collection.");
      return;
    }
    if (!secretValid) {
      setError("An auth secret is required for bearer/basic authentication.");
      return;
    }
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = { __install_id__: edit.slug };
    if (description.trim()) body.description = description.trim();
    body.endpoint_url = endpointUrl.trim();
    body.auth_scheme = authScheme;
    if (authScheme !== "none") body.auth_secret = authSecret.trim();

    try {
      const res = await fetch(`${getApiUrl()}/api/v1/integrations/bundle-sync/install-form`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await extractApiError(res, "Could not update the sync settings"));
        return;
      }
      toast.success(`Sync settings for "${edit.slug}" updated`);
      onSaved(edit.slug, "bundle-sync");
    } catch (err) {
      // Transport failure — log a breadcrumb (mirrors the rest of the module's
      // console.warn discipline) and surface actionable copy.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`EditSyncSettings bundle-sync install-form (${edit.slug}):`, message);
      setError(message || "Could not update the sync settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit sync settings — {edit.slug}</DialogTitle>
          <DialogDescription>
            Change the endpoint or rotate the auth secret without reinstalling — the collection&apos;s
            documents are untouched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="collection-endpoint">Endpoint URL</Label>
            <Input
              id="collection-endpoint"
              placeholder="https://github.com/acme/kb/archive/refs/heads/main.tar.gz"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              data-testid="collection-endpoint"
            />
            <p className="text-xs text-muted-foreground">
              An HTTPS URL serving your bundle as .tar, .tar.gz, or .zip — a git-forge archive URL
              works. Synced changes always land as drafts for review.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="collection-auth">Authentication</Label>
            <Select value={authScheme} onValueChange={(v) => setAuthScheme(v as AuthScheme)}>
              <SelectTrigger id="collection-auth" data-testid="collection-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (public endpoint)</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="basic">Basic (user:password)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {authScheme !== "none" ? (
            <div className="space-y-1.5">
              <Label htmlFor="collection-secret">
                {authScheme === "bearer" ? "Bearer token" : "User:password"}
              </Label>
              <Input
                id="collection-secret"
                type="password"
                autoComplete="off"
                value={authSecret}
                onChange={(e) => setAuthSecret(e.target.value)}
                data-testid="collection-secret"
              />
              <p className="text-xs text-muted-foreground">
                Enter the (new) secret — the stored one is never shown; saving replaces it.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="collection-description">Description (optional)</Label>
            <Textarea
              id="collection-description"
              placeholder="What this corpus covers — e.g. on-call runbooks and incident playbooks."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {error ? <InlineError>{error}</InlineError> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || !endpointValid || !secretValid}
            data-testid="create-collection-submit"
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <FolderPlus className="mr-1.5 size-3.5" />
            )}
            Save sync settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
