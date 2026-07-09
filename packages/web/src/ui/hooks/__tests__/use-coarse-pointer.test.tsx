/**
 * useCoarsePointer (#4323).
 *
 * The hook is the mechanism behind the dashboard's viewing-first-on-touch
 * behaviour, so its contract is pinned directly: it reflects the live
 * `(pointer: coarse)` match, subscribes/unsubscribes to `matchMedia`, and is
 * SSR-safe. `window.matchMedia` is stubbed since jsdom doesn't implement it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useCoarsePointer } from "../use-coarse-pointer";

type Listener = () => void;

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return {
    listenerCount: () => listeners.size,
    restore: () => {
      window.matchMedia = original;
    },
  };
}

function Probe({ onValue }: { onValue: (v: boolean) => void }) {
  onValue(useCoarsePointer());
  return null;
}

describe("useCoarsePointer (#4323)", () => {
  afterEach(cleanup);

  test("returns true when the primary pointer is coarse", () => {
    const mm = stubMatchMedia(true);
    let value: boolean | null = null;
    render(<Probe onValue={(v) => { value = v; }} />);
    expect<boolean | null>(value).toBe(true);
    mm.restore();
  });

  test("returns false when the primary pointer is fine", () => {
    const mm = stubMatchMedia(false);
    let value: boolean | null = null;
    render(<Probe onValue={(v) => { value = v; }} />);
    expect<boolean | null>(value).toBe(false);
    mm.restore();
  });

  test("subscribes on mount and cleans up its listener on unmount", () => {
    const mm = stubMatchMedia(false);
    const { unmount } = render(<Probe onValue={() => {}} />);
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
    mm.restore();
  });
});
