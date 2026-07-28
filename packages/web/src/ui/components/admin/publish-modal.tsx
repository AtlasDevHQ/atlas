"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Pencil,
  Plus,
  Trash2,
  AlertCircle,
  AlertTriangle,
  Lock,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { contentSurface, type ContentSurfaceKey } from "@/ui/lib/content-surfaces";
import type { ProfileError } from "@/ui/lib/types";
import { relativeOrNull } from "./pending-changes-pill";

/**
 * A semantic layer that was profiled INCOMPLETELY — some tables failed
 * introspection below the abort threshold, so the published layer is missing
 * them (#3682). Mirrors `warnings.incompleteLayers[]` in the `/api/v1/admin/publish`
 * response. Surfaced after a publish so an admin sees the degraded state rather
 * than an unconditional success.
 */
interface IncompleteLayer {
  readonly connectionGroupId: string | null;
  readonly totalTables: number;
  readonly failedCount: number;
  readonly failedTables: ReadonlyArray<ProfileError>;
}

/**
 * A draft the review gate REFUSED to promote. Today the only refusing surface
 * is `brain_facts` (#4769 / ADR-0036) — a fact missing provenance or a usable
 * grant, where publishing would stamp "reviewed and trusted" on a claim with no
 * evidence, or one invisible to every reader. Mirrors
 * `refusedDrafts[]` in the `/api/v1/admin/publish` response. The row stays a
 * draft and is re-offered on the next publish.
 *
 * `detail` is rendered verbatim: the API writes the actionable sentence, so the
 * reason vocabulary can grow without a matching copy change here.
 */
interface RefusedDraft {
  readonly id: string;
  /** Physical table the refused row belongs to, e.g. `brain_facts`. */
  readonly surface: string;
  readonly reasons: ReadonlyArray<string>;
  readonly detail: string;
}

/** Parsed `/api/v1/admin/publish` response — only the fields this modal reads. */
interface PublishResponseData {
  readonly warnings?: {
    readonly incompleteLayers: ReadonlyArray<IncompleteLayer>;
  };
  /**
   * Top-level, part of the shared `PublishResult` core (#4156 discipline) —
   * REST, MCP, and the CLI all report refusals under this one name. Optional:
   * absent when nothing was refused, and from an older API during a
   * deploy-overlap window.
   */
  readonly refusedDrafts?: ReadonlyArray<RefusedDraft>;
  /**
   * TRUE refusal count — never capped, unlike `refusedDrafts` (100 max). Count
   * off this; the list length under-reports exactly when the backlog is worst.
   */
  readonly refusedDraftTotal?: number;
}

interface DraftRow {
  readonly id: string;
  readonly label: string;
  readonly updatedAt: string;
}

interface EntityEditRow extends DraftRow {
  readonly connectionGroupId: string | null;
}

interface PublishPreviewData {
  readonly connections: ReadonlyArray<DraftRow>;
  readonly entities: ReadonlyArray<DraftRow>;
  readonly entityEdits: ReadonlyArray<EntityEditRow>;
  readonly entityDeletes: ReadonlyArray<DraftRow>;
  readonly prompts: ReadonlyArray<DraftRow>;
  readonly starterPrompts: ReadonlyArray<DraftRow>;
  /** Optional: absent from an older API during a deploy-overlap window. */
  readonly knowledgeDocuments?: ReadonlyArray<DraftRow>;
  /**
   * Optional: absent from an older API during a deploy-overlap window.
   *
   * SCOPED to the reader's brain grants (#4825), unlike every other array here.
   * So this is what the admin may READ, not what publish will promote — add
   * {@link PublishPreviewData.brainFactsWithheld} for that.
   */
  readonly brainFacts?: ReadonlyArray<DraftRow>;
  /**
   * Draft facts publish WILL promote and this admin may NOT read (#4825).
   *
   * The number that used to be learnable only from the publish RESPONSE, by an
   * admin who had no way to interpret it. Optional and defaulted to 0 for a
   * deploy-overlap window; an older API omitting it degrades to the previous
   * silence rather than to a wrong count.
   */
  readonly brainFactsWithheld?: number;
  /**
   * True when `brainFactsWithheld` means "Atlas couldn't establish what you may
   * read" rather than "these are outside your audiences" (#4825).
   *
   * Two different causes needing two different sentences. Defaulting to `false`
   * for a deploy-overlap window is the right way round: the audience
   * explanation is correct in the overwhelmingly common case, and an older API
   * has no degraded path to describe.
   */
  readonly brainFactsScopeUnavailable?: boolean;
}

/**
 * Confirms publish of every staged draft for the active org (#2177).
 *
 * Opens from the {@link PendingChangesPill} popover. Fetches the per-surface
 * draft inventory from `/api/v1/admin/publish-preview`, then POSTs to
 * `/api/v1/admin/publish` on confirm. Errors keep the modal open so the admin
 * sees the failure with the request id — a FAILED publish rolls back atomically
 * server-side, so there is no half-applied state to reconcile.
 *
 * A SUCCEEDED publish can still be partial, and that is deliberate (#4769): the
 * review gate refuses individual drafts (a brain fact with no provenance or no
 * usable grant) and commits the rest, so those rows are still drafts afterwards.
 * The modal stays open on that outcome too and renders {@link RefusedDraftsBanner} —
 * closing with a bare "Published successfully" would hide it.
 */
export function PublishModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { data, loading, error: previewError, refetch } = useAdminFetch<PublishPreviewData>(
    "/api/v1/admin/publish-preview",
    { enabled: open },
  );

  const { mutate, saving, error: publishError, reset } = useAdminMutation<PublishResponseData>({
    path: "/api/v1/admin/publish",
    method: "POST",
  });

  // Layers the publish just promoted that are profiled INCOMPLETELY (#3682).
  // Non-empty keeps the modal open with a warning instead of a silent success.
  const [incompleteLayers, setIncompleteLayers] = useState<ReadonlyArray<IncompleteLayer>>([]);
  // Drafts the review gate refused to promote (#4769). Same posture as
  // `incompleteLayers`: the publish committed, but reporting an unqualified
  // success would hide that some drafts deliberately did not go live.
  const [refusedDrafts, setRefusedDrafts] = useState<ReadonlyArray<RefusedDraft>>([]);
  // Separate from the list because the list is capped — see `refusedDraftTotal`.
  const [refusedTotal, setRefusedTotal] = useState(0);

  // Reset error + warning state whenever the modal opens — a previous attempt
  // shouldn't leave a banner showing the next time the admin opens the modal.
  useEffect(() => {
    if (open) {
      reset();
      setIncompleteLayers([]);
      setRefusedDrafts([]);
      setRefusedTotal(0);
    }
  }, [open, reset]);

  async function handlePublish() {
    const result = await mutate({ body: {} });
    if (result.ok) {
      // The publish committed. If any promoted layer is incomplete (#3682) or
      // any draft was refused (#4769), keep the modal open and show the warning
      // the API returned — an unconditional "Published successfully" would hide
      // that some tables are now live but NOT queryable, or that some drafts
      // are still drafts. Otherwise close as before.
      const layers = result.data?.warnings?.incompleteLayers ?? [];
      const refused = result.data?.refusedDrafts ?? [];
      // `?? refused.length` covers an older API that predates the total.
      const refusedCount = result.data?.refusedDraftTotal ?? refused.length;
      if (layers.length > 0 || refusedCount > 0) {
        setIncompleteLayers(layers);
        setRefusedDrafts(refused);
        setRefusedTotal(refusedCount);
        toast.warning(
          refusedCount > 0
            ? `Published, but ${refusedCount === 1 ? "1 draft was" : `${refusedCount} drafts were`} not published`
            : `Published, but ${layers.length === 1 ? "a layer is" : `${layers.length} layers are`} incomplete`,
        );
      } else {
        toast.success("Published successfully");
        onOpenChange(false);
      }
    }
    // On failure, leave modal open — the banner below surfaces the error.
  }

  /** True once publish committed with something the admin must read first. */
  const hasPostPublishWarning = incompleteLayers.length > 0 || refusedTotal > 0;

  // Facts publish will promote that this admin cannot be shown (#4825). Folded
  // into `total` so the button's count is the real blast radius: an admin must
  // not learn it from the response, and "Publish all (26)" that promotes 32 is
  // the same defect one layer up.
  const withheldFacts = data?.brainFactsWithheld ?? 0;
  const total = data ? totalRows(data) : 0;
  const sections = data ? buildSections(data) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish pending changes</DialogTitle>
          <DialogDescription>
            Promote {total === 1 ? "this draft" : `all ${total} drafts`} to the
            published surface visible to everyone in this workspace. The
            transaction is atomic — every change applies, or none do.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading drafts…
            </div>
          ) : previewError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <div className="flex-1">
                <div className="font-medium">Could not load draft preview</div>
                <div className="text-xs">{friendlyError(previewError)}</div>
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto p-0 text-xs"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : sections.length === 0 && withheldFacts === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No pending changes to publish.
            </div>
          ) : (
            <div className="space-y-4">
              {/* BEFORE the click, and above the lists rather than after them:
                  the whole point is that the blast radius must not be learned
                  from the response. It renders even when `sections` is empty,
                  which is the case where an admin can see nothing at all and
                  would otherwise read "No pending changes" over a real one. */}
              {withheldFacts > 0 && (
                <WithheldFactsNotice
                  count={withheldFacts}
                  scopeUnavailable={data?.brainFactsScopeUnavailable ?? false}
                  onRetry={() => void refetch()}
                />
              )}
              {sections.map((section) => (
                <PreviewSection key={section.key} section={section} />
              ))}
            </div>
          )}
        </div>

        {publishError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Publish failed — nothing changed</div>
              <div className="text-xs">{friendlyError(publishError)}</div>
              {publishError.requestId && (
                <div className="text-xs">Request ID: {publishError.requestId}</div>
              )}
            </div>
          </div>
        )}

        {incompleteLayers.length > 0 && (
          <IncompleteLayersBanner layers={incompleteLayers} />
        )}

        {refusedTotal > 0 && (
          <RefusedDraftsBanner drafts={refusedDrafts} total={refusedTotal} />
        )}

        <DialogFooter>
          {hasPostPublishWarning ? (
            // Publish already committed; collapse the footer to a single
            // acknowledge action so the warning above is read before closing.
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePublish}
                disabled={saving || loading || total === 0}
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" /> Publishing…
                  </>
                ) : (
                  <>Publish all{total > 0 ? ` (${total})` : ""}</>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * States, before the click, that this publish reaches facts the admin cannot
 * read (#4825).
 *
 * Not a warning and not styled as one — the behaviour is correct and
 * deliberate. Reader-scoped publish was considered and rejected: with no
 * resolvable reviewer those facts would strand PERMANENTLY, keeping the drafts
 * badge lit forever, which is the unclearable-banner shape #4771 closed for
 * grants. The defect was that nothing said so. So this is a plain statement of
 * scope with the reason attached, positioned where a scope statement belongs:
 * above the confirm button, not in the response.
 *
 * A COUNT and never a list. There is no honest row to render — the claim is the
 * only identity a fact has — and a placeholder carrying a fact id would
 * disclose which facts exist without disclosing what they say.
 */
function WithheldFactsNotice({
  count,
  scopeUnavailable,
  onRetry,
}: {
  count: number;
  /** The withholding is an Atlas fault, not an audience boundary — see the type. */
  scopeUnavailable: boolean;
  /**
   * Refetches the preview. A real button, because the obvious instruction is
   * inert: this arm is a 200, so the modal's error-path Retry never renders,
   * and "close and reopen the dialog" hits TanStack's 30s `staleTime` and
   * replays the byte-identical degraded response — so an admin following it
   * during the exact window a blip would have cleared concludes the fault is
   * permanent.
   */
  onRetry: () => void;
}) {
  const one = count === 1;
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
      <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {one
            ? "1 brain fact here isn't shown to you"
            : `${count.toLocaleString()} brain facts here aren't shown to you`}
        </p>
        <p className="text-muted-foreground">
          {scopeUnavailable ? (
            <>
              Atlas couldn&apos;t work out which of these you&apos;re allowed to see, so
              it&apos;s showing none of them. This is a fault on our side, not a
              restriction on you. Publishing still promotes {one ? "it" : "them"}.{" "}
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-sm"
                onClick={onRetry}
              >
                Try again
              </Button>
            </>
          ) : (
            <>
              {one ? "It belongs" : "They belong"} to an audience you&apos;re not part of
              — usually a private channel — so Atlas won&apos;t show you the claim, and
              reviewing {one ? "it" : "them"} belongs to that audience&apos;s members.
              Publishing promotes {one ? "it" : "them"} along with everything else,
              because otherwise {one ? "it" : "they"} could never be published by anyone.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Warns that the review gate REFUSED to promote one or more drafts (#4769 /
 * ADR-0036). Today that means a brain fact missing provenance or a usable
 * grant: publishing it would either stamp a claim with no evidence as reviewed,
 * or publish one that is invisible to every reader. Each stays a draft and is
 * re-offered on the next publish, so this is a repairable backlog, not a loss.
 */
function RefusedDraftsBanner({
  drafts,
  total,
}: {
  drafts: ReadonlyArray<RefusedDraft>;
  /** May exceed `drafts.length` — the API caps the list at 100, never the count. */
  total: number;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          Published, but {total === 1 ? "1 draft was" : `${total} drafts were`} not published
        </p>
        <p className="opacity-90">
          Each is missing the evidence or the audience it needs to be trusted, so the review gate
          held it back. They are still drafts — fix or retract them and publish again.
        </p>
        <ul className="space-y-1">
          {drafts.map((draft) => (
            <li key={`${draft.surface}:${draft.id}`} className="opacity-90">
              {draft.detail}
            </li>
          ))}
        </ul>
        {total > drafts.length && (
          <p className="opacity-90">
            Showing the first {drafts.length} of {total}. The rest are in the server logs and
            are all still drafts.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Warns that the publish promoted one or more INCOMPLETE semantic layers —
 * tables that failed introspection are now live but NOT queryable (#3682). Read
 * from the durable `semantic_profile_status` marker, so it surfaces even when the
 * layer was profiled in a different process (web `/chat` vs a stdio MCP server).
 */
function IncompleteLayersBanner({
  layers,
}: {
  layers: ReadonlyArray<IncompleteLayer>;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          Published, but {layers.length === 1 ? "a layer is" : `${layers.length} layers are`}{" "}
          incomplete
        </p>
        <p className="opacity-90">
          Some tables failed introspection (often a permission gap) and are excluded from the
          live semantic layer — the agent can&apos;t query them. Fix access and re-profile to
          include them.
        </p>
        <ul className="space-y-1">
          {layers.map((layer) => (
            <li key={layer.connectionGroupId ?? "__default__"}>
              <span className="font-medium">
                {layer.connectionGroupId ?? "default"}
              </span>{" "}
              — {layer.failedCount} of {layer.totalTables} not queryable:
              <span className="font-mono text-[11px] opacity-80">
                {" "}
                {layer.failedTables.slice(0, 5).map((t) => t.table).join(", ")}
                {layer.failedTables.length > 5
                  ? `, … (+${layer.failedTables.length - 5} more)`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface SectionRow {
  readonly id: string;
  readonly label: string;
  readonly updatedAt: string;
  readonly intent: "create" | "update" | "delete";
}

interface Section {
  readonly key: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly rows: ReadonlyArray<SectionRow>;
}

function PreviewSection({ section }: { section: Section }) {
  const Icon = section.icon;
  return (
    <section>
      <header className="mb-1.5 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span>{section.title}</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          {section.rows.length}
        </span>
      </header>
      <ul className="divide-y rounded-md border">
        {section.rows.map((row) => (
          <li
            key={row.id + row.intent}
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            <IntentIcon intent={row.intent} />
            <span className="flex-1 truncate" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {relativeOrNull(row.updatedAt) ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IntentIcon({ intent }: { intent: SectionRow["intent"] }) {
  switch (intent) {
    case "create":
      return <Plus className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="New" />;
    case "update":
      return <Pencil className="size-4 text-amber-600 dark:text-amber-400" aria-label="Edited" />;
    case "delete":
      return <Trash2 className="size-4 text-rose-600 dark:text-rose-400" aria-label="Deleted" />;
  }
}

/**
 * Everything this publish will promote — LISTED OR NOT.
 *
 * `brainFactsWithheld` is added because the brain segment is the one list here
 * that is reader-scoped (#4825): its rows are what the admin may read, and the
 * withheld remainder is promoted just the same. Counting only the rows would
 * put "Publish all (26)" on a button that promotes 32, which is precisely the
 * confusion the disclosure exists to end.
 */
function totalRows(data: PublishPreviewData): number {
  return (
    data.connections.length +
    data.entities.length +
    data.entityEdits.length +
    data.entityDeletes.length +
    data.prompts.length +
    data.starterPrompts.length +
    (data.knowledgeDocuments?.length ?? 0) +
    (data.brainFacts?.length ?? 0) +
    (data.brainFactsWithheld ?? 0)
  );
}

/** Build one section from a display-surface descriptor, skipping empty. */
function surfaceSection(key: ContentSurfaceKey, rows: ReadonlyArray<SectionRow>): Section | null {
  if (rows.length === 0) return null;
  const surface = contentSurface(key);
  return { key: surface.key, title: surface.title, icon: surface.icon, rows };
}

function buildSections(data: PublishPreviewData): Section[] {
  // The entity display surface folds three preview slices with per-slice
  // intents (create / update / delete); everything else is a create list.
  // Titles, icons, and ordering come from the shared content-surface
  // descriptors so the modal can't drift from the pill/banner naming.
  const entityRows: SectionRow[] = [];
  for (const r of data.entities) entityRows.push({ ...r, intent: "create" });
  for (const r of data.entityEdits) {
    const suffix = r.connectionGroupId ? ` · ${r.connectionGroupId}` : "";
    entityRows.push({
      id: r.id,
      label: `${r.label}${suffix}`,
      updatedAt: r.updatedAt,
      intent: "update",
    });
  }
  for (const r of data.entityDeletes) entityRows.push({ ...r, intent: "delete" });

  const creates = (rows: ReadonlyArray<DraftRow> | undefined): SectionRow[] =>
    (rows ?? []).map((r) => ({ ...r, intent: "create" as const }));

  return [
    surfaceSection("connections", creates(data.connections)),
    surfaceSection("entities", entityRows),
    surfaceSection("prompts", creates(data.prompts)),
    surfaceSection("starterPrompts", creates(data.starterPrompts)),
    surfaceSection("knowledgeDocuments", creates(data.knowledgeDocuments)),
    surfaceSection("brainFacts", creates(data.brainFacts)),
  ].filter((s): s is Section => s !== null);
}
