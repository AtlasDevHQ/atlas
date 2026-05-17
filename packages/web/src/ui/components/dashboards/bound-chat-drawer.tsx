"use client";

/**
 * Bound chat drawer (#2363).
 *
 * Right-side Sheet that opens on `/dashboards/[id]` and runs a chat
 * conversation bound to that dashboard. Each drawer-open creates a
 * fresh conversation (a new `useChat` instance, new transport, new
 * conversation row on the server) — past sessions for this dashboard
 * are listed in the History tab in slice #2368.
 *
 * Last-write-wins is intentional in this tracer-bullet: safe mutations
 * (addCard, updateCard title/chartConfig/layout, updateDashboardMeta)
 * commit immediately to the published dashboard. Drafts arrive in
 * #2364; destructive ops + ghost overlays in #2365.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, MessagesSquare } from "lucide-react";
import { useAtlasConfig } from "@/ui/context";
import { Markdown } from "@/ui/components/chat/markdown";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { TypingIndicator } from "@/ui/components/chat/typing-indicator";
import { parseSuggestions } from "@/ui/lib/helpers";
import { isToolUIPart } from "ai";

interface BoundChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  dashboardTitle: string;
  /**
   * Called whenever a tool completes — the dashboard view re-fetches so
   * the new card / updated title / new layout shows up immediately. The
   * tracer-bullet doesn't try to be surgical about which tools warrant
   * a refetch; every tool result triggers one. Plenty of room for
   * smarter invalidation in a follow-up.
   */
  onDashboardMutated?: () => void;
}

export function BoundChatDrawer({
  open,
  onOpenChange,
  dashboardId,
  dashboardTitle,
  onDashboardMutated,
}: BoundChatDrawerProps) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [input, setInput] = useState("");
  // Tracks the active server-side conversation row. `null` on first
  // turn (the route creates one + binds it); subsequent turns pin to it.
  const conversationIdRef = useRef<string | null>(null);
  // Bumped whenever the user closes-and-reopens the drawer so each
  // session is a fresh `useChat` instance with its own message list +
  // its own server-side conversation row.
  const [sessionKey, setSessionKey] = useState(0);

  // Reset session id + conversation pointer on every drawer open. This
  // matches the PRD's "fresh conversation per drawer-open" requirement
  // (each open starts a new bound conversation; history accessible via
  // the #2368 tab).
  useEffect(() => {
    if (open) {
      conversationIdRef.current = null;
      setSessionKey((k) => k + 1);
    }
  }, [open]);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      credentials: isCrossOrigin ? "include" : undefined,
      body: () => {
        const body: Record<string, string> = {
          // #2363 — the route stamps this onto the conversation row on
          // the conversation-creating turn. Sent on every turn for
          // symmetry; the server ignores it once the row is bound.
          boundDashboardId: dashboardId,
        };
        if (conversationIdRef.current) {
          body.conversationId = conversationIdRef.current;
        }
        return body;
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await globalThis.fetch(input, init);
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          conversationIdRef.current = convId;
        }
        return response;
      }) as typeof fetch,
    });
    // sessionKey forces a transport rebuild between sessions so the
    // `useChat` instance below picks up the cleared conversation ref.
  }, [apiUrl, isCrossOrigin, dashboardId, sessionKey]);

  const { messages, sendMessage, status, error } = useChat({
    transport,
    // useChat re-mounts when the key on the calling component changes.
    // We don't need onData here — bound mode doesn't surface Python
    // progress and the bound editor tools don't emit custom data parts.
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Refetch the dashboard whenever a tool result lands. The bound editor
  // tools mutate cards/title/layout — viewers expect the canvas to
  // update without a manual reload. We watch the tool-part status on
  // the latest assistant message rather than running on every render
  // (cheap, but explicit).
  const lastMsg = messages[messages.length - 1];
  const lastMsgId = lastMsg?.id;
  const lastMsgToolFingerprint = useMemo(() => {
    if (!lastMsg || lastMsg.role !== "assistant") return "";
    let fp = "";
    for (const part of lastMsg.parts ?? []) {
      if (!isToolUIPart(part)) continue;
      const p = part as { state?: string; toolCallId?: string };
      fp += `${p.toolCallId ?? ""}:${p.state ?? ""};`;
    }
    return fp;
  }, [lastMsg]);

  useEffect(() => {
    if (!onDashboardMutated || !lastMsgToolFingerprint) return;
    // The fingerprint changes when a tool transitions to a terminal
    // state ("output-available" / "output-error"). Treat any change as
    // potential dashboard mutation — false positives are cheap (an
    // extra GET) and false negatives leave the canvas stale.
    if (lastMsgToolFingerprint.includes("output-available")) {
      onDashboardMutated();
    }
  }, [lastMsgToolFingerprint, lastMsgId, onDashboardMutated]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || isLoading) return;
      setInput("");
      await sendMessage({ text });
    },
    [input, isLoading, sendMessage],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-[560px] lg:max-w-[640px]"
      >
        <SheetHeader className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <MessagesSquare className="size-4 text-primary" aria-hidden="true" />
            <SheetTitle className="text-base font-semibold">Edit with chat</SheetTitle>
          </div>
          <SheetDescription className="text-xs text-zinc-500 dark:text-zinc-400">
            Bound to <span className="font-medium text-zinc-700 dark:text-zinc-300">{dashboardTitle}</span> — safe edits commit immediately.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-3">
          {messages.length === 0 && (
            <div className="space-y-3 py-6 text-sm text-zinc-500 dark:text-zinc-400">
              <p>
                Tell the agent what to change. Examples:
              </p>
              <ul className="space-y-1 pl-4">
                <li>&ldquo;Add a card showing weekly signups&rdquo;</li>
                <li>&ldquo;Rename card 2 to &lsquo;Active Users&rsquo;&rdquo;</li>
                <li>&ldquo;Make card 3 a bar chart&rdquo;</li>
                <li>&ldquo;What is card 1 counting?&rdquo;</li>
              </ul>
            </div>
          )}

          {messages.map((m: UIMessage) => (
            <BoundChatMessage key={m.id} message={m} />
          ))}

          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="my-2">
              <TypingIndicator />
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="my-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
            >
              {error.message || "The agent hit an error. Try again."}
            </div>
          )}
        </ScrollArea>

        <form
          onSubmit={handleSubmit}
          className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
        >
          <div className="flex items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the agent to edit this dashboard…"
              disabled={isLoading}
              autoFocus
              className="flex-1"
              aria-label="Message"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || isLoading}>
              <Send className="size-4" aria-hidden="true" />
              <span className="sr-only">Send</span>
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function BoundChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  // Split text and tool parts so tool results render inline as cards
  // between the assistant's text turns (matches the main AtlasChat
  // layout convention).
  const parts = message.parts ?? [];

  if (isUser) {
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return (
      <div className="my-3 flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="my-3 space-y-2">
      {parts.map((part, idx) => {
        if (part.type === "text" && "text" in part) {
          // parseSuggestions splits assistant text into the body + a
          // trailing <suggestions> block. The bound prompt asks the
          // agent to emit those; we render only the body in this slice
          // — chips land in a polish pass.
          const { text } = parseSuggestions(part.text);
          return <Markdown key={`t-${idx}`} content={text} />;
        }
        if (isToolUIPart(part)) {
          return <ToolPart key={`tool-${idx}`} part={part} />;
        }
        return null;
      })}
    </div>
  );
}
