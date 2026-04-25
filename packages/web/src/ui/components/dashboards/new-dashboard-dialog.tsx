"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  /**
   * Called after a dashboard is successfully created. Receives the new
   * dashboard so the caller can navigate, refetch, or both. Defaults to
   * navigating to the new dashboard's detail page.
   */
  onCreated?: (dashboard: Dashboard) => void;
}

export function NewDashboardDialog({
  open,
  onOpenChange,
  onCreated,
}: NewDashboardDialogProps) {
  const router = useRouter();
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
    if (result.data) {
      if (onCreated) onCreated(result.data);
      else router.push(`/dashboards/${result.data.id}`);
    }
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
