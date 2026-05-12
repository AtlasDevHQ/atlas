"use client";

import { useEffect, useState } from "react";
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

export function CommandPalette({
  conversations,
  onNewChat,
  onSelectConversation,
  onOpenPromptLibrary,
  onOpenSchemaExplorer,
}: {
  conversations: Conversation[];
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onOpenPromptLibrary: () => void;
  onOpenSchemaExplorer: () => void;
}) {
  const tour = useTourContext();
  const [open, setOpen] = useState(false);

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

  function run(action: () => void) {
    setOpen(false);
    // Defer so the dialog can close before the action mutates state
    // (e.g. opening another dialog/sheet).
    setTimeout(action, 0);
  }

  // Top 8 recent conversations as quick switchers; starred float to the top.
  const recent = [...conversations]
    .toSorted((a, b) => Number(!!b.starred) - Number(!!a.starred))
    .slice(0, 8);

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
              run(() => window.open("https://docs.useatlas.dev", "_blank", "noopener"))
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
