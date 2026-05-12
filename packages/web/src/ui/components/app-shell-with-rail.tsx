"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AppLayout } from "@/ui/components/app-layout";
import { ChatSidebar } from "@/ui/components/chat/chat-sidebar";
import { SchemaExplorer } from "@/ui/components/schema-explorer/schema-explorer";
import { PromptLibrary } from "@/ui/components/chat/prompt-library";
import { CommandPalette } from "@/ui/components/chat/command-palette";
import { useConversations } from "@/ui/hooks/use-conversations";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { authClient } from "@/lib/auth/client";

export function AppShellWithRail({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = authClient.useSession();
  const role = useUserRole();
  const isAdmin =
    role === "admin" || role === "owner" || role === "platform_admin";
  const isSignedIn = !!session.data?.user;

  const [schemaOpen, setSchemaOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
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

  const sidebar = convos.available ? (
    <ChatSidebar
      conversations={convos.conversations}
      selectedId={null}
      loading={convos.loading}
      isAdmin={isAdmin}
      onSelect={(id) => router.push(`/?id=${id}`)}
      onDelete={(id) => convos.deleteConversation(id)}
      onStar={(id, starred) => convos.starConversation(id, starred)}
      onConvertToNotebook={(id) => convos.convertToNotebook(id)}
      onNewChat={() => router.push("/")}
      onOpenPromptLibrary={() => setPromptOpen(true)}
      onOpenSchemaExplorer={() => setSchemaOpen(true)}
    />
  ) : null;

  return (
    <>
      <AppLayout sidebar={sidebar}>
        {convos.available && (
          <div className="border-b border-zinc-100 px-4 py-2 dark:border-zinc-800/60 md:hidden">
            <SidebarTrigger />
          </div>
        )}
        {children}
      </AppLayout>
      <SchemaExplorer
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        onInsertQuery={(text) => router.push(`/?prompt=${encodeURIComponent(text)}`)}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <PromptLibrary
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSendPrompt={(text) => router.push(`/?prompt=${encodeURIComponent(text)}`)}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <CommandPalette
        conversations={convos.conversations}
        onNewChat={() => router.push("/")}
        onSelectConversation={(id) => router.push(`/?id=${id}`)}
        onOpenPromptLibrary={() => setPromptOpen(true)}
        onOpenSchemaExplorer={() => setSchemaOpen(true)}
      />
    </>
  );
}
