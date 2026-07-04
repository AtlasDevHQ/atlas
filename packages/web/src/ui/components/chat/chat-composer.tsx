"use client";

import { useLayoutEffect, useRef } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Send `value`. The caller owns the guards (empty-input trim no-op,
   * loading-conversation drop) — see `handleSend` in atlas-chat.tsx.
   */
  onSend: (text: string) => void;
  /** True while a turn streams — locks the textarea and swaps Send → Stop. */
  streaming: boolean;
  /**
   * #3068 — true while a conversation's history loads (deep link / sidebar
   * open); locks the composer so a send can't race the load.
   */
  loadingConversation: boolean;
  onStop: () => void;
}

/**
 * #4295 — the multiline chat composer: an auto-growing textarea where Enter
 * sends and Shift+Enter inserts a newline. Grows with content up to the
 * `max-h-40` cap, then scrolls. Mobile virtual keyboards fire plain Enter, so
 * the return key sends there too — exactly the single-line composer's
 * behavior; the on-screen Send button is the affordance either way.
 */
export function ChatComposer({
  value,
  onValueChange,
  onSend,
  streaming,
  loadingConversation,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = streaming || loadingConversation;

  // Auto-grow with content; the CSS max-height caps it, after which the
  // textarea scrolls. Height is JS-driven (same approach as NotebookCellInput)
  // because CSS `field-sizing: content` hasn't shipped in Safari — the iOS
  // no-zoom requirement makes Safari a first-class target here. Keyed on
  // `value` rather than onChange so programmatic fills — the `?prompt=`
  // prefill, schema-explorer inserts, restore-on-send-failure — resize too.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend(value);
      }}
      className="flex flex-none items-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          // Enter mid-IME-composition commits the composition; only a plain
          // Enter outside composition sends.
          if (e.nativeEvent.isComposing) return;
          // Always swallow plain Enter (an empty composer must not gain a
          // leading newline); a disabled textarea never fires keydown in a
          // real browser, but guard anyway for programmatic dispatch.
          e.preventDefault();
          if (locked) return;
          onSend(value);
        }}
        placeholder="Ask a question about your data..."
        rows={1}
        // text-base at mobile widths so iOS doesn't zoom on focus;
        // min-h-10 keeps the single-line composer flush with the size-10 button.
        className="max-h-40 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto text-base sm:text-sm"
        disabled={locked}
        aria-label="Chat message"
      />
      {/* #4294 — while a turn streams, the send slot becomes a Stop control:
          aborts the client stream (composer unlocks immediately) and
          best-effort cancels generation server-side. `type="button"` so it
          can never submit the form. */}
      {streaming ? (
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={onStop}
          aria-label="Stop"
          className="size-10 shrink-0"
        >
          <Square className="size-3.5" fill="currentColor" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          disabled={loadingConversation}
          aria-disabled={!value.trim() ? true : undefined}
          aria-label="Send"
          className="size-10 shrink-0"
        >
          <Send className="size-4" />
        </Button>
      )}
    </form>
  );
}
