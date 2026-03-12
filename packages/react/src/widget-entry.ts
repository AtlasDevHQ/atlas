/**
 * Widget bundle entry point.
 *
 * Produces a self-contained ESM file that exposes React, ReactDOM/client,
 * and the AtlasChat component on `globalThis.AtlasWidget` so the widget
 * host HTML can render without any external CDN dependencies.
 *
 * Built by `tsup` — see tsup.config.ts for the widget-specific config.
 */

import { createElement, Component } from "react";
import { createRoot } from "react-dom/client";
import { AtlasChat } from "./components/atlas-chat";
import { setTheme } from "./hooks/use-dark-mode";

const AtlasWidget = { createElement, Component, createRoot, AtlasChat, setTheme };

Object.assign(globalThis, { AtlasWidget });

export { createElement, Component, createRoot, AtlasChat, setTheme };
