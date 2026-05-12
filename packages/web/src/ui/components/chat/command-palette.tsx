"use client";

import { useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  BookOpen,
  Compass,
  ExternalLink,
  MessageSquare,
  MessageSquarePlus,
  Star,
  TableProperties,
} from "lucide-react";
import type { Conversation } from "../../lib/types";
import { useTourContext } from "@/ui/components/tour/guided-tour";

const SHORTCUTS_EVENT = "atlas:open-shortcuts";
const MAX_RECENT_CONVERSATIONS = 8;

export function CommandPalette({
  conversations,
  onNewChat,
  onSelectConversation,
  onOpenPromptLibrary,
  onOpenSchemaExplorer,
}: {
  /**
   * Full conversation list. The palette internally sorts starred-first and
   * surfaces the top {@link MAX_RECENT_CONVERSATIONS} as quick switchers —
   * callers should pass the unfiltered list.
   */
  conversations: Conversation[];
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onOpenPromptLibrary: () => void;
  onOpenSchemaExplorer: () => void;
}) {
  const tour = useTourContext();
  const [open, setOpen] = useState(false);
  // Tracks pending defer-after-close timers so they're cleared if the
  // palette unmounts (route change) before the action fires — otherwise
  // the action runs against an unmounted tree.
  const pendingTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Global Cmd/Ctrl-K to open the palette + listen for the help-menu event
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const isPaletteShortcut =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isPaletteShortcut) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      // `?` opens the palette only when the user isn't typing in a field —
      // otherwise typing "?" anywhere would steal focus.
      const target = e.target as HTMLElement | null;
      const isInField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "?" && !isInField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    function handleHelpEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", handleKey);
    window.addEventListener(SHORTCUTS_EVENT, handleHelpEvent);
    return () => {
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener(SHORTCUTS_EVENT, handleHelpEvent);
    };
  }, []);

  // Clear any deferred actions still in flight when the palette unmounts.
  useEffect(() => {
    const timers = pendingTimers.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  function run(action: () => void | Promise<void>) {
    setOpen(false);
    // Defer past Radix's close cleanup so a follow-on dialog/sheet doesn't
    // open into an inert body (Radix Dialog leaves `pointer-events: none`
    // on `<body>` for a frame after close). `Promise.resolve(...).catch`
    // guards against both synchronous throws and async rejections from the
    // user-supplied action — without this the rejection has no owner.
    const timer = setTimeout(() => {
      pendingTimers.current.delete(timer);
      Promise.resolve()
        .then(() => action())
        .catch((err: unknown) => {
          console.warn(
            "[command-palette] action failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 0);
    pendingTimers.current.add(timer);
  }

  const recent = [...conversations]
    .toSorted((a, b) => Number(!!b.starred) - Number(!!a.starred))
    .slice(0, MAX_RECENT_CONVERSATIONS);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search for an action or jump to a conversation"
    >
      <CommandInput placeholder="Type a command or search conversations…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onNewChat)}>
            <MessageSquarePlus />
            <span>New conversation</span>
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenPromptLibrary)}>
            <BookOpen />
            <span>Prompt library</span>
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenSchemaExplorer)}>
            <TableProperties />
            <span>Schema explorer</span>
          </CommandItem>
          {tour && (
            <CommandItem onSelect={() => run(() => tour.startTour())}>
              <Compass />
              <span>Replay guided tour</span>
            </CommandItem>
          )}
          <CommandItem
            onSelect={() =>
              run(() => {
                window.open("https://docs.useatlas.dev", "_blank", "noopener");
              })
            }
          >
            <ExternalLink />
            <span>Documentation</span>
          </CommandItem>
        </CommandGroup>

        {recent.length > 0 && (
          <CommandGroup heading="Recent conversations">
            {recent.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.title || "New conversation"} ${c.id}`}
                onSelect={() => run(() => onSelectConversation(c.id))}
              >
                {c.starred ? (
                  <Star className="text-amber-400" fill="currentColor" />
                ) : (
                  <MessageSquare />
                )}
                <span className="truncate">{c.title || "New conversation"}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Shortcuts">
          <CommandItem disabled>
            <span className="flex-1">Send message</span>
            <kbd className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Enter
            </kbd>
          </CommandItem>
          <CommandItem disabled>
            <span className="flex-1">Open this palette</span>
            <kbd className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              ⌘ K
            </kbd>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
