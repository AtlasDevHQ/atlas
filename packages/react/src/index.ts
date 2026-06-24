// Core component
export { AtlasChat } from "./components/atlas-chat";
export type { AtlasChatProps } from "./components/atlas-chat";

// Context & provider
export { AtlasProvider, useAtlasContext } from "./context";
export type { AtlasProviderProps, AtlasContextValue, AtlasAuthClient } from "./context";

// Theme
export { setTheme } from "./hooks/use-dark-mode";
export type { ThemeMode } from "./hooks/use-dark-mode";
export { buildThemeInitScript, THEME_STORAGE_KEY } from "./hooks/theme-init-script";

// Types
export type {
  AuthMode,
  Conversation,
  Message,
  ConversationWithMessages,
  ChatErrorCode,
  ChatErrorInfo,
} from "./lib/types";
export { AUTH_MODES, parseChatError } from "./lib/types";

// Tool renderer types
export type {
  ToolRendererProps,
  ToolRenderers,
  SQLToolResult,
  ExploreToolResult,
  PythonToolResult,
} from "./lib/tool-renderer-types";

// Hooks
export { useConversations } from "./hooks/use-conversations";
export type { UseConversationsOptions, UseConversationsReturn } from "./hooks/use-conversations";

export { useMcpConnect } from "./hooks/use-mcp-connect";
export type {
  UseMcpConnectOptions,
  UseMcpConnectReturn,
  UseMcpConnectStatus,
  UseMcpConnectMode,
} from "./hooks/use-mcp-connect";

// Widget types (for script-tag embedders)
export type {
  AtlasWidget,
  AtlasWidgetEventMap,
  AtlasWidgetConfig,
  AtlasWidgetCommand,
} from "./lib/widget-types";

// Starter prompt types — re-exported from @useatlas/types so embedders
// can type the optional `starterPrompts` override prop and any
// custom rendering they layer on top of `/api/v1/starter-prompts`.
export type {
  StarterPrompt,
  StarterPromptProvenance,
  StarterPromptsResponse,
  FavoriteStarterPrompt,
} from "@useatlas/types/starter-prompt";

// Shared cold-start fallback prompts — the static set the widget empty state
// shows while the adaptive list loads / when it resolves empty (#3936 §F5).
// Exported so the post-signup success page (#3935 §F4) reuses the same texts
// instead of maintaining a divergent copy.
export {
  DEFAULT_STARTER_PROMPTS,
  DEFAULT_STARTER_PROMPT_TEXTS,
} from "./lib/fallback-starter-prompts";

// Cross-environment routing wire types — re-exported from @useatlas/types
// so embedders writing a custom `executeSQL` tool renderer can read
// `envContributions[]` (per-env row count + error + durationMs) from
// both single-env and fanout responses with the same wire shape.
export type {
  ConnectionContribution,
  ExecuteSqlResult,
  ExecuteSqlSuccessResult,
  ExecuteSqlFailureResult,
} from "@useatlas/types/execute-sql";

// Conversation routing-mode wire type so embedders can render the
// three-state Auto/Pin/All picker against the persisted column.
export type { ConversationRoutingMode } from "@useatlas/types/conversation";
