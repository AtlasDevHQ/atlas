"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/ui/components/app-layout";
import { ChatSidebar } from "@/ui/components/chat/chat-sidebar";
import { SchemaExplorer } from "@/ui/components/schema-explorer/schema-explorer";
import { PromptLibrary } from "@/ui/components/chat/prompt-library";
import { CommandPalette } from "@/ui/components/chat/command-palette";
import { useConversations } from "@/ui/hooks/use-conversations";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { authClient } from "@/lib/auth/client";

/**
 * Convenience shell for routes that want the unified rail but don't own a
 * chat state (e.g. `/dashboards`, server-rendered redirect surfaces). Wires
 * its own conversations hook + modal state, and routes rail actions back to
 * `/` so the chat surface stays the conversation home:
 *
 * - Selecting a conversation navigates to `/?id=<convId>`
 * - "New conversation" navigates to `/`
 * - "Send a prompt" from the library prefills `/?prompt=<text>` (chat picks
 *   it up via the existing `useQueryStates` prefill effect)
 *
 * `/` itself uses `<ChatSidebar>` directly via `<AppLayout>` so it can swap
 * in inline-load handlers. Notebook does the same. This shell is the
 * lightweight escape hatch for everything else.
 */
export function AppShellWithRail({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = authClient.useSession();
  const user = session.data?.user as { role?: string } | undefined;
  const isAdmin =
    user?.role === "admin" ||
    user?.role === "owner" ||
    user?.role === "platform_admin";
  const isSignedIn = !!user;

  const [schemaOpen, setSchemaOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [transportReady, setTransportReady] = useState(false);

  const { authMode, getHeaders, getCredentials, authResolved } = useAtlasTransport({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
    getConversationId: () => null,
    // The shell never starts a new conversation directly — selecting "New
    // conversation" routes to `/`, where the chat surface owns the transport
    // and the new-id callback. No-op here keeps the hook contract honored.
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

  useEffect(() => {
    if (!isSignedIn || !transportReady) return;
    convos.fetchList().catch((err: unknown) => {
      console.debug(
        "[app-shell] convos.fetchList rejected:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [authMode, transportReady, isSignedIn, convos.fetchList]);

  const sidebar = (
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
  );

  return (
    <>
      <AppLayout sidebar={sidebar}>{children}</AppLayout>
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
