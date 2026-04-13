"use client";

const DELAY_1 = { animationDelay: "200ms" } as const;
const DELAY_2 = { animationDelay: "400ms" } as const;

export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-xl bg-zinc-100 px-4 py-3 dark:bg-zinc-800">
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-zinc-400 dark:bg-zinc-500" />
        <span
          className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-zinc-400 dark:bg-zinc-500"
          style={DELAY_1}
        />
        <span
          className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-zinc-400 dark:bg-zinc-500"
          style={DELAY_2}
        />
      </div>
    </div>
  );
}
