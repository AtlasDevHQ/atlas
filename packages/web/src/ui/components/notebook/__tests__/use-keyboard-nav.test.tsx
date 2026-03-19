import { describe, expect, test, mock, beforeEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { useKeyboardNav } from "../use-keyboard-nav";

// ---------------------------------------------------------------------------
// Test wrapper — renders actual DOM elements so focus() and cellRefs work
// ---------------------------------------------------------------------------

interface TestNavProps {
  cellCount: number;
  onEnterEdit: (index: number) => void;
  onExitEdit: () => void;
  onDelete: (index: number) => void;
  editing: boolean;
}

function TestNav({ cellCount, onEnterEdit, onExitEdit, onDelete, editing }: TestNavProps) {
  const { setRef, focusedIndex } = useKeyboardNav({
    cellCount,
    onEnterEdit,
    onExitEdit,
    onDelete,
    editing,
  });

  return (
    <div>
      {Array.from({ length: cellCount }, (_, i) => (
        <div key={i} ref={setRef(i)} tabIndex={0} data-testid={`cell-${i}`}>
          Cell {i}
        </div>
      ))}
      <span data-testid="focused-index">{focusedIndex.current}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatchKeyOnDocument(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  document.dispatchEvent(event);
}

function dispatchKeyFromElement(
  element: Element,
  key: string,
  opts: Partial<KeyboardEventInit> = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  element.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useKeyboardNav", () => {
  const onEnterEdit = mock<(index: number) => void>(() => {});
  const onExitEdit = mock(() => {});
  const onDelete = mock<(index: number) => void>(() => {});

  beforeEach(() => {
    onEnterEdit.mockClear();
    onExitEdit.mockClear();
    onDelete.mockClear();
  });

  function renderNav(overrides: Partial<TestNavProps> = {}) {
    return render(
      <TestNav
        cellCount={3}
        onEnterEdit={onEnterEdit}
        onExitEdit={onExitEdit}
        onDelete={onDelete}
        editing={false}
        {...overrides}
      />,
    );
  }

  // ------ Arrow key navigation ------

  describe("arrow key navigation", () => {
    test("ArrowDown moves focus to the next cell", () => {
      const { getByTestId } = renderNav();

      // Focus first cell
      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown"));

      expect(document.activeElement).toBe(getByTestId("cell-1"));
    });

    test("ArrowUp moves focus to the previous cell", () => {
      const { getByTestId } = renderNav();

      // Start at cell 1 by pressing down first
      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown"));
      act(() => dispatchKeyOnDocument("ArrowUp"));

      expect(document.activeElement).toBe(getByTestId("cell-0"));
    });

    test("ArrowDown at last cell stays on last cell", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());
      // Navigate to the end
      act(() => dispatchKeyOnDocument("ArrowDown"));
      act(() => dispatchKeyOnDocument("ArrowDown"));
      // Try to go past
      act(() => dispatchKeyOnDocument("ArrowDown"));

      expect(document.activeElement).toBe(getByTestId("cell-2"));
    });

    test("ArrowUp at first cell stays on first cell", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowUp"));

      expect(document.activeElement).toBe(getByTestId("cell-0"));
    });

    test("multiple sequential arrow presses navigate correctly", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown"));
      act(() => dispatchKeyOnDocument("ArrowDown"));
      act(() => dispatchKeyOnDocument("ArrowUp"));

      expect(document.activeElement).toBe(getByTestId("cell-1"));
    });
  });

  // ------ Enter / edit mode ------

  describe("enter edit mode", () => {
    test("Enter calls onEnterEdit with focused index", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown")); // index 1
      act(() => dispatchKeyOnDocument("Enter"));

      expect(onEnterEdit).toHaveBeenCalledTimes(1);
      expect(onEnterEdit).toHaveBeenCalledWith(1);
    });

    test("Enter does nothing when already editing", () => {
      renderNav({ editing: true });

      act(() => dispatchKeyOnDocument("Enter"));

      expect(onEnterEdit).not.toHaveBeenCalled();
    });
  });

  // ------ Escape / exit edit mode ------

  describe("escape exit mode", () => {
    test("Escape calls onExitEdit and refocuses cell when editing", () => {
      const { getByTestId } = renderNav({ editing: true });

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("Escape"));

      expect(onExitEdit).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(getByTestId("cell-0"));
    });

    test("Escape does nothing when not editing", () => {
      renderNav({ editing: false });

      act(() => dispatchKeyOnDocument("Escape"));

      expect(onExitEdit).not.toHaveBeenCalled();
    });

    test("Escape from INPUT element calls onExitEdit", () => {
      renderNav({ editing: true });

      // Create and append an input to simulate typing in a cell's textarea
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      act(() => dispatchKeyFromElement(input, "Escape"));

      expect(onExitEdit).toHaveBeenCalledTimes(1);

      document.body.removeChild(input);
    });

    test("Escape from TEXTAREA element calls onExitEdit", () => {
      renderNav({ editing: true });

      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      textarea.focus();

      act(() => dispatchKeyFromElement(textarea, "Escape"));

      expect(onExitEdit).toHaveBeenCalledTimes(1);

      document.body.removeChild(textarea);
    });
  });

  // ------ Delete shortcut ------

  describe("delete shortcut", () => {
    test("Ctrl+Shift+Backspace calls onDelete with focused index", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown")); // index 1
      act(() =>
        dispatchKeyOnDocument("Backspace", { ctrlKey: true, shiftKey: true }),
      );

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(1);
    });

    test("Backspace without Ctrl+Shift does not delete", () => {
      renderNav();

      act(() => dispatchKeyOnDocument("Backspace"));
      act(() => dispatchKeyOnDocument("Backspace", { ctrlKey: true }));
      act(() => dispatchKeyOnDocument("Backspace", { shiftKey: true }));

      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  // ------ INPUT/TEXTAREA early return ------

  describe("input/textarea isolation", () => {
    test("ArrowDown from INPUT does not navigate cells", () => {
      const { getByTestId } = renderNav();

      act(() => getByTestId("cell-0").focus());

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      act(() => dispatchKeyFromElement(input, "ArrowDown"));

      // onEnterEdit should not fire, focus should stay on input
      expect(onEnterEdit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);

      document.body.removeChild(input);
    });

    test("Enter from TEXTAREA does not trigger edit mode", () => {
      renderNav();

      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      textarea.focus();

      act(() => dispatchKeyFromElement(textarea, "Enter"));

      expect(onEnterEdit).not.toHaveBeenCalled();

      document.body.removeChild(textarea);
    });
  });

  // ------ Edge cases ------

  describe("edge cases", () => {
    test("single cell — navigation stays at index 0", () => {
      const { getByTestId } = renderNav({ cellCount: 1 });

      act(() => getByTestId("cell-0").focus());
      act(() => dispatchKeyOnDocument("ArrowDown"));

      expect(document.activeElement).toBe(getByTestId("cell-0"));

      act(() => dispatchKeyOnDocument("ArrowUp"));

      expect(document.activeElement).toBe(getByTestId("cell-0"));
    });

    test("zero cells — key presses do not throw", () => {
      renderNav({ cellCount: 0 });

      // Should not throw — the hook doesn't guard against empty cell arrays,
      // that's the consumer's job (NotebookShell shows empty state when 0 cells)
      act(() => dispatchKeyOnDocument("ArrowDown"));
      act(() => dispatchKeyOnDocument("ArrowUp"));
      act(() => dispatchKeyOnDocument("Enter"));
      act(() => dispatchKeyOnDocument("Escape"));
      act(() =>
        dispatchKeyOnDocument("Backspace", { ctrlKey: true, shiftKey: true }),
      );

      // Enter fires onEnterEdit(0) even with 0 cells — safe because consumer
      // checks bounds before acting
      expect(onEnterEdit).toHaveBeenCalledWith(0);
    });

    test("unrelated keys are ignored", () => {
      renderNav();

      act(() => dispatchKeyOnDocument("Tab"));
      act(() => dispatchKeyOnDocument("a"));
      act(() => dispatchKeyOnDocument("Space"));

      expect(onEnterEdit).not.toHaveBeenCalled();
      expect(onExitEdit).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    });

    test("rapid sequential arrow presses", () => {
      const { getByTestId } = renderNav({ cellCount: 5 });

      act(() => getByTestId("cell-0").focus());

      // Rapid 4 downs
      act(() => {
        dispatchKeyOnDocument("ArrowDown");
        dispatchKeyOnDocument("ArrowDown");
        dispatchKeyOnDocument("ArrowDown");
        dispatchKeyOnDocument("ArrowDown");
      });

      expect(document.activeElement).toBe(getByTestId("cell-4"));
    });
  });

  // ------ Cleanup ------

  describe("listener cleanup", () => {
    test("event listener is removed on unmount", () => {
      const { unmount } = renderNav();

      unmount();

      // After unmount, keypresses should not call callbacks
      act(() => dispatchKeyOnDocument("Enter"));
      act(() => dispatchKeyOnDocument("Escape"));

      expect(onEnterEdit).not.toHaveBeenCalled();
      expect(onExitEdit).not.toHaveBeenCalled();
    });
  });
});
