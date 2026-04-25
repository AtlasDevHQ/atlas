"use client";

import { useState } from "react";
import type { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import type { Dashboard } from "@/ui/lib/types";

interface NewDashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog has no opinion about navigation — every call site supplies its own policy. */
  onCreated: (dashboard: Dashboard) => void;
}

export function NewDashboardDialog({
  open,
  onOpenChange,
  onCreated,
}: NewDashboardDialogProps) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { mutate, saving } = useAdminMutation<Dashboard>();

  function reset() {
    setTitle("");
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    const result = await mutate({
      path: "/api/v1/dashboards",
      method: "POST",
      body: { title: trimmed },
    });
    if (!result.ok) {
      setError(friendlyError(result.error));
      return;
    }
    reset();
    onOpenChange(false);
    if (result.data) onCreated(result.data);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>
            Pin saved query results to a new dashboard for ongoing monitoring.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Input
            placeholder="Dashboard title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
            autoFocus
          />
          {error && (
            <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving || !title.trim()}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function defaultOnDashboardCreated(
  router: Pick<ReturnType<typeof useRouter>, "push">,
): (d: Dashboard) => void {
  return (d) => router.push(`/dashboards/${d.id}`);
}
