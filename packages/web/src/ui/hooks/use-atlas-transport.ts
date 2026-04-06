"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AUTH_MODES, type AuthMode } from "../lib/types";
import { applyBrandColor, OKLCH_RE } from "./use-dark-mode";

const API_KEY_STORAGE_KEY = "atlas-api-key";

// Module-level cache — survives client-side navigation (component unmount/remount).
let _cachedAuthMode: AuthMode | null = null;
let _cachedBrandColor: string | null = null;

export interface UseAtlasTransportOptions {
  apiUrl: string;
  isCrossOrigin: boolean;
  /** Returns current conversation ID. Called by transport at fetch time. */
  getConversationId: () => string | null;
  /** Called when a new conversation ID is captured from x-conversation-id response header */
  onNewConversationId: (id: string) => void;
}

export interface UseAtlasTransportReturn {
  transport: DefaultChatTransport<UIMessage>;
  authMode: AuthMode | null;
  authResolved: boolean;
  apiKey: string;
  setApiKey: (key: string) => void;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
  healthWarning: string;
}

export function useAtlasTransport(
  opts: UseAtlasTransportOptions,
): UseAtlasTransportReturn {
  const { apiUrl, isCrossOrigin } = opts;

  // --- Callback refs (stable across renders, never in useMemo deps) ---
  const getConversationIdRef = useRef(opts.getConversationId);
  getConversationIdRef.current = opts.getConversationId;

  const onNewConversationIdRef = useRef(opts.onNewConversationId);
  onNewConversationIdRef.current = opts.onNewConversationId;

  // Internal ref — synced from getter every render, eagerly written on capture
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = getConversationIdRef.current();

  // --- Auth state (seed from module cache to avoid flash on client-side nav) ---
  const [authMode, setAuthModeState] = useState<AuthMode | null>(_cachedAuthMode);
  const [healthWarning, setHealthWarning] = useState("");

  // Reapply cached brand color on mount so it doesn't flash to default
  useEffect(() => {
    if (_cachedBrandColor) applyBrandColor(_cachedBrandColor);
  }, []);
  const setAuthMode = useCallback((mode: AuthMode) => {
    _cachedAuthMode = mode;
    setAuthModeState(mode);
  }, []);
  const [apiKey, setApiKeyState] = useState("");

  // Load API key from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(API_KEY_STORAGE_KEY);
      if (stored) setApiKeyState(stored);
    } catch (err: unknown) {
      console.warn(
        "Cannot read API key from sessionStorage:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  // Combined setter: state + sessionStorage
  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key);
    try {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
    } catch (err: unknown) {
      console.warn(
        "Could not persist API key to sessionStorage:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  // --- Auth helpers ---
  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }, [apiKey]);

  const getCredentials = useCallback(
    (): RequestCredentials => (isCrossOrigin ? "include" : "same-origin"),
    [isCrossOrigin],
  );

  // --- Health check with retry (skip if cached from prior mount) ---
  useEffect(() => {
    if (_cachedAuthMode !== null) return;
    let cancelled = false;

    async function fetchHealth(attempt: number): Promise<void> {
      try {
        const res = await fetch(`${apiUrl}/api/health`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) {
          console.warn(`Health check returned ${res.status}`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
            return fetchHealth(attempt + 1);
          }
          if (!cancelled) {
            setHealthWarning(
              "Health check failed — check server logs. Try refreshing the page.",
            );
            setAuthMode("none");
          }
          return;
        }
        let data: Record<string, unknown>;
        try {
          data = await res.json();
        } catch (parseErr: unknown) {
          console.warn(
            "Health check returned invalid JSON:",
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
          if (!cancelled) {
            setHealthWarning(
              "Health check returned an unreadable response. Check that no reverse proxy is modifying API responses.",
            );
            setAuthMode("none");
          }
          return;
        }
        const checks = data?.checks as Record<string, Record<string, unknown>> | undefined;
        const mode = checks?.auth?.mode;
        if (!cancelled) {
          if (
            typeof mode === "string" &&
            AUTH_MODES.includes(mode as AuthMode)
          ) {
            setAuthMode(mode as AuthMode);
          } else {
            console.warn(
              "Health check succeeded but returned no valid auth mode:",
              data,
            );
            setHealthWarning(
              "Server returned an unexpected authentication configuration.",
            );
            setAuthMode("none");
          }
          // Apply admin-configured brand color (with validation)
          if (
            typeof data?.brandColor === "string" &&
            OKLCH_RE.test(data.brandColor.trim())
          ) {
            _cachedBrandColor = data.brandColor;
            applyBrandColor(data.brandColor);
          }
        }
      } catch (err: unknown) {
        console.warn("Health endpoint unavailable:", err);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          return fetchHealth(attempt + 1);
        }
        if (!cancelled) {
          const detail = err instanceof Error ? err.message : String(err);
          setHealthWarning(
            `Unable to reach the API server (${detail}). Try refreshing the page.`,
          );
          setAuthMode("none");
        }
      }
    }

    fetchHealth(1);
    return () => {
      cancelled = true;
    };
  }, [apiUrl, isCrossOrigin]);

  // --- Transport ---
  // conversationId is accessed via ref (not state) to avoid recreating the
  // transport mid-stream, which triggers an infinite re-render loop in useChat.
  // Callback refs (getConversationId, onNewConversationId) follow the same pattern.
  // authMode: not read directly, but forces transport re-creation after auth resolves.
  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      headers,
      credentials: isCrossOrigin ? "include" : undefined,
      body: () =>
        conversationIdRef.current
          ? { conversationId: conversationIdRef.current }
          : {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        let response: Response;
        try {
          response = await globalThis.fetch(input, init);
        } catch (err: unknown) {
          console.error(
            "Chat transport fetch failed:",
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          conversationIdRef.current = convId; // Write immediately so the next request in this stream uses the new ID (before React re-renders)
          onNewConversationIdRef.current(convId);
        }
        return response;
      }) as typeof fetch,
    });
  }, [apiKey, authMode, apiUrl, isCrossOrigin]);

  return {
    transport,
    authMode,
    authResolved: authMode !== null,
    apiKey,
    setApiKey,
    getHeaders,
    getCredentials,
    healthWarning,
  };
}
