"use client";

import { useState } from "react";

export function ApiKeyBar({
  apiKey,
  onSave,
}: {
  apiKey: string;
  onSave: (key: string) => void;
}) {
  const [editing, setEditing] = useState(!apiKey);
  const [draft, setDraft] = useState(apiKey);

  if (!editing && apiKey) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900">
        <span className="text-zinc-500 dark:text-zinc-400">API key configured</span>
        <button
          onClick={() => { setDraft(apiKey); setEditing(true); }}
          className="rounded border border-zinc-200 px-2 py-0.5 text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) {
          onSave(draft.trim());
          setEditing(false);
        }
      }}
      className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Enter your API key..."
        className="flex-1 bg-transparent text-xs text-zinc-900 placeholder-zinc-400 outline-none dark:text-zinc-100 dark:placeholder-zinc-600"
        autoFocus
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
      >
        Save
      </button>
      {apiKey && (
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          Cancel
        </button>
      )}
    </form>
  );
}
