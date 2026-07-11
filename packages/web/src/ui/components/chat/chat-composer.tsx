"use client";

import { useLayoutEffect, useRef } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Send `value`. The composer skips the call while locked or when the value
   * is whitespace-only; `handleSend` in atlas-chat.tsx re-applies both guards
   * (it is also reached by chip / starter-prompt / retry paths).
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
 * the return key sends there too — matching the single-line composer, where
 * Enter also sent (via implicit form submission); the on-screen Send button
 * is the affordance either way.
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

  // Defense-in-depth around onSend: both send paths (Enter keydown, form
  // submit) funnel through here. A disabled textarea never fires keydown and
  // Stop/Send button states already block submit in a real browser, but the
  // component should hold its own invariants for any future trigger.
  function trySend() {
    if (locked) return;
    if (!value.trim()) return;
    onSend(value);
  }

  // Auto-grow with content; the CSS max-height caps it, after which the
  // textarea scrolls. Height is JS-driven because CSS `field-sizing: content`
  // hasn't shipped in Safari as of 2026 —
  // the iOS no-zoom requirement makes Safari a first-class target here (the
  // explicit `field-sizing-fixed` below opts out of the base primitive's
  // `field-sizing-content` so only one mechanism drives the height). Keyed on
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
        trySend();
      }}
      className="flex flex-none items-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          // Enter mid-IME-composition is left to the IME to commit (the
          // handler stands down); only a plain Enter outside composition sends.
          if (e.nativeEvent.isComposing) return;
          // Always swallow plain Enter (an empty composer must not gain a
          // leading newline), then let trySend apply the locked/empty guards.
          e.preventDefault();
          trySend();
        }}
        placeholder="Ask a question about your data..."
        rows={1}
        // text-base at mobile widths so iOS doesn't zoom on focus;
        // min-h-10 keeps the single-line composer flush with the size-10 button.
        className="field-sizing-fixed max-h-40 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto text-base sm:text-sm"
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
