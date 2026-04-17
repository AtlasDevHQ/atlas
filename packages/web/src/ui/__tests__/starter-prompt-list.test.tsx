import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
import { StarterPromptList } from "../components/chat/starter-prompt-list";

const sample: StarterPrompt[] = [
  { id: "favorite:a", text: "Pinned question", provenance: "favorite" },
  { id: "popular:b", text: "Trending question", provenance: "popular" },
  { id: "library:c", text: "Fallback question", provenance: "library" },
];

describe("StarterPromptList", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders a chip per prompt preserving caller order", () => {
    const { getAllByRole } = render(
      <StarterPromptList prompts={sample} onSelect={() => {}} />,
    );
    const buttons = getAllByRole("button");
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.textContent).toContain("Pinned question");
    expect(buttons[1]!.textContent).toContain("Trending question");
    expect(buttons[2]!.textContent).toContain("Fallback question");
  });

  test("tags each row with a provenance-specific data-testid", () => {
    const { queryByTestId } = render(
      <StarterPromptList prompts={sample} onSelect={() => {}} />,
    );
    // Stable DOM hooks for Playwright + downstream telemetry.
    expect(queryByTestId("starter-prompt-favorite")).not.toBeNull();
    expect(queryByTestId("starter-prompt-popular")).not.toBeNull();
    expect(queryByTestId("starter-prompt-library")).not.toBeNull();
  });

  test("renders a Popular badge only for the popular row", () => {
    const { getAllByTestId } = render(
      <StarterPromptList prompts={sample} onSelect={() => {}} />,
    );
    const badges = getAllByTestId("starter-prompt-popular-badge");
    expect(badges.length).toBe(1);
    expect(badges[0]!.textContent).toBe("Popular");
  });

  test("invokes onSelect with the prompt text when a chip is clicked", () => {
    const calls: string[] = [];
    const { getByText } = render(
      <StarterPromptList
        prompts={sample}
        onSelect={(text) => calls.push(text)}
      />,
    );
    fireEvent.click(getByText("Trending question"));
    expect(calls).toEqual(["Trending question"]);
  });

  test("omits the unpin affordance when onUnpin is not provided", () => {
    const { queryByTestId } = render(
      <StarterPromptList prompts={sample} onSelect={() => {}} />,
    );
    expect(queryByTestId("unpin-favorite")).toBeNull();
  });

  test("onUnpin receives the namespaced favorite id without triggering onSelect", () => {
    const selectCalls: string[] = [];
    const unpinCalls: string[] = [];
    const { getByTestId } = render(
      <StarterPromptList
        prompts={sample}
        onSelect={(text) => selectCalls.push(text)}
        onUnpin={(id) => unpinCalls.push(id)}
      />,
    );
    // The unpin button sits inside the same row as the chip button — click
    // propagation must stop there so the row's onSelect doesn't also fire.
    fireEvent.click(getByTestId("unpin-favorite"));
    expect(unpinCalls).toEqual(["favorite:a"]);
    expect(selectCalls).toEqual([]);
  });

  test("renders the default cold-start CTA when the list is empty", () => {
    const { getByText } = render(
      <StarterPromptList prompts={[]} onSelect={() => {}} />,
    );
    expect(
      getByText(/Ask your first question below/),
    ).toBeTruthy();
  });

  test("uses coldStartMessage override when supplied", () => {
    const { getByText } = render(
      <StarterPromptList
        prompts={[]}
        onSelect={() => {}}
        coldStartMessage="Ask a question to create your first cell."
      />,
    );
    expect(getByText("Ask a question to create your first cell.")).toBeTruthy();
  });

  test("suppresses the cold-start CTA while isLoading is true", () => {
    // Flashing "Ask your first question" before the fetch resolves produces
    // a perceptible shimmer — isLoading should yield an inert empty render.
    const { container, queryByText } = render(
      <StarterPromptList prompts={[]} onSelect={() => {}} isLoading />,
    );
    expect(queryByText(/Ask your first question/)).toBeNull();
    expect(container.textContent).toBe("");
  });
});
