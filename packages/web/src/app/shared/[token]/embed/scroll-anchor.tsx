"use client";

import { useEffect, useRef } from "react";

/** Invisible element placed at the end of the conversation that scrolls into view on mount. */
export function ScrollAnchor() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "instant" });
  }, []);
  return <div ref={ref} />;
}
