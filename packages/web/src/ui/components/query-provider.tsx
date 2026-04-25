"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

const SHOW_QUERY_DEVTOOLS = process.env.NODE_ENV !== "production";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 30s stale time avoids refetching on every mount during admin page navigation.
        staleTime: 30_000,
        // Single retry — the admin API is either up or requires auth re-flow.
        retry: 1,
        refetchOnWindowFocus: true,
        gcTime: 5 * 60 * 1000,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {SHOW_QUERY_DEVTOOLS && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
