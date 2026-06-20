/**
 * #3749 — the durability affordance the web chat renders for a non-terminal
 * latest run. Covers the acceptance criteria at the component boundary:
 *   - `running` ⇒ an "interrupted — Resume" affordance whose button fires onResume
 *   - `parked`  ⇒ a non-actionable "waiting on approval" state (no button)
 *   - terminal (`done`/`failed`) / `none` / loading ⇒ NO affordance
 *   - the resume button disables + shows progress while `resuming`
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ResumeBanner } from "../components/chat/resume-banner";

afterEach(() => cleanup());

describe("ResumeBanner (#3749)", () => {
  test("running: shows an interrupted notice and a Resume button that fires onResume", () => {
    const onResume = mock(() => {});
    const { getByTestId, getByText } = render(
      <ResumeBanner
        runStatus={{ status: "running", runId: "run-1", parkedReason: null }}
        onResume={onResume}
        resuming={false}
      />,
    );
    const banner = getByTestId("resume-banner");
    expect(banner.getAttribute("data-run-status")).toBe("running");
    expect(getByText("This turn was interrupted")).toBeTruthy();

    fireEvent.click(getByTestId("resume-button"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("running + resuming: button is disabled and shows progress (no double-fire)", () => {
    const onResume = mock(() => {});
    const { getByTestId, getByText } = render(
      <ResumeBanner
        runStatus={{ status: "running", runId: "run-1", parkedReason: null }}
        onResume={onResume}
        resuming={true}
      />,
    );
    const button = getByTestId("resume-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(getByText("Resuming…")).toBeTruthy();
  });

  test("parked: shows a non-actionable waiting-on-approval state with no resume button", () => {
    const onResume = mock(() => {});
    const { getByTestId, getByText, queryByTestId } = render(
      <ResumeBanner
        runStatus={{ status: "parked", runId: "run-2", parkedReason: "req-42" }}
        onResume={onResume}
        resuming={false}
      />,
    );
    const banner = getByTestId("resume-banner");
    expect(banner.getAttribute("data-run-status")).toBe("parked");
    expect(getByText("Waiting on approval")).toBeTruthy();
    // It must read as paused, not offer a (no-op) resume action.
    expect(queryByTestId("resume-button")).toBeNull();
  });

  test.each(["done", "failed", "none"] as const)(
    "%s: renders no affordance (terminal/absent runs have nothing to resume)",
    (status) => {
      const { queryByTestId } = render(
        <ResumeBanner
          runStatus={status === "none" ? { status } : { status, runId: "r", parkedReason: null }}
          onResume={() => {}}
          resuming={false}
        />,
      );
      expect(queryByTestId("resume-banner")).toBeNull();
    },
  );

  test("loading (null status): renders nothing", () => {
    const { queryByTestId } = render(
      <ResumeBanner runStatus={null} onResume={() => {}} resuming={false} />,
    );
    expect(queryByTestId("resume-banner")).toBeNull();
  });
});
