"use client";

const DELAY_1 = { animationDelay: "150ms" } as const;
const DELAY_2 = { animationDelay: "300ms" } as const;

export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1 rounded-xl bg-zinc-100 px-4 py-3 dark:bg-zinc-800">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
          style={DELAY_1}
        />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
          style={DELAY_2}
        />
      </div>
    </div>
  );
}
