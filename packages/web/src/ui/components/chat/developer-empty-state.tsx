"use client";

import Link from "next/link";
import { Database, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown in the chat surface when an admin is in developer mode but has no
 * draft connections. Without this, sending a message would let the agent
 * run against nothing and surface a confusing error — instead we redirect
 * them to the admin connections page where they can draft one.
 */
export function DeveloperChatEmptyState() {
  return (
    <div
      role="status"
      data-testid="developer-chat-empty-state"
      className="flex h-full flex-col items-center justify-center gap-4"
    >
      <div className="max-w-md rounded-lg border border-amber-300/60 bg-amber-50/40 px-6 py-8 text-center dark:border-amber-700/40 dark:bg-amber-950/10">
        <Database
          className="mx-auto size-10 text-amber-600 opacity-80 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm font-medium text-foreground">
          No connection configured in developer mode.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect a database in the admin panel to start testing.
        </p>
        <div className="mt-4">
          <Button asChild size="sm" variant="default">
            <Link href="/admin/connections">
              Go to connections
              <ArrowRight className="ml-1.5 size-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
