"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AUTH_MODES, type AuthMode } from "../lib/types";
import type { AnswerStyle } from "@useatlas/types/conversation";
import { applyBrandColor, OKLCH_RE } from "./use-dark-mode";

const API_KEY_STORAGE_KEY = "atlas-api-key";

/**
 * #3749 — per-send body marker that routes a chat request to the durable-resume
 * endpoint instead of `/chat`. Set on the `body` of a `regenerate(...)` call
 * (resume continues the interrupted turn, so it adds no new user message). The
 * transport's `prepareSendMessagesRequest` strips it and rewrites the target URL
 * to `POST /chat/{conversationId}/resume`.
 */
export const ATLAS_RESUME_MARKER = "__atlasResume" as const;

/**
 * #3749 — decide whether a chat send carries the resume marker and, if so,
 * resolve the durable-resume request shape. Pure (no refs / no React) so the
 * routing decision is unit-testable in isolation. Returns the `{ api, body }`
 * override that re-targets `POST /chat/{conversationId}/resume` (no body — the
 * server re-enters the interrupted turn from its checkpoint), or `null` to fall
 * through to a normal `/chat` request. A marked call with no conversation id to
 * resume against (defensive — the affordance is gated on a mounted conversation)
 * also falls through.
 */
export function resolveResumeRequest(
  apiUrl: string,
  callBody: Record<string, unknown> | undefined,
  resumeConversationId: string | null,
): { api: string; body: Record<string, never> } | null {
  if (!callBody || !callBody[ATLAS_RESUME_MARKER]) return null;
  if (!resumeConversationId) return null;
  return {
    api: `${apiUrl}/api/v1/chat/${resumeConversationId}/resume`,
    body: {},
  };
}

/**
 * #3749 — decide whether an `x-conversation-id` / `x-run-id` response header
 * should fire its capture callback: present, and different from the last value
 * we surfaced (so a multi-request stream doesn't re-fire on every chunk's
 * response). Pure so the dedupe rule is unit-testable. Returns the captured id
 * to surface, or `null` to do nothing.
 */
export function nextCapturedId(
  headerValue: string | null,
  lastValue: string | null,
): string | null {
  if (headerValue && headerValue !== lastValue) return headerValue;
  return null;
}

/**
 * #4018 — decide which credential the chat transport attaches. The in-memory
 * API key (sessionStorage `atlas-api-key`, written ONLY by the simple-key
 * `ApiKeyBar`, which renders only in `simple-key` mode) is the credential in
 * `simple-key` mode and must ride as an `Authorization: Bearer` there.
 *
 * In `managed` mode the durable credential is the host-only session COOKIE, sent
 * via `credentials: "include"` exactly like the REST path (`useAdminFetch` sends
 * NO Authorization header). A leftover/stale key must NOT be attached there: the
 * server's bearer plugin validates the bearer FIRST, so a stale token 401s the
 * request ("session expired") even though the cookie is valid — which is why the
 * first chat send 401'd while cookie-only REST calls succeeded. `managed`/`byot`/
 * `none`/unresolved (`null`) therefore stay cookie-only. Pure so the rule is
 * unit-testable without rendering the hook.
 */
export function buildAuthHeaders(
  authMode: AuthMode | null,
  apiKey: string,
): Record<string, string> {
  if (authMode === "simple-key" && apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}

/** The Atlas routing fields layered onto a normal `/chat` request body. */
export interface ChatRoutingInputs {
  conversationId?: string | null;
  connectionId?: string | null;
  connectionGroupId?: string | null;
  routingMode?: "auto" | "pin" | "all" | null;
  /** Always sent when present (even `[]`) so a re-include clears the row (#3066). */
  restExcludedDatasourceIds?: readonly string[] | undefined;
  /** Always sent when present (even `null`) so a clear nulls the row (#3067). */
  restFocusDatasourceId?: string | null | undefined;
  /**
   * #3895 (ADR-0022) — Group reach. Always sent when the getter is wired (even
   * `null`) so a widen back to All sources nulls the row instead of inheriting
   * the stale Focus (the #3073 transport-omits-null bug class). `null` = All
   * sources; a `connection_group_id` value = Focus → that group.
   */
  groupReach?: string | null | undefined;
  /**
   * #4302 — per-conversation answer style. Omitted when `null` (no explicit
   * choice — the server inherits the row's stored style, or applies the
   * surface default for a NULL row), like `routingMode`. The getter returns
   * a style once its state holds one — picked this session or restored from
   * the row on reopen — so every turn re-sends it; only a genuine change
   * burns an UPDATE server-side (the route's skip-UPDATE gate).
   */
  answerStyle?: AnswerStyle | null;
}

/**
 * #3749 — build the normal `/chat` request body. Extracted as a pure function
 * so the field-inclusion rules (omit-when-absent for the routing scope, but
 * always-send for the REST exclude-set/focus even at their empty values) are
 * unit-testable without rendering the hook. Sets `messages` explicitly since the
 * AI SDK stops auto-merging the message list once `prepareSendMessagesRequest`
 * is supplied. The per-call `body` is NOT forwarded (only the resume marker ever
 * rides it, and that's consumed before this builds).
 */
export function buildChatRequestBody(
  messages: unknown,
  inputs: ChatRoutingInputs,
): Record<string, unknown> {
  const body: Record<string, unknown> = { messages };
  if (inputs.conversationId) body.conversationId = inputs.conversationId;
  if (inputs.connectionId) body.connectionId = inputs.connectionId;
  if (inputs.connectionGroupId) body.connectionGroupId = inputs.connectionGroupId;
  if (inputs.routingMode) body.routingMode = inputs.routingMode;
  if (inputs.restExcludedDatasourceIds !== undefined) {
    body.restExcludedDatasourceIds = [...inputs.restExcludedDatasourceIds];
  }
  if (inputs.restFocusDatasourceId !== undefined) {
    body.restFocusDatasourceId = inputs.restFocusDatasourceId;
  }
  // #3895 — Group reach: always sent when the getter is wired (even `null`), like
  // the REST-scope fields, so a widen to All sources resets the row.
  if (inputs.groupReach !== undefined) {
    body.groupReach = inputs.groupReach;
  }
  // #4302 — answer style: omit-when-null (like routingMode). There is no
  // "clear back to null" path — the picker only ever selects a concrete
  // style — so the omit-vs-null distinction of the REST fields isn't needed.
  if (inputs.answerStyle) body.answerStyle = inputs.answerStyle;
  return body;
}

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
  /**
   * #3749 — called when a run ID is captured from the `x-run-id` response header
   * (present on both a fresh turn and a resume). The chat surface tracks the
   * latest run id so a subsequent reload can correlate an interrupted/parked run.
   * Optional: SDK/API callers that don't surface durability affordances omit it.
   */
  onRunId?: (runId: string) => void;
  /**
   * #3749 — returns the conversation id to resume against, used to build the
   * `POST /chat/{conversationId}/resume` URL when a resume is triggered (a
   * `regenerate({ body: { __atlasResume: true } })` call). Returns `null` when
   * there is no conversation to resume (the resume affordance is gated on a
   * mounted conversation, so this is non-null whenever resume actually fires).
   */
  getResumeConversationId?: () => string | null;
  /**
   * #2345 — per-turn execution target override. Returns the connection
   * id selected by the chat header env/member picker, or `null` to fall
   * back to the conversation's stored value. Called at fetch time so a
   * user changing the picker mid-conversation reaches the agent on the
   * next turn without rebuilding the transport.
   */
  getConnectionId?: () => string | null;
  /**
   * #2345 — content scope (connection group). Sent on conversation
   * creation; subsequent turns omit it unless the picker is also used
   * to change the scope (rare — defaults stay sticky to the
   * conversation row).
   */
  getConnectionGroupId?: () => string | null;
  /**
   * #2518 — three-state Auto/Pin/All cross-environment routing mode.
   * Returns the picker's current selection or `null` to omit the field
   * from the request body (server applies its NULL→"pin" back-compat
   * default for legacy conversations).
   */
  getRoutingMode?: () => "auto" | "pin" | "all" | null;
  /**
   * #3066 — the conversation's REST datasource exclude-set (excluded
   * `install_id`s). When provided, the transport ALWAYS sends it (even `[]`),
   * because the chat route distinguishes "field present as []" (re-include —
   * clear the row) from "field absent" (inherit the row). Omitting the field on
   * a re-include would silently keep a stale exclusion — the #3073 bug class.
   */
  getRestExcludedDatasourceIds?: () => readonly string[];
  /** #3067 — REST-only focus (`install_id`, or null = not focused). */
  getRestFocusDatasourceId?: () => string | null;
  /**
   * #3895 (ADR-0022) — Group reach (`connection_group_id` = Focus, or null = All
   * sources). When provided, the transport ALWAYS sends it (even `null`), because
   * the chat route distinguishes "field present as null" (widen to All sources —
   * clear the row's Focus) from "field absent" (inherit the row). Omitting it on
   * a widen would silently keep a stale Focus — the #3073 bug class.
   */
  getGroupReach?: () => string | null;
  /**
   * #4302 — the conversation's answer style from the header picker (`null` =
   * no explicit choice). Omitted from the body when null so the server
   * inherits the row's stored style (or applies the surface default).
   */
  getAnswerStyle?: () => AnswerStyle | null;
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

  // #3749 — run-id capture + resume-target getter. Refs (not deps) for the same
  // reason as the conversation-id callbacks: the transport is rebuilt only on
  // auth/url change, never on these changing between turns.
  const onRunIdRef = useRef(opts.onRunId);
  onRunIdRef.current = opts.onRunId;
  const getResumeConversationIdRef = useRef(opts.getResumeConversationId);
  getResumeConversationIdRef.current = opts.getResumeConversationId;
  // Track the last run id we surfaced so a multi-request stream doesn't re-fire
  // the callback on every chunk's response — same dedupe shape as conversationId.
  const lastRunIdRef = useRef<string | null>(null);

  // Internal ref — synced from getter every render, eagerly written on capture
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = getConversationIdRef.current();

  // #2345 — routing getters. Refs (not state) so the picker can swap
  // selection without rebuilding the transport mid-stream (which would
  // restart `useChat` and lose the in-flight response).
  const getConnectionIdRef = useRef(opts.getConnectionId);
  getConnectionIdRef.current = opts.getConnectionId;

  const getConnectionGroupIdRef = useRef(opts.getConnectionGroupId);
  getConnectionGroupIdRef.current = opts.getConnectionGroupId;

  // #2518 — routing-mode getter (Auto/Pin/All). Ref for the same reason
  // the connection getters are refs: a picker change between turns
  // reaches the next request without rebuilding `useChat`'s transport
  // (which would cancel the in-flight stream).
  const getRoutingModeRef = useRef(opts.getRoutingMode);
  getRoutingModeRef.current = opts.getRoutingMode;

  // #3066 — REST exclude-set getter. Ref for the same reason as the routing
  // getters: a scope toggle between turns reaches the next request without
  // rebuilding `useChat`'s transport.
  const getRestExcludedDatasourceIdsRef = useRef(opts.getRestExcludedDatasourceIds);
  getRestExcludedDatasourceIdsRef.current = opts.getRestExcludedDatasourceIds;
  const getRestFocusDatasourceIdRef = useRef(opts.getRestFocusDatasourceId);
  getRestFocusDatasourceIdRef.current = opts.getRestFocusDatasourceId;
  // #3895 — Group reach getter. Ref for the same reason as the routing getters:
  // a reach change between turns reaches the next request without rebuilding the
  // transport.
  const getGroupReachRef = useRef(opts.getGroupReach);
  getGroupReachRef.current = opts.getGroupReach;

  // #4302 — answer-style getter. Ref for the same reason as the routing
  // getters: a picker change between turns reaches the next request without
  // rebuilding `useChat`'s transport (which would cancel an in-flight stream).
  const getAnswerStyleRef = useRef(opts.getAnswerStyle);
  getAnswerStyleRef.current = opts.getAnswerStyle;

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
  // #4018 — credential decision lives in `buildAuthHeaders` (single-sourced with
  // the transport memo): bearer only in simple-key mode, cookie-only otherwise.
  const getHeaders = useCallback(
    () => buildAuthHeaders(authMode, apiKey),
    [authMode, apiKey],
  );

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
  // authMode: read directly via `buildAuthHeaders` (and in deps) so the transport
  // is rebuilt with the right credential once auth resolves (#4018).
  const transport = useMemo(() => {
    // #4018 — see `buildAuthHeaders`: managed mode rides the cookie (no bearer),
    // so a stale `atlas-api-key` can't 401 the chat while REST stays authed.
    const headers = buildAuthHeaders(authMode, apiKey);
    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      headers,
      credentials: isCrossOrigin ? "include" : undefined,
      // `prepareSendMessagesRequest` (not the static `body`) so a per-call body
      // marker can re-target the request to the durable-resume endpoint (#3749).
      // The normal path returns the same fields the `body` builder used to.
      prepareSendMessagesRequest: ({ messages, body: callBody }) => {
        // #3749 — resume re-target. A `regenerate({ body: { __atlasResume: true }})`
        // call carries the marker; rewrite the URL to the resume endpoint, which
        // takes the conversation id in the path and NO body (it re-enters the
        // interrupted turn from its server-side checkpoint). The marker never
        // reaches the server. Falls through to a normal request when there's no
        // conversation to resume against (defensive — the affordance is gated on
        // a mounted conversation, so this is non-null whenever resume fires).
        const resume = resolveResumeRequest(
          apiUrl,
          callBody as Record<string, unknown> | undefined,
          getResumeConversationIdRef.current?.() ?? null,
        );
        if (resume) return resume;

        // Snapshot the routing getters at fetch time. Inclusion rules live in
        // `buildChatRequestBody`:
        //   - conversationId / connectionId / connectionGroupId / routingMode
        //     (#2345/#2518) are omitted when absent — the server falls back to
        //     the conversation's stored values / legacy single-connection routing.
        //   - restExcludedDatasourceIds (#3066) / restFocusDatasourceId (#3067)
        //     are ALWAYS sent when the getter is present (even `[]` / `null`) so a
        //     re-include/clear actually resets the row instead of inheriting the
        //     stale value (the #3073 transport-omits-null bug class).
        return {
          body: buildChatRequestBody(messages, {
            conversationId: conversationIdRef.current,
            connectionId: getConnectionIdRef.current?.(),
            connectionGroupId: getConnectionGroupIdRef.current?.(),
            routingMode: getRoutingModeRef.current?.(),
            restExcludedDatasourceIds: getRestExcludedDatasourceIdsRef.current?.(),
            restFocusDatasourceId: getRestFocusDatasourceIdRef.current?.(),
            groupReach: getGroupReachRef.current?.(),
            answerStyle: getAnswerStyleRef.current?.(),
          }),
        };
      },
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
        // #3749 — capture the run id (present on a fresh turn AND a resume) so the
        // chat surface can correlate the active run. Deduped via `nextCapturedId`
        // so a multi-request stream doesn't re-fire the callback on every chunk.
        const runId = nextCapturedId(response.headers.get("x-run-id"), lastRunIdRef.current);
        if (runId) {
          lastRunIdRef.current = runId;
          onRunIdRef.current?.(runId);
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
