"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

const AUTH_MODE = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";

/** Routes that don't require authentication. */
const publicPrefixes = ["/demo", "/shared", "/login", "/signup", "/wizard"];

function isPublicRoute(pathname: string): boolean {
  return publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Client-side auth guard for managed auth mode.
 *
 * Redirects unauthenticated users to /login. The proxy (src/proxy.ts)
 * should handle this server-side, but this is a safety net so users
 * never see the @useatlas/react inline ManagedAuthCard.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = authClient.useSession();
  const isSignedIn = !!session.data?.user;

  useEffect(() => {
    if (
      AUTH_MODE === "managed" &&
      !session.isPending &&
      !isSignedIn &&
      !isPublicRoute(pathname)
    ) {
      router.replace("/login");
    }
  }, [session.isPending, isSignedIn, pathname, router]);

  return <>{children}</>;
}
