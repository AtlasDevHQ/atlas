"use client";

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
import { GlobalCommandPalette, type PaletteGroup } from "../palette";

const MAX_RECENT_CONVERSATIONS = 8;

/**
 * Chat-surface wrapper around `GlobalCommandPalette`. Supplies chat-only
 * groups (new conversation, prompt library, schema explorer, recent
 * conversations, replay tour); routes and settings come from the shared
 * registry.
 */
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

  const recent = [...conversations]
    .toSorted((a, b) => Number(!!b.starred) - Number(!!a.starred))
    .slice(0, MAX_RECENT_CONVERSATIONS);

  const actions: PaletteGroup = {
    heading: "Actions",
    items: [
      {
        id: "chat:new",
        title: "New conversation",
        icon: MessageSquarePlus,
        action: { kind: "run", run: onNewChat },
      },
      {
        id: "chat:prompts",
        title: "Prompt library",
        icon: BookOpen,
        action: { kind: "run", run: onOpenPromptLibrary },
      },
      {
        id: "chat:schema",
        title: "Schema explorer",
        icon: TableProperties,
        action: { kind: "run", run: onOpenSchemaExplorer },
      },
      ...(tour
        ? [
            {
              id: "chat:tour",
              title: "Replay guided tour",
              icon: Compass,
              action: { kind: "run" as const, run: () => tour.startTour() },
            },
          ]
        : []),
      {
        id: "chat:docs",
        title: "Documentation",
        icon: ExternalLink,
        action: {
          kind: "run",
          run: () => {
            window.open("https://docs.useatlas.dev", "_blank", "noopener");
          },
        },
      },
    ],
  };

  const recents: PaletteGroup = {
    heading: "Recent conversations",
    items: recent.map((c) => ({
      id: `convo:${c.id}`,
      title: c.title || "New conversation",
      icon: c.starred ? Star : MessageSquare,
      action: { kind: "run", run: () => onSelectConversation(c.id) },
      keywords: [c.id],
    })),
  };

  const extraGroups: PaletteGroup[] =
    recents.items.length > 0 ? [actions, recents] : [actions];

  return <GlobalCommandPalette extraGroups={extraGroups} />;
}
