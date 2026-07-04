"use client";

/**
 * #4302 (PRD #4292) — per-conversation answer-style picker.
 *
 * Sits in the chat header beside the env/scope picker and selects the
 * editorial voice of the agent's answers for THIS conversation. The
 * selection rides the next chat request (`answerStyle` on the body — the
 * transport re-sends it every turn once touched), persists onto the
 * conversation row server-side, and restores on reopen from the fetched
 * row. Unlike the env picker it never hides: every workspace — including a
 * legacy 1×1 whose scope picker renders nothing — has an answer voice, so
 * this picker is what keeps the header row populated (the PRD's open
 * question, resolved here).
 *
 * Fully controlled/stateless like `ChatEnvPicker`: reads `value`, emits
 * `onChange`. The menu offers the three user-facing styles (plain English /
 * analyst / executive); `conversational` is the chat-platform (Slack) voice
 * — a legal persisted value this picker can DISPLAY (a Slack-originated
 * conversation opened in the web) but deliberately does not offer.
 */

import { BarChart3, Briefcase, Check, MessageCircle, MessagesSquare, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { AnswerStyle } from "@useatlas/types/conversation";

export type { AnswerStyle };

/**
 * The web surface's default style when the conversation has no explicit
 * choice (`value === null`). Mirrors the API's `DEFAULT_ANSWER_STYLE`
 * (`lib/answer-styles.ts`) — the same acceptable web↔api duplication as
 * `effectiveMode` mirroring `resolveRoutingMode` (the frontend is a pure
 * HTTP client and cannot import api-internal constants). Drift is a UX bug
 * (mislabeled trigger), not a correctness bug: the server resolves the
 * actual default at prompt assembly.
 */
export const DEFAULT_WEB_ANSWER_STYLE: AnswerStyle = "analyst";

interface AnswerStyleOption {
  readonly value: AnswerStyle;
  readonly label: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
}

/**
 * The user-facing styles, in the registry's picker display order.
 * `conversational` is deliberately absent — it stays auto-selected by
 * chat-platform surfaces (Slack) and is not a web choice.
 */
const ANSWER_STYLE_OPTIONS: readonly AnswerStyleOption[] = [
  {
    value: "plain-english",
    label: "Plain English",
    subtitle: "A few plain sentences, no jargon",
    icon: MessageCircle,
  },
  {
    value: "analyst",
    label: "Analyst",
    subtitle: "Answer-first, with the supporting detail",
    icon: BarChart3,
  },
  {
    value: "executive",
    label: "Executive",
    subtitle: "Headline, key drivers, provenance",
    icon: Briefcase,
  },
];

/** Display metadata for every persistable style — including the non-offered
 * `conversational`, so a Slack-originated conversation's trigger still reads
 * sensibly when opened in the web. */
const STYLE_DISPLAY: Record<AnswerStyle, { label: string; icon: LucideIcon }> = {
  "plain-english": { label: "Plain English", icon: MessageCircle },
  analyst: { label: "Analyst", icon: BarChart3 },
  executive: { label: "Executive", icon: Briefcase },
  conversational: { label: "Conversational", icon: MessagesSquare },
};

/** The trigger label for a conversation's stored style (null = the default). */
export function answerStyleLabel(value: AnswerStyle | null): string {
  return STYLE_DISPLAY[value ?? DEFAULT_WEB_ANSWER_STYLE].label;
}

export interface AnswerStylePickerProps {
  /**
   * The conversation's stored style; `null` = no explicit choice (the
   * trigger shows the web default, "Analyst").
   */
  value: AnswerStyle | null;
  /** A deliberate pick from the menu — the owner sends it on the next turn. */
  onChange: (style: AnswerStyle) => void;
}

export function AnswerStylePicker({ value, onChange }: AnswerStylePickerProps) {
  const effective = value ?? DEFAULT_WEB_ANSWER_STYLE;
  const display = STYLE_DISPLAY[effective];
  const TriggerIcon = display.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-full border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          data-testid="chat-answer-style-trigger"
          data-style={effective}
          aria-label={`Answer style: ${display.label}. Change.`}
        >
          <TriggerIcon className="size-3.5 text-zinc-500" aria-hidden />
          <span data-testid="chat-answer-style-label">{display.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        data-testid="chat-answer-style-menu"
      >
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          Answer style
        </DropdownMenuLabel>
        {ANSWER_STYLE_OPTIONS.map((option) => {
          const active = option.value === effective;
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="flex items-start gap-2 text-xs"
              data-testid={`chat-answer-style-option-${option.value}`}
              data-active={active}
            >
              <OptionIcon
                className={`mt-0.5 size-3.5 ${active ? "text-primary" : "text-zinc-500"}`}
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate ${active ? "font-medium" : ""}`}>
                  {option.label}
                </span>
                <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                  {option.subtitle}
                </span>
              </div>
              {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
