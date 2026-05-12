"use client";

import { useEffect, useRef, useState } from "react";
import {
  AtlasMcpError,
  beginConnect,
  completeConnect,
  type BeginConnectResult,
  type CompleteConnectResult,
} from "@useatlas/sdk";

/**
 * Wraps the SDK's `beginConnect` + `completeConnect` with a
 * popup-or-redirect lifecycle so React embedders can drop a
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

/**
 * Discriminated by `status` so consumers don't need to write
 * `if (accessToken)` guards the type already proves: when
 * `status === "success"` the token fields are non-null; otherwise
 * they're absent.
 */
export type UseMcpConnectReturn =
  | {
      readonly status: "idle" | "starting" | "awaiting_callback" | "exchanging";
      readonly connect: () => Promise<void>;
      readonly reset: () => void;
      readonly accessToken: null;
      readonly refreshToken: null;
      readonly workspaceId: null;
      readonly workspaces: null;
      readonly expiresAt: null;
      readonly error: null;
    }
  | {
      readonly status: "success";
      readonly connect: () => Promise<void>;
      readonly reset: () => void;
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly workspaceId: string;
      /**
       * The plural workspace claim surfaced from the JWT (#2196). Empty
       * array for single-workspace tokens, populated when the
       * authenticating user belongs to more than one workspace. Use
       * `workspaces.length > 1` to gate a post-onboarding workspace
       * picker; `workspaceId` is always the default selection (the
       * singular claim).
       *
       * `ReadonlyArray<string>` to match the SDK's
       * `CompleteConnectResult.workspaces` shape and prevent in-place
       * mutation of `useState`-backed React state — `result.workspaces.sort()`
       * would silently corrupt the picker's source-of-truth across renders.
       */
      readonly workspaces: ReadonlyArray<string>;
      readonly expiresAt: number;
      readonly error: null;
    }
  | {
      readonly status: "error";
      readonly connect: () => Promise<void>;
      readonly reset: () => void;
      readonly accessToken: null;
      readonly refreshToken: null;
      readonly workspaceId: null;
      readonly workspaces: null;
      readonly expiresAt: null;
      readonly error: AtlasMcpError | Error;
    };

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

/**
 * Parse a sessionStorage entry into a `PersistedState`. Returns null
 * when the entry is missing, malformed, or fails any of the field
 * checks. Wipes corrupt entries so a single bad write doesn't trap
 * the user — they can always re-run `connect()`.
 *
 * Co-located with the type so a future field addition has to thread
 * both at once.
 */
function parsePersisted(storageId: string): PersistedState | null {
  if (!isBrowser()) return null;
  const raw = window.sessionStorage.getItem(storageKey(storageId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // intentionally ignored: corrupt sessionStorage entry — wipe and
    // return null so the caller re-initiates rather than getting stuck.
    window.sessionStorage.removeItem(storageKey(storageId));
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  for (const field of ["state", "codeVerifier", "clientId", "tokenEndpoint", "issuer", "redirectUri"] as const) {
    if (typeof candidate[field] !== "string") return null;
  }
  return candidate as unknown as PersistedState;
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

/**
 * Map a callback message + persisted state to either an exchange-ready
 * `{ code, state, persisted }` triple or a typed `AtlasMcpError`. Each
 * failure mode gets its own discrete error code so a debugger sees
 * exactly which precondition failed — `callback_state_missing` (the
 * persisted entry was wiped before the callback arrived) is distinct
 * from `callback_state_mismatch` (CSRF: the callback's state didn't
 * match the persisted one).
 */
function classifyCallback(
  data: PopupCallbackMessage,
  persisted: PersistedState | null,
):
  | { kind: "exchange"; code: string; state: string; persisted: PersistedState }
  | { kind: "error"; error: AtlasMcpError } {
  if (data.error) {
    return {
      kind: "error",
      error: new AtlasMcpError(
        `Authorization server returned error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`,
        "token_exchange_failed",
      ),
    };
  }
  if (!persisted) {
    return {
      kind: "error",
      error: new AtlasMcpError(
        "OAuth callback received but the persisted flow state is missing — sessionStorage was cleared mid-flow.",
        "callback_state_missing",
      ),
    };
  }
  if (!data.code || !data.state) {
    return {
      kind: "error",
      error: new AtlasMcpError(
        "OAuth callback was missing the `code` or `state` parameter.",
        "callback_missing_code",
      ),
    };
  }
  return { kind: "exchange", code: data.code, state: data.state, persisted };
}

export function useMcpConnect(options: UseMcpConnectOptions): UseMcpConnectReturn {
  const mode = options.mode ?? "popup";
  const storageId = options.storageId ?? options.redirectUri;

  const [status, setStatus] = useState<UseMcpConnectStatus>("idle");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<string> | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<AtlasMcpError | Error | null>(null);

  // Hold the latest options/storageId in refs so the message handler
  // and effect stay stable across re-renders without resubscribing on
  // every render. Options are snapshotted at `connect()` invocation
  // time — a caller updating `apiUrl` mid-flow won't retroactively
  // change an in-flight exchange.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const storageIdRef = useRef(storageId);
  storageIdRef.current = storageId;

  function applyResult(result: CompleteConnectResult): void {
    setAccessToken(result.accessToken);
    setRefreshToken(result.refreshToken);
    setWorkspaceId(result.workspaceId);
    setWorkspaces(result.workspaces);
    setExpiresAt(result.expiresAt);
    setStatus("success");
  }

  function applyError(err: unknown): void {
    setError(
      err instanceof AtlasMcpError
        ? err
        : err instanceof Error
        ? err
        : new Error(String(err)),
    );
    setStatus("error");
  }

  async function exchange(code: string, returnedState: string, persisted: PersistedState): Promise<void> {
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
  }

  // Redirect-mode auto-complete: if we land on a page with `?code` +
  // `?state` and a matching persisted entry, finish the exchange.
  useEffect(() => {
    if (mode !== "redirect" || !isBrowser()) return;
    if (status !== "idle") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code || !returnedState) return;
    const persisted = parsePersisted(storageId);
    if (!persisted) return;
    void exchange(code, returnedState, persisted);
    // We deliberately do NOT strip ?code/?state from the URL here — the
    // hosting app may need them for its own observation; cleaning up
    // is the embedder's call (e.g. router.replace).
  }, [mode, status, storageId]);

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

      const persisted = parsePersisted(storageIdRef.current);

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

      const classified = classifyCallback(event.data, persisted);
      if (classified.kind === "error") {
        applyError(classified.error);
        return;
      }
      void exchange(classified.code, classified.state, classified.persisted);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [mode, status]);

  // Watchdog for popup that the user closed without completing the flow.
  // Without this the hook stays in `awaiting_callback` forever even
  // though no message will ever arrive. The synchronous check on entry
  // catches a popup that was already closed (e.g. blocker silently
  // closed it) before the interval's first tick.
  useEffect(() => {
    if (mode !== "popup" || !isBrowser()) return;
    if (status !== "awaiting_callback") return;

    const fireClosed = () => {
      popupRef.current = null;
      applyError(
        new AtlasMcpError(
          "OAuth popup was closed before authorization completed.",
          "popup_closed",
        ),
      );
    };

    if (popupRef.current && popupRef.current.closed) {
      fireClosed();
      return;
    }

    const timer = window.setInterval(() => {
      // Re-check status from React state via the closure: if a parallel
      // message handler already settled the flow this interval should
      // not double-fire. The status capture is the previous render's
      // value, which is correct — once status leaves `awaiting_callback`
      // this effect tears down via the cleanup below.
      if (popupRef.current && popupRef.current.closed) {
        window.clearInterval(timer);
        fireClosed();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [mode, status]);

  function reset(): void {
    clearPersisted(storageIdRef.current);
    setStatus("idle");
    setError(null);
    setAccessToken(null);
    setRefreshToken(null);
    setWorkspaceId(null);
    setWorkspaces(null);
    setExpiresAt(null);
  }

  async function connect(): Promise<void> {
    // Guard against double-clicks: while the flow is in flight a second
    // call would orphan the first popup and overwrite the persisted
    // PKCE bookkeeping, breaking both flows. Treat as a no-op.
    if (status === "starting" || status === "awaiting_callback" || status === "exchanging") {
      return;
    }
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
          "popup_blocked",
        );
      }
      popupRef.current = popup;
      setStatus("awaiting_callback");
    } catch (err) {
      applyError(err);
    }
  }

  // Return shape narrowed by status so consumers get the right field
  // types without runtime guards. Cast through unknown because the
  // discriminated state is spread across multiple useState hooks; the
  // runtime invariants (success ⇒ accessToken+workspaceId set; error ⇒
  // error set; otherwise all null) are upheld by `applyResult` /
  // `applyError` / `reset`.
  const base = { connect, reset } as const;
  if (status === "success") {
    return {
      ...base,
      status,
      accessToken: accessToken!,
      refreshToken,
      workspaceId: workspaceId!,
      // Same `!` pattern as the adjacent fields — `applyResult` writes
      // every field together when transitioning to `success`, so the
      // null branch is unreachable here.
      workspaces: workspaces!,
      expiresAt: expiresAt!,
      error: null,
    };
  }
  if (status === "error") {
    return {
      ...base,
      status,
      accessToken: null,
      refreshToken: null,
      workspaceId: null,
      workspaces: null,
      expiresAt: null,
      error: error!,
    };
  }
  return {
    ...base,
    status,
    accessToken: null,
    refreshToken: null,
    workspaceId: null,
    workspaces: null,
    expiresAt: null,
    error: null,
  };
}
