"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldX } from "lucide-react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";

export default function Forbidden() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-destructive/10">
            <ShieldX className="size-6 text-destructive" />
          </div>
          <CardTitle className="text-2xl">Access denied</CardTitle>
          <CardDescription>
            You don&apos;t have permission to access this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild variant="outline" className="w-full">
            <Link href="/">Back to chat</Link>
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => authClient.signOut().then(() => window.location.assign("/login"))}
          >
            Sign in as a different user
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
