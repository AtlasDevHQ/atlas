"use client";

import { useState } from "react";
import { Plus, Star } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "radix-ui";
import type { Conversation } from "../../lib/types";
import { ConversationList } from "./conversation-list";
import { DemoIndicatorChip } from "../demo-indicator-chip";
import { useUiStore } from "@/lib/stores/ui-store";

type SidebarFilter = "all" | "saved";

export function ConversationSidebar({
  conversations,
  selectedId,
  loading,
  onSelect,
  onDelete,
  onStar,
  onConvertToNotebook,
  onNewChat,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onStar: (id: string, starred: boolean) => Promise<void>;
  onConvertToNotebook?: (id: string) => Promise<{ id: string }>;
  onNewChat: () => void;
}) {
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const mobileOpen = useUiStore((s) => s.mobileSidebarOpen);
  const setMobileOpen = useUiStore((s) => s.setMobileSidebarOpen);

  const starredConversations = conversations.filter((c) => c.starred);
  const filteredConversations = filter === "saved" ? starredConversations : conversations;

  const sidebar = (
    <div className="flex h-full flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-zinc-700 dark:text-zinc-300">History</span>
          <DemoIndicatorChip />
        </div>
      </div>

      <div className="border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <Button
          onClick={onNewChat}
          size="sm"
          className="h-9 w-full justify-start gap-2 font-medium"
        >
          <Plus className="size-4" />
          New conversation
        </Button>
      </div>

      <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <ToggleGroup
          type="single"
          size="sm"
          value={filter}
          onValueChange={(val) => { if (val) setFilter(val as SidebarFilter); }}
          className="gap-1"
        >
          <ToggleGroupItem
            value="all"
            className="px-2.5 text-sm data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
          >
            All
          </ToggleGroupItem>
          <ToggleGroupItem
            value="saved"
            className="gap-1.5 px-2.5 text-sm data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
          >
            <Star className="h-3 w-3" fill={filter === "saved" ? "currentColor" : "none"} />
            Saved
            {starredConversations.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-semibold">
                {starredConversations.length}
              </Badge>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          {loading && conversations.length === 0 ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ConversationList
              conversations={filteredConversations}
              selectedId={selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
              onStar={onStar}
              onConvertToNotebook={onConvertToNotebook}
              showSections={filter === "all"}
              emptyMessage={filter === "saved" ? "Star conversations to save them here" : undefined}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden w-[280px] shrink-0 md:block">
        {sidebar}
      </div>

      {/* Mobile drawer — Sheet provides focus trap, scroll lock, and Esc out of the box */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[280px] p-0 sm:max-w-[280px] md:hidden"
        >
          <VisuallyHidden.Root>
            <SheetTitle>Conversation history</SheetTitle>
          </VisuallyHidden.Root>
          {sidebar}
        </SheetContent>
      </Sheet>
    </>
  );
}
