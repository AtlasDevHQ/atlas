"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BookOpen,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Star,
  TableProperties,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConversationList } from "@/ui/components/conversations/conversation-list";
import { SidebarUserMenu } from "./sidebar-user-menu";
import { DemoIndicatorChip } from "@/ui/components/demo-indicator-chip";
import { PALETTE_EVENT } from "./palette-events";
import type { Conversation } from "@/ui/lib/types";

type SidebarFilter = "all" | "saved";

interface ChatSidebarProps {
  conversations: Conversation[];
  selectedId: string | null;
  loading: boolean;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onStar: (id: string, starred: boolean) => Promise<void>;
  onNewChat: () => void;
  onOpenPromptLibrary: () => void;
  onOpenSchemaExplorer: () => void;
}

// Mirrors AdminSidebar's shadcn collapsible="icon" pattern so both halves
// of the app share one shell.
export function ChatSidebar({
  conversations,
  selectedId,
  loading,
  isAdmin,
  onSelect,
  onDelete,
  onStar,
  onNewChat,
  onOpenPromptLibrary,
  onOpenSchemaExplorer,
}: ChatSidebarProps) {
  const pathname = usePathname();
  const { setOpenMobile, isMobile } = useSidebar();
  const [filter, setFilter] = useState<SidebarFilter>("all");

  const starredConversations = conversations.filter((c) => c.starred);
  const filteredConversations =
    filter === "saved" ? starredConversations : conversations;

  // Close the mobile drawer after a conversation pick so the chat surface
  // gains focus on small screens — desktop is unaffected.
  function closeMobileAfter<T extends (...args: never[]) => unknown>(fn: T): T {
    return ((...args: Parameters<T>) => {
      const result = fn(...args);
      if (isMobile) setOpenMobile(false);
      return result;
    }) as T;
  }

  const sectionItems = [
    { href: "/", label: "Chat", icon: MessageSquare, exact: true },
    { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard, exact: false },
  ] as const;

  function isSectionActive(item: (typeof sectionItems)[number]) {
    return item.exact ? pathname === item.href : pathname.startsWith(item.href);
  }

  function openPalette() {
    window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild tooltip="Atlas home">
                <Link href="/" aria-label="Atlas home">
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <svg
                      viewBox="0 0 256 256"
                      fill="none"
                      className="size-4"
                      aria-hidden="true"
                    >
                      <path
                        d="M128 24 L232 208 L24 208 Z"
                        stroke="currentColor"
                        strokeWidth="20"
                        fill="none"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm leading-tight">
                    <span className="truncate font-semibold">Atlas</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarTrigger
            aria-label="Collapse sidebar"
            className="shrink-0 group-data-[collapsible=icon]:hidden"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={onNewChat}
                  tooltip="New conversation"
                >
                  <Plus />
                  <span>New conversation</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={openPalette} tooltip="Search (⌘K)">
                  <Search />
                  <span>Search</span>
                  <kbd className="ml-auto rounded border border-sidebar-border px-1 py-0.5 font-mono text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
                    ⌘K
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            {sectionItems.map((item) => {
              const Icon = item.icon;
              const active = isSectionActive(item);
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <Icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel className="flex items-center justify-between">
            <span>Recents</span>
            <DemoIndicatorChip />
          </SidebarGroupLabel>
          <div className="px-2 pb-1">
            <ToggleGroup
              type="single"
              size="sm"
              value={filter}
              onValueChange={(val) => {
                if (val === "all" || val === "saved") setFilter(val);
              }}
              className="gap-1"
            >
              <ToggleGroupItem
                value="all"
                className="px-2.5 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                All
              </ToggleGroupItem>
              <ToggleGroupItem
                value="saved"
                className="gap-1.5 px-2.5 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
              >
                <Star className="size-3" fill={filter === "saved" ? "currentColor" : "none"} />
                Saved
                {starredConversations.length > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-semibold">
                    {starredConversations.length}
                  </Badge>
                )}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <SidebarGroupContent className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-1">
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
                    onSelect={closeMobileAfter(onSelect)}
                    onDelete={onDelete}
                    onStar={onStar}
                    showSections={filter === "all"}
                    emptyMessage={
                      filter === "saved"
                        ? "Star conversations to save them here"
                        : undefined
                    }
                  />
                )}
              </div>
            </ScrollArea>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onOpenSchemaExplorer}
              tooltip="Schema explorer"
            >
              <TableProperties />
              <span>Schema explorer</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onOpenPromptLibrary}
              tooltip="Prompt library"
            >
              <BookOpen />
              <span>Prompt library</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Admin console">
                <Link href="/admin" data-tour="admin">
                  <Settings />
                  <span>Admin</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarUserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
