/**
 * #4302 (PRD #4292) — per-conversation answer-style picker.
 *
 * Pins the picker's external behavior: the trigger label (default vs stored
 * vs the non-offered `conversational`), the offered menu (exactly the three
 * user-facing styles — Slack's `conversational` is displayable but never a
 * web choice), and the `onChange` selection flow. Server-side wire/persist
 * behavior is pinned in `@atlas/api`'s chat route tests; the body-builder
 * inclusion rule in `use-atlas-transport.test.ts`.
 */
import { describe, expect, test, mock, beforeEach } from "bun:test";
import React, { type ReactNode } from "react";

// Mock the dropdown-menu primitives so portal'd content renders inline —
// same harness as env-picker.test.tsx (we test label + selection logic, not
// Radix's open/close machinery). CLAUDE.md "Mock all exports": every named
// export of the module is stubbed.
mock.module("@/components/ui/dropdown-menu", () => {
  const passthrough =
    (tag: string) =>
    ({ children, asChild: _asChild, ...rest }: { children?: ReactNode; asChild?: boolean } & Record<string, unknown>) =>
      React.createElement(tag, rest, children as React.ReactNode);
  const div = passthrough("div");
  const hr = () => React.createElement("hr");
  const itemWithSelect = ({
    children,
    onSelect,
    asChild: _asChild,
    ...rest
  }: {
    children?: ReactNode;
    asChild?: boolean;
    onSelect?: (e: unknown) => void;
  } & Record<string, unknown>) =>
    React.createElement(
      "div",
      {
        ...rest,
        onClick: () => {
          if (typeof onSelect === "function") onSelect({});
        },
      },
      children as React.ReactNode,
    );
  return {
    DropdownMenu: div,
    DropdownMenuPortal: div,
    DropdownMenuTrigger: div,
    DropdownMenuContent: div,
    DropdownMenuGroup: div,
    DropdownMenuItem: itemWithSelect,
    DropdownMenuCheckboxItem: itemWithSelect,
    DropdownMenuRadioGroup: div,
    DropdownMenuRadioItem: itemWithSelect,
    DropdownMenuLabel: div,
    DropdownMenuSeparator: hr,
    DropdownMenuShortcut: passthrough("span"),
    DropdownMenuSub: div,
    DropdownMenuSubTrigger: div,
    DropdownMenuSubContent: div,
  };
});

import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  AnswerStylePicker,
  answerStyleLabel,
  isKnownAnswerStyle,
  DEFAULT_WEB_ANSWER_STYLE,
  type AnswerStyle,
} from "../components/chat/answer-style-picker";

beforeEach(() => {
  cleanup();
});

const noop = () => {};

describe("answerStyleLabel (#4302)", () => {
  test("null (no explicit choice) reads as the web default's label", () => {
    expect(DEFAULT_WEB_ANSWER_STYLE).toBe("analyst");
    expect(answerStyleLabel(null)).toBe("Analyst");
  });

  test("every persistable style has a human label — including the non-offered conversational", () => {
    expect(answerStyleLabel("plain-english")).toBe("Plain English");
    expect(answerStyleLabel("analyst")).toBe("Analyst");
    expect(answerStyleLabel("executive")).toBe("Executive");
    // An API/SDK-persisted conversational row opened in the web must still
    // read sensibly on the trigger, even though the menu never offers it
    // (chat platforms apply the voice per-turn and leave the row NULL).
    expect(answerStyleLabel("conversational")).toBe("Conversational");
  });
});

describe("isKnownAnswerStyle (#4302)", () => {
  test("accepts every persistable style and rejects everything else", () => {
    for (const style of ["plain-english", "analyst", "executive", "conversational"]) {
      expect(isKnownAnswerStyle(style)).toBe(true);
    }
    // The version-skew ingress case: a style this bundle doesn't know must
    // be rejected so restore-on-open degrades to the default instead of
    // committing a value the picker can't display — silently re-sent every
    // turn, and a 422 loop if the echo lands on an older instance mid-deploy.
    expect(isKnownAnswerStyle("sarcastic")).toBe(false);
    // Object.prototype members must not pass (the `in`-operator hole): a
    // "toString" that slipped through would have crashed the render against
    // the previous `??`-based styleDisplay fallback (inherited
    // Object.prototype.toString is truthy) — both layers now use hasOwn.
    expect(isKnownAnswerStyle("toString")).toBe(false);
    expect(isKnownAnswerStyle("__proto__")).toBe(false);
    expect(isKnownAnswerStyle("")).toBe(false);
    expect(isKnownAnswerStyle(null)).toBe(false);
    expect(isKnownAnswerStyle(undefined)).toBe(false);
    expect(isKnownAnswerStyle(42)).toBe(false);
  });
});

describe("AnswerStylePicker (#4302)", () => {
  test("always renders — the trigger shows the default label when no style is stored", () => {
    const { getByTestId } = render(<AnswerStylePicker value={null} onChange={noop} />);
    const trigger = getByTestId("chat-answer-style-trigger");
    expect(trigger.getAttribute("data-style")).toBe("analyst");
    expect(getByTestId("chat-answer-style-label").textContent).toBe("Analyst");
  });

  test("the trigger reflects the conversation's stored style (restore-on-reopen)", () => {
    const { getByTestId } = render(
      <AnswerStylePicker value="executive" onChange={noop} />,
    );
    expect(getByTestId("chat-answer-style-trigger").getAttribute("data-style")).toBe("executive");
    expect(getByTestId("chat-answer-style-label").textContent).toBe("Executive");
  });

  test("offers exactly the three user-facing styles — conversational stays Slack-only", () => {
    const { getByTestId, queryByTestId } = render(
      <AnswerStylePicker value={null} onChange={noop} />,
    );
    expect(getByTestId("chat-answer-style-option-plain-english")).toBeTruthy();
    expect(getByTestId("chat-answer-style-option-analyst")).toBeTruthy();
    expect(getByTestId("chat-answer-style-option-executive")).toBeTruthy();
    expect(queryByTestId("chat-answer-style-option-conversational")).toBeNull();
  });

  test("marks the effective style active (the default when nothing is stored)", () => {
    const { getByTestId } = render(<AnswerStylePicker value={null} onChange={noop} />);
    expect(getByTestId("chat-answer-style-option-analyst").getAttribute("data-active")).toBe("true");
    expect(getByTestId("chat-answer-style-option-executive").getAttribute("data-active")).toBe("false");
  });

  test("selecting a style fires onChange with the registry name", () => {
    const picks: AnswerStyle[] = [];
    const { getByTestId } = render(
      <AnswerStylePicker value={null} onChange={(s) => picks.push(s)} />,
    );
    fireEvent.click(getByTestId("chat-answer-style-option-executive"));
    fireEvent.click(getByTestId("chat-answer-style-option-plain-english"));
    expect(picks).toEqual(["executive", "plain-english"]);
  });

  test("an API-persisted conversational conversation renders a sensible trigger", () => {
    const { getByTestId } = render(
      <AnswerStylePicker value="conversational" onChange={noop} />,
    );
    expect(getByTestId("chat-answer-style-label").textContent).toBe("Conversational");
    // …while the menu still offers only the web choices.
    expect(getByTestId("chat-answer-style-option-analyst").getAttribute("data-active")).toBe("false");
  });
});
