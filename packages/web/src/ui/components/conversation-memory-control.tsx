"use client";

/**
 * In-conversation durable working-memory control (#3758, ADR-0020).
 *
 * A lightweight header affordance in the chat: shows what Atlas has remembered
 * for the active conversation (the durable working-memory slots it threads into
 * future answers) and lets the analyst reset it, so a sticky wrong fact can be
 * corrected without leaving the chat. Pure HTTP client — talks to
 * `/api/v1/conversations/{id}/memory` (GET + DELETE) with the workspace's
 * credentials. Degrades silently when there's no internal DB: the read view is
 * empty and reset is a no-op (the backend returns `{ slots: [] }` / `{ cleared:
 * 0 }`), so the control never errors when durable memory isn't wired.
 */

import { useState } from "react";
import { useAtlasConfig } from "@/ui/context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionMemorySlot } from "@/ui/lib/types";
import { Brain, Loader2, Trash2 } from "lucide-react";

/**
 * Pull an actionable message off a non-ok response. The API attaches a
 * `{ error, message, requestId }` envelope to every error (a `requestId` on
 * 500s), so prefer the server's message + correlation ref over a generic
 * string. Defensive: a non-JSON body falls back to `fallback`.
 */
async function errorFromResponse(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string; requestId?: string };
    const message = body.message ?? body.error ?? fallback;
    return body.requestId ? `${message} (ref: ${body.requestId.slice(0, 8)})` : message;
  } catch {
    return fallback;
  }
}

/** Render a slot value as a compact, truncated preview. */
function valuePreview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = "undefined";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export function ConversationMemoryControl({
  conversationId,
  className,
}: {
  conversationId: string;
  className?: string;
}) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<SessionMemorySlot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memoryUrl = `${apiUrl}/api/v1/conversations/${conversationId}/memory`;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(memoryUrl, { credentials });
      if (!res.ok) {
        setError(await errorFromResponse(res, "Couldn't load this conversation's memory."));
        setSlots([]);
        return;
      }
      const json = (await res.json()) as { slots?: SessionMemorySlot[] };
      setSlots(Array.isArray(json.slots) ? json.slots : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setSlots(null);
      setError(null);
      void load();
    }
  }

  async function handleReset() {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(memoryUrl, { method: "DELETE", credentials });
      if (!res.ok) {
        setError(await errorFromResponse(res, "Couldn't reset this conversation's memory."));
        return;
      }
      // A reset clears every slot — the next read (and the next turn) sees empty.
      setSlots([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  const hasSlots = !!slots && slots.length > 0;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={className}
        onClick={() => handleOpenChange(true)}
        aria-label="View session memory"
      >
        <Brain className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="size-4" />
              Session memory
            </DialogTitle>
            <DialogDescription>
              What Atlas remembers for this conversation and threads into future answers. Reset it to
              correct a sticky fact.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 space-y-2 overflow-y-auto">
            {loading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading memory…</p>
            ) : hasSlots ? (
              <ul className="space-y-2">
                {slots!.map((slot) => (
                  <li key={slot.namespace} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium">{slot.namespace}</span>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        slot
                      </Badge>
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {valuePreview(slot.value)}
                    </pre>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No working memory yet — Atlas hasn&apos;t stashed anything for this conversation.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={resetting || !hasSlots}
              onClick={handleReset}
            >
              {resetting ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
              Reset memory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
