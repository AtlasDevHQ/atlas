"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ChatSidebar } from "@/ui/components/chat/chat-sidebar";
import { SchemaExplorer } from "@/ui/components/schema-explorer/schema-explorer";
import { PromptLibrary } from "@/ui/components/chat/prompt-library";
import { CommandPalette } from "@/ui/components/chat/command-palette";
import { useConversations } from "@/ui/hooks/use-conversations";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { useUiStore } from "@/lib/stores/ui-store";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { authClient } from "@/lib/auth/client";
import {
  buildPromptDeliveryUrl,
  isNotebookRoute,
} from "@/ui/components/prompt-delivery";

// One persistent shell above /, /notebook, and /dashboards. Mounted by the
// (workspace) route group's server layout so the rail's collapsed/expanded
// state survives navigation between sibling pages without a remount flash.
export function WorkspaceShell({
  sidebarDefaultOpen,
  children,
}: {
  sidebarDefaultOpen: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Pages drive selection through `?id=` — read it here so the rail can
  // highlight the active conversation across /, /notebook, and /dashboards.
  const searchParams = useSearchParams();
  const selectedConversationId = searchParams?.get("id") || null;
  const session = authClient.useSession();
  const role = useUserRole();
  const isAdmin =
    role === "admin" || role === "owner" || role === "platform_admin";
  const isSignedIn = !!session.data?.user;

  const schemaExplorerOpen = useUiStore((s) => s.schemaExplorerOpen);
  const setSchemaExplorerOpen = useUiStore((s) => s.setSchemaExplorerOpen);
  const promptLibraryOpen = useUiStore((s) => s.promptLibraryOpen);
  const setPromptLibraryOpen = useUiStore((s) => s.setPromptLibraryOpen);

  const [transportReady, setTransportReady] = useState(false);

  const { getHeaders, getCredentials, authResolved } = useAtlasTransport({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
    getConversationId: () => null,
    onNewConversationId: () => undefined,
  });

  useEffect(() => {
    if (authResolved) setTransportReady(true);
  }, [authResolved]);

  const convos = useConversations({
    apiUrl: getApiUrl(),
    enabled: isSignedIn && transportReady,
    getHeaders,
    getCredentials,
  });

  // Pathname-aware navigation: keep users on their current surface (chat /
  // notebook) when picking a conversation; otherwise default to chat. Each
  // surface's existing `id` URL-load effect picks up the change and loads.
  function handleSelect(id: string) {
    if (isNotebookRoute(pathname)) {
      router.push(`/notebook?id=${id}`);
    } else {
      router.push(`/?id=${id}`);
    }
  }

  function handleNewChat() {
    if (isNotebookRoute(pathname)) {
      router.push("/notebook");
    } else {
      router.push("/");
    }
  }

  // Modals route their result through a `prompt` URL param. The chat surface
  // prefills the input; the notebook surface sends as a message. Dashboards
  // has no chat input, so we navigate to / before prefilling. The active
  // conversation `?id=` is preserved on chat/notebook (see
  // `buildPromptDeliveryUrl`) so a prefill doesn't clear the open thread.
  function deliverPrompt(text: string) {
    const url = buildPromptDeliveryUrl(pathname, selectedConversationId, text);
    // `replace` on the active surface so the prefill doesn't add a history
    // entry; `push` when arriving from dashboards (a real navigation).
    if (pathname === "/" || isNotebookRoute(pathname)) {
      router.replace(url, { scroll: false });
    } else {
      router.push(url);
    }
  }

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
      className="!min-h-0 h-full"
    >
      {convos.available ? (
        <ChatSidebar
          conversations={convos.conversations}
          selectedId={selectedConversationId}
          loading={convos.loading}
          isAdmin={isAdmin}
          onSelect={handleSelect}
          onDelete={(id) => convos.deleteConversation(id)}
          onStar={(id, starred) => convos.starConversation(id, starred)}
          onConvertToNotebook={(id) => convos.convertToNotebook(id)}
          onNewChat={handleNewChat}
          onOpenPromptLibrary={() => setPromptLibraryOpen(true)}
          onOpenSchemaExplorer={() => setSchemaExplorerOpen(true)}
        />
      ) : null}
      <SidebarInset id="main" tabIndex={-1}>
        {convos.available && (
          <div className="border-b border-zinc-100 px-4 py-2 dark:border-zinc-800/60 md:hidden">
            <SidebarTrigger />
          </div>
        )}
        {children}
      </SidebarInset>
      <SchemaExplorer
        open={schemaExplorerOpen}
        onOpenChange={setSchemaExplorerOpen}
        onInsertQuery={deliverPrompt}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <PromptLibrary
        open={promptLibraryOpen}
        onOpenChange={setPromptLibraryOpen}
        onSendPrompt={deliverPrompt}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <CommandPalette
        conversations={convos.conversations}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelect}
        onOpenPromptLibrary={() => setPromptLibraryOpen(true)}
        onOpenSchemaExplorer={() => setSchemaExplorerOpen(true)}
      />
    </SidebarProvider>
  );
}
