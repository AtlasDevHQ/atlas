"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { useState } from "react";

const transport = new DefaultChatTransport({ api: "/api/chat" });

function parseErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return parsed.message ?? raw;
  } catch {
    return raw;
  }
}

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({ transport });

  const isLoading = status === "streaming" || status === "submitted";

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col p-4">
      <header className="mb-6 flex-none border-b border-zinc-800 pb-4">
        <h1 className="text-xl font-semibold tracking-tight">Atlas</h1>
        <p className="text-sm text-zinc-500">Ask your data anything</p>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto pb-4">
        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            <p className="font-medium text-red-200">Something went wrong</p>
            <p className="mt-1 whitespace-pre-wrap">{parseErrorMessage(error.message)}</p>
          </div>
        )}

        {messages.length === 0 && !error && (
          <div className="flex h-full items-center justify-center">
            <p className="text-zinc-600">
              Ask a question about your data to get started.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-200"
              }`}
            >
              {m.parts?.map((part, i) => {
                if (part.type === "text") {
                  return <p key={i} className="whitespace-pre-wrap">{part.text}</p>;
                }
                if (isToolUIPart(part)) {
                  return (
                    <details key={i} className="mt-2 text-xs text-zinc-500">
                      <summary className="cursor-pointer">
                        Tool: {getToolName(part)}
                      </summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-zinc-900 p-2">
                        {"input" in part && part.input
                          ? JSON.stringify(part.input, null, 2)
                          : ""}
                      </pre>
                    </details>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput("");
        }}
        className="flex flex-none gap-2 border-t border-zinc-800 pt-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What are the top 10 companies by revenue?"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
        >
          {isLoading ? "..." : "Ask"}
        </button>
      </form>
    </div>
  );
}
