import { Suspense } from "react";
import { cookies } from "next/headers";
import { WorkspaceShell } from "@/ui/components/workspace-shell";

// Server layout. Reads the persisted `sidebar_state` cookie once when entering
// the workspace route group so the rail's collapsed/expanded state survives
// navigation between /, /notebook, and /dashboards without a remount flash.
// Suspense wraps the shell because it calls `useSearchParams()` for active-
// conversation highlighting.
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sidebarDefaultOpen =
    cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <Suspense>
      <WorkspaceShell sidebarDefaultOpen={sidebarDefaultOpen}>
        {children}
      </WorkspaceShell>
    </Suspense>
  );
}
