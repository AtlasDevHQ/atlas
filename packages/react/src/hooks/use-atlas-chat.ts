"use client";

import { useState, useRef, useMemo } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAtlasContext } from "./provider";

export interface UseAtlasChatOptions {
  /** Initial conversation ID to resume. */
  conversationId?: string;
  /** Called when the server assigns or changes the conversation ID. */
  onConversationIdChange?: (id: string) => void;
}

export interface UseAtlasChatReturn {
  /** Chat messages. */
  messages: UIMessage[];
  /** Replace messages (e.g. when loading a saved conversation). */
  setMessages: (messages: UIMessage[]) => void;
  /** Send a text message. */
  sendMessage: (text: string) => Promise<void>;
  /** Current input value (managed by the hook). */
  input: string;
  /** Update the input value. */
  setInput: (input: string) => void;
  /** Chat status: "ready", "streaming", "submitted", or "error". */
  status: string;
  /** Whether the chat is currently loading (streaming or submitted). */
  isLoading: boolean;
  /** Last error, if any. */
  error: Error | null;
  /** Current conversation ID (assigned by the server). */
  conversationId: string | null;
  /** Manually set the conversation ID. */
  setConversationId: (id: string | null) => void;
}

export function useAtlasChat(options: UseAtlasChatOptions = {}): UseAtlasChatReturn {
  const { apiUrl, apiKey, isCrossOrigin } = useAtlasContext();
  const [conversationId, setConversationId] = useState<string | null>(
    options.conversationId ?? null,
  );
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const onChangeRef = useRef(options.onConversationIdChange);
  onChangeRef.current = options.onConversationIdChange;

  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return new DefaultChatTransport({
      api: `${apiUrl}/api/chat`,
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
    setInput("");
    await rawSend({ text });
  };

  return {
    messages,
    setMessages,
    sendMessage,
    input,
    setInput,
    status,
    isLoading: status === "streaming" || status === "submitted",
    error: error ?? null,
    conversationId,
    setConversationId,
  };
}
