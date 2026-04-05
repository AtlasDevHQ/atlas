"use client";

import { useState, useRef, useMemo } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAtlasContext } from "../context";

export type AtlasChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface UseAtlasChatOptions {
  /** Conversation ID to associate with this chat session. The server will append messages to this conversation. To load prior messages, use loadConversation() from useAtlasConversations and pass them via setMessages. */
  initialConversationId?: string;
  /** Called when the server assigns or changes the conversation ID. */
  onConversationIdChange?: (id: string) => void;
}

export interface UseAtlasChatReturn {
  messages: UIMessage[];
  /** Replace all messages, or update via callback `(prev) => next`. */
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  /** Send a text message. Rejects on failure (also surfaces via `error`). */
  sendMessage: (text: string) => Promise<void>;
  /** Current input value (managed by the hook). */
  input: string;
  /** Update the input value. */
  setInput: (input: string) => void;
  /** Chat status from the AI SDK. */
  status: AtlasChatStatus;
  /** Whether the chat is currently loading (streaming or submitted). */
  isLoading: boolean;
  /** Last error, if any. */
  error: Error | null;
  /** Current conversation ID. Initially set from options, updated when the server returns an x-conversation-id header. */
  conversationId: string | null;
  /** Manually set the conversation ID. */
  setConversationId: (id: string | null) => void;
}

export function useAtlasChat(options: UseAtlasChatOptions = {}): UseAtlasChatReturn {
  const { apiUrl, apiKey, isCrossOrigin } = useAtlasContext();
  const [conversationId, setConversationId] = useState<string | null>(
    options.initialConversationId ?? null,
  );
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const onChangeRef = useRef(options.onConversationIdChange);
  onChangeRef.current = options.onConversationIdChange;

  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      headers,
      credentials: isCrossOrigin ? "include" : undefined,
      body: () =>
        conversationIdRef.current
          ? { conversationId: conversationIdRef.current }
          : {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await globalThis.fetch(input, init);
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          setConversationId(convId);
          onChangeRef.current?.(convId);
        }
        return response;
      }) as typeof fetch,
    });
  }, [apiKey, apiUrl, isCrossOrigin]);

  const { messages, setMessages, sendMessage: rawSend, status, error } =
    useChat({ transport });

  const [input, setInput] = useState("");

  const sendMessage = async (text: string) => {
    const previousInput = input;
    setInput("");
    try {
      await rawSend({ text });
    } catch (err) {
      setInput(previousInput);
      throw err;
    }
  };

  return {
    messages,
    setMessages,
    sendMessage,
    input,
    setInput,
    status: status as AtlasChatStatus,
    isLoading: status === "streaming" || status === "submitted",
    error: error ?? null,
    conversationId,
    setConversationId,
  };
}
