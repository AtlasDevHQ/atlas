"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { AtlasProvider } from "@/ui/context";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

const AUTH_MODE = process.env.NEXT_PUBLIC_ATLAS_AUTH_MODE ?? "";

/** Routes that don't require authentication. */
const publicPrefixes = ["/demo", "/shared", "/report", "/login", "/signup", "/wizard"];

function isPublicRoute(pathname: string): boolean {
  return publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Client-side auth guard and app-wide context provider.
 *
 * Wraps all pages in AtlasProvider (apiUrl, isCrossOrigin, authClient)
 * so any component can call useAtlasConfig() without per-layout wrappers.
 *
 * Redirects unauthenticated users to /login in managed auth mode.
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

  return (
    <AtlasProvider config={{ apiUrl: getApiUrl(), isCrossOrigin: isCrossOrigin(), authClient }}>
      {children}
    </AtlasProvider>
  );
}
