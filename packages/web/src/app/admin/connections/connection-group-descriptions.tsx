"use client";

/**
 * Source-catalog descriptions editor (ADR-0022 §4, #3894).
 *
 * One row per Connection group, showing the description the agent reads to route
 * (auto-generated from the group's entities at profile time, or operator-refined
 * here). A customer admin can edit or clear it; the edit becomes the manual
 * override and flows into the agent's Source catalog. Groups are passed in from
 * the connections page (derived from the connection list) so a group with no
 * description yet still appears and can be given one.
 */

import { useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import {
  ConnectionGroupDescriptionsResponseSchema,
  MAX_GROUP_DESCRIPTION_CHARS,
} from "@/ui/lib/admin-schemas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { useDemoReadonly } from "@/ui/hooks/use-demo-readonly";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { SectionHeader } from "./section-header";
import { stripGroupPrefix } from "@/ui/lib/strip-group-prefix";

type DescriptionsResponse = z.infer<typeof ConnectionGroupDescriptionsResponseSchema>;

export interface SourceGroup {
  readonly id: string;
  readonly memberCount: number;
}

export function ConnectionGroupDescriptions({
  groups,
}: {
  groups: ReadonlyArray<SourceGroup>;
}) {
  const { data, refetch } = useAdminFetch<DescriptionsResponse>(
    "/api/v1/admin/connection-groups",
    { schema: ConnectionGroupDescriptionsResponseSchema },
  );
  const mutation = useAdminMutation({ method: "PATCH", invalidates: refetch });
  const { readOnly } = useDemoReadonly();

  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // A no-group workspace (a single flat connection with no group_id) has no
  // group whose description to curate — hide the section entirely. A workspace
  // with one named group still renders so its description can be edited.
  if (groups.length === 0) return null;

  const byGroup = new Map(
    (data?.descriptions ?? []).map((d) => [d.groupId, d] as const),
  );

  function openEditor(groupId: string) {
    setDraft(byGroup.get(groupId)?.description ?? "");
    setEditGroupId(groupId);
  }

  async function save() {
    if (editGroupId === null) return;
    const result = await mutation.mutate({
      path: `/api/v1/admin/connection-groups/${encodeURIComponent(editGroupId)}`,
      body: { description: draft },
    });
    if (result.ok) {
      toast.success(
        draft.trim()
          ? `Updated description for "${stripGroupPrefix(editGroupId)}"`
          : `Cleared description for "${stripGroupPrefix(editGroupId)}"`,
      );
      setEditGroupId(null);
    }
  }

  const sortedGroups = groups.toSorted((a, b) => a.id.localeCompare(b.id));

  return (
    <section>
      <SectionHeader
        title="Source descriptions"
        count="What the agent reads to choose which source answers a question"
      />
      <Card>
        <CardContent className="divide-y p-0">
          {sortedGroups.map((group) => {
            const row = byGroup.get(group.id);
            return (
              <div
                key={group.id}
                className="flex items-start justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {stripGroupPrefix(group.id)}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {group.memberCount} member{group.memberCount === 1 ? "" : "s"}
                    </Badge>
                    {row?.source === "manual" && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        edited
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row?.description ? (
                      row.description
                    ) : (
                      <span className="italic">
                        Auto-generated from this group&apos;s entities.
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={readOnly}
                  onClick={() => openEditor(group.id)}
                >
                  Edit
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog
        open={editGroupId !== null}
        onOpenChange={(open) => {
          if (!open) setEditGroupId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Edit source description
              {editGroupId ? ` — ${stripGroupPrefix(editGroupId)}` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              A short summary of what this source holds. The agent reads it to
              route questions to the right source. Leave blank to revert to the
              auto-generated description.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={draft}
            maxLength={MAX_GROUP_DESCRIPTION_CHARS}
            rows={4}
            placeholder="e.g. Production orders, fulfillment, and customer records."
            onChange={(e) => setDraft(e.target.value)}
          />
          <MutationErrorSurface error={mutation.error} feature="Connections" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.saving}
              onClick={(e) => {
                // Keep the dialog open until the mutation resolves.
                e.preventDefault();
                void save();
              }}
            >
              {mutation.saving ? "Saving…" : "Save"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
