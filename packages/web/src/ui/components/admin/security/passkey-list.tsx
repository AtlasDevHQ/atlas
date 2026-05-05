"use client";

/**
 * Enrolled-passkey list rendered below the security tiles.
 *
 * Each row shows the passkey's name, creation date, and rename/delete
 * affordances. Better Auth's passkey model doesn't track last-used time,
 * so we don't surface one. The list is owned by the parent page (driven
 * off `listUserPasskeys()`); this component is a controlled renderer
 * that calls back via `onChange()` after any mutation.
 */

import { useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { getPasskeyClient, type Passkey } from "@/lib/auth/passkey-client";

export type PasskeyRow = Passkey;

function formatCreatedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PasskeyListProps {
  passkeys: PasskeyRow[];
  /** Called after a successful rename or delete so the parent can refetch. */
  onChange?: () => void;
}

type Dialog =
  | { kind: "rename"; id: string; current: string; draft: string }
  | { kind: "delete"; id: string; current: string };

export function PasskeyList({ passkeys, onChange }: PasskeyListProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openRename(row: PasskeyRow) {
    setError(null);
    setDialog({ kind: "rename", id: row.id, current: row.name ?? row.id, draft: row.name ?? "" });
  }

  function openDelete(row: PasskeyRow) {
    setError(null);
    setDialog({ kind: "delete", id: row.id, current: row.name ?? row.id });
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  async function handleRename() {
    if (!dialog || dialog.kind !== "rename") return;
    const trimmed = dialog.draft.trim();
    if (!trimmed) {
      setError("Name can't be empty.");
      return;
    }
    const client = getPasskeyClient();
    if (!client) {
      setError("Passkey support couldn't be loaded. Refresh the page and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof client.updatePasskey>>;
    try {
      result = await client.updatePasskey({ id: dialog.id, name: trimmed });
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] updatePasskey threw", msg);
      setError("Could not save that name. Please try again.");
      return;
    }
    setBusy(false);
    if (result.error) {
      console.warn("[passkey] updatePasskey failed", result.error);
      setError(result.error.message ?? "Could not save that name. Please try again.");
      return;
    }
    closeDialog();
    onChange?.();
  }

  async function handleDelete() {
    if (!dialog || dialog.kind !== "delete") return;
    const client = getPasskeyClient();
    if (!client) {
      setError("Passkey support couldn't be loaded. Refresh the page and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof client.deletePasskey>>;
    try {
      result = await client.deletePasskey({ id: dialog.id });
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] deletePasskey threw", msg);
      setError("Could not delete that passkey. Please try again.");
      return;
    }
    setBusy(false);
    if (result.error) {
      console.warn("[passkey] deletePasskey failed", result.error);
      setError(result.error.message ?? "Could not delete that passkey. Please try again.");
      return;
    }
    closeDialog();
    onChange?.();
  }

  // ── Render ─────────────────────────────────────────────────────────

  if (passkeys.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card/30 p-6 text-center">
        <p className="text-sm font-medium">No passkeys yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use the Passkey tile above to enroll your first one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Enrolled passkeys
      </h2>
      <ul className="divide-y rounded-lg border bg-card/40">
        {passkeys.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {row.name ?? <span className="italic text-muted-foreground">Unnamed passkey</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                Added {formatCreatedAt(row.createdAt)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openRename(row)}
                aria-label={`Rename ${row.name ?? "passkey"}`}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openDelete(row)}
                aria-label={`Delete ${row.name ?? "passkey"}`}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
        <AlertDialogContent className="sm:max-w-md">
          {dialog?.kind === "rename" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Rename passkey</AlertDialogTitle>
                <AlertDialogDescription>
                  Choose a name you'll recognize later. The passkey itself
                  isn't affected — only the label.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5 py-2">
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Passkey name
                </label>
                <Input
                  value={dialog.draft}
                  onChange={(e) =>
                    setDialog((prev) =>
                      prev && prev.kind === "rename"
                        ? { ...prev, draft: e.target.value }
                        : prev,
                    )
                  }
                  maxLength={80}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleRename();
                    }
                  }}
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handleRename();
                  }}
                  disabled={busy || !dialog.draft.trim()}
                >
                  {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Save
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {dialog?.kind === "delete" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete passkey?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removing <span className="font-medium">{dialog.current}</span>
                  {" "}means it can no longer be used to sign in. If it's your
                  only second factor, set up an authenticator app first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error && (
                <p className="px-1 pb-1 text-sm text-destructive">{error}</p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handleDelete();
                  }}
                  disabled={busy}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
