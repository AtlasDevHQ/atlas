"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutDashboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { NewDashboardDialog } from "@/ui/components/dashboards/new-dashboard-dialog";
import { authClient } from "@/lib/auth/client";

export function DashboardsEmptyState() {
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  const isAdmin =
    user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950">
      <NavBar isAdmin={isAdmin} />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <LayoutDashboard className="size-8 text-zinc-400 dark:text-zinc-500" />
          </div>
          <h1 className="mb-1 text-base font-medium text-zinc-900 dark:text-zinc-100">
            No dashboards yet
          </h1>
          <p className="mb-6 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Ask a question in chat, get a result, and click the Dashboard button
            to pin it here.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="outline" size="sm" asChild>
              <Link href="/">Go to chat</Link>
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Create your first dashboard
            </Button>
          </div>
        </div>
      </main>

      <NewDashboardDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
