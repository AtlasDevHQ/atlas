"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AtlasMcpError,
  beginConnect,
  completeConnect,
  type BeginConnectResult,
  type CompleteConnectResult,
} from "@useatlas/sdk";

/**
 * `useMcpConnect` (#2079) — wraps the SDK's `beginConnect` + `completeConnect`
 * with a popup-or-redirect lifecycle so React embedders can drop a
 * "Connect your AI agent" button on a page without owning the OAuth
 * bookkeeping.
 *
 * ── Two flow modes ────────────────────────────────────────────────
 *
 * - `mode: "popup"` (default). `connect()` opens a centred popup at
 *   `authorizationUrl`. The redirect URI must be a page hosted by the
 *   embedder that calls `window.opener.postMessage(...)` with
 *   `{ type: "atlas-mcp-callback", code, state }`. The hook listens for
 *   that message, runs `completeConnect`, and exposes the resulting
 *   `accessToken` + `workspaceId`. The popup closes itself on receipt.
 *
 * - `mode: "redirect"`. `connect()` redirects the current window to
 *   `authorizationUrl`. On the callback page, mount the same hook with
 *   the same options — when it sees `?code` + `?state` in the URL it
 *   reads the persisted `state` + `codeVerifier` from `sessionStorage`
 *   and runs `completeConnect`.
 *
 * ── What survives across the round-trip ──────────────────────────
 *
 * In both modes the hook persists `state`, `codeVerifier`, `clientId`,
 * `tokenEndpoint`, and `issuer` under a single `sessionStorage` key
 * (`atlas-mcp-connect:<storageId>`). `storageId` defaults to the
 * `redirectUri`; pass `storageId` if you run multiple onboarding flows
 * on the same origin.
 */

export type UseMcpConnectStatus =
  | "idle"
  | "starting"
  | "awaiting_callback"
  | "exchanging"
  | "success"
  | "error";

export type UseMcpConnectMode = "popup" | "redirect";

export interface UseMcpConnectOptions {
  /** Atlas API base — e.g. `https://mcp.useatlas.dev`. */
  apiUrl: string;
  /** Human-readable name registered via DCR. */
  clientName: string;
  /** Where the OAuth server should redirect the user. */
  redirectUri: string;
  /** Defaults to `["mcp:read", "offline_access"]`. */
  scopes?: ReadonlyArray<string>;
  /** Default `"popup"`. */
  mode?: UseMcpConnectMode;
  /**
   * Override the sessionStorage key suffix when running multiple flows
   * on the same origin. Defaults to `redirectUri`.
   */
  storageId?: string;
}

export interface UseMcpConnectReturn {
  /** Kick off the OAuth flow. */
  connect: () => Promise<void>;
  /** Reset state — also clears the persisted sessionStorage entry. */
  reset: () => void;
  status: UseMcpConnectStatus;
  /** Populated on `status === "success"`. */
  accessToken: string | null;
  refreshToken: string | null;
  workspaceId: string | null;
  expiresAt: number | null;
  /** Populated on `status === "error"`. */
  error: AtlasMcpError | Error | null;
}

interface PersistedState {
  state: string;
  codeVerifier: string;
  clientId: string;
  tokenEndpoint: string;
  issuer: string;
  redirectUri: string;
}

const STORAGE_PREFIX = "atlas-mcp-connect:";
const POPUP_MESSAGE_TYPE = "atlas-mcp-callback";

function storageKey(storageId: string): string {
  return `${STORAGE_PREFIX}${storageId}`;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readPersisted(storageId: string): PersistedState | null {
  if (!isBrowser()) return null;
  const raw = window.sessionStorage.getItem(storageKey(storageId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.codeVerifier === "string" &&
      typeof parsed.clientId === "string" &&
      typeof parsed.tokenEndpoint === "string" &&
      typeof parsed.issuer === "string" &&
      typeof parsed.redirectUri === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    // intentionally ignored: corrupt sessionStorage entry — wipe it
    // and let the caller re-initiate; persisting a parse error in the
    // hook's error state would block any retry until reset() is called.
    window.sessionStorage.removeItem(storageKey(storageId));
    return null;
  }
}

function writePersisted(storageId: string, value: PersistedState): void {
  if (!isBrowser()) return;
  window.sessionStorage.setItem(storageKey(storageId), JSON.stringify(value));
}

function clearPersisted(storageId: string): void {
  if (!isBrowser()) return;
  window.sessionStorage.removeItem(storageKey(storageId));
}

interface PopupCallbackMessage {
  type: typeof POPUP_MESSAGE_TYPE;
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

function isPopupCallbackMessage(value: unknown): value is PopupCallbackMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === POPUP_MESSAGE_TYPE
  );
}

export function useMcpConnect(options: UseMcpConnectOptions): UseMcpConnectReturn {
  const mode = options.mode ?? "popup";
  const storageId = options.storageId ?? options.redirectUri;

  const [status, setStatus] = useState<UseMcpConnectStatus>("idle");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<AtlasMcpError | Error | null>(null);

  // Hold the latest options/storageId/mode in refs so the message handler
  // and effect stay stable across re-renders without resubscribing on
  // every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const storageIdRef = useRef(storageId);
  storageIdRef.current = storageId;

  const applyResult = useCallback(
    (result: CompleteConnectResult) => {
      setAccessToken(result.accessToken);
      setRefreshToken(result.refreshToken);
      setWorkspaceId(result.workspaceId);
      setExpiresAt(result.expiresAt);
      setStatus("success");
    },
    [],
  );

  const applyError = useCallback((err: unknown) => {
    setError(
      err instanceof AtlasMcpError
        ? err
        : err instanceof Error
        ? err
        : new Error(String(err)),
    );
    setStatus("error");
  }, []);

  const exchange = useCallback(
    async (code: string, returnedState: string, persisted: PersistedState) => {
      setStatus("exchanging");
      try {
        const result = await completeConnect({
          apiUrl: optionsRef.current.apiUrl,
          state: returnedState,
          expectedState: persisted.state,
          code,
          codeVerifier: persisted.codeVerifier,
          clientId: persisted.clientId,
          redirectUri: persisted.redirectUri,
          tokenEndpoint: persisted.tokenEndpoint,
          issuer: persisted.issuer,
        });
        clearPersisted(storageIdRef.current);
        applyResult(result);
      } catch (err) {
        applyError(err);
      }
    },
    [applyError, applyResult],
  );

  // Redirect-mode auto-complete: if we land on a page with `?code` +
  // `?state` and a matching persisted entry, finish the exchange.
  useEffect(() => {
    if (mode !== "redirect" || !isBrowser()) return;
    if (status !== "idle") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code || !returnedState) return;
    const persisted = readPersisted(storageId);
    if (!persisted) return;
    void exchange(code, returnedState, persisted);
    // We deliberately do NOT strip ?code/?state from the URL here — the
    // hosting app may need them for its own observation; cleaning up
    // is the embedder's call (e.g. router.replace).
  }, [mode, status, storageId, exchange]);

  // Popup mode: install a `message` listener that resolves the flow when
  // the popup posts back. The listener is installed only while the flow
  // is in `awaiting_callback` — outside that window we don't want to
  // pick up unrelated postMessages.
  const popupRef = useRef<Window | null>(null);
  useEffect(() => {
    if (mode !== "popup" || !isBrowser()) return;
    if (status !== "awaiting_callback") return;

    const handleMessage = (event: MessageEvent) => {
      // Same-origin guard: ignore messages from any other origin. The
      // popup must be hosted on the same origin as the embedder for
      // the postMessage to round-trip. Cross-origin redirect URIs are
      // out of scope for this hook (use `mode: "redirect"` instead).
      if (event.origin !== window.location.origin) return;
      if (!isPopupCallbackMessage(event.data)) return;
      const data = event.data;
      const persisted = readPersisted(storageIdRef.current);

      // Best-effort close of the popup — some browsers reject a parent
      // closing a popup the parent didn't open, so swallow.
      if (popupRef.current && !popupRef.current.closed) {
        try {
          popupRef.current.close();
        } catch {
          // intentionally ignored: closing the popup is a courtesy;
          // the user can close it manually if the browser refuses.
        }
      }
      popupRef.current = null;

      if (data.error || !data.code || !data.state || !persisted) {
        applyError(
          new AtlasMcpError(
            data.error
              ? `Authorization server returned error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`
              : !persisted
              ? `OAuth callback received but the persisted flow state is missing — sessionStorage was cleared mid-flow.`
              : `OAuth callback was missing the \`code\` or \`state\` parameter.`,
            data.error
              ? "token_exchange_failed"
              : !persisted
              ? "callback_state_mismatch"
              : "callback_missing_code",
          ),
        );
        return;
      }

      void exchange(data.code, data.state, persisted);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [mode, status, exchange, applyError]);

  // Watchdog for popup that the user closed without completing the flow.
  // Without this the hook stays in `awaiting_callback` forever even
  // though no message will ever arrive.
  useEffect(() => {
    if (mode !== "popup" || !isBrowser()) return;
    if (status !== "awaiting_callback") return;
    const timer = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        window.clearInterval(timer);
        popupRef.current = null;
        applyError(
          new AtlasMcpError(
            "OAuth popup was closed before authorization completed.",
            "callback_missing_code",
          ),
        );
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [mode, status, applyError]);

  const reset = useCallback(() => {
    clearPersisted(storageIdRef.current);
    setStatus("idle");
    setError(null);
    setAccessToken(null);
    setRefreshToken(null);
    setWorkspaceId(null);
    setExpiresAt(null);
  }, []);

  const connect = useCallback(async () => {
    setStatus("starting");
    setError(null);
    try {
      const result: BeginConnectResult = await beginConnect({
        apiUrl: optionsRef.current.apiUrl,
        clientName: optionsRef.current.clientName,
        redirectUri: optionsRef.current.redirectUri,
        scopes: optionsRef.current.scopes,
      });
      writePersisted(storageIdRef.current, {
        state: result.state,
        codeVerifier: result.codeVerifier,
        clientId: result.clientId,
        tokenEndpoint: result.tokenEndpoint,
        issuer: result.issuer,
        redirectUri: optionsRef.current.redirectUri,
      });

      if (mode === "redirect") {
        if (!isBrowser()) {
          throw new Error("redirect mode requires a browser environment");
        }
        window.location.assign(result.authorizationUrl);
        // Page is about to unload; the awaiting_callback state on the
        // current window is irrelevant — the new page's mount will see
        // ?code/?state and pick up from there.
        return;
      }

      // Popup mode.
      if (!isBrowser()) {
        throw new Error("popup mode requires a browser environment");
      }
      const w = 480;
      const h = 720;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        result.authorizationUrl,
        "atlas-mcp-connect",
        `width=${w},height=${h},left=${left},top=${top},popup=1`,
      );
      if (!popup) {
        throw new AtlasMcpError(
          "Could not open the OAuth popup — allow popups for this site and retry.",
          "registration_failed",
        );
      }
      popupRef.current = popup;
      setStatus("awaiting_callback");
    } catch (err) {
      applyError(err);
    }
  }, [mode, applyError]);

  return {
    connect,
    reset,
    status,
    accessToken,
    refreshToken,
    workspaceId,
    expiresAt,
    error,
  };
}
