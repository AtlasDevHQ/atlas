// Core component
export { AtlasChat } from "./components/atlas-chat";
export type { AtlasChatProps } from "./components/atlas-chat";

// Context & providers
export { AtlasUIProvider, useAtlasConfig, ActionAuthProvider, useActionAuth } from "./context";
export type { AtlasUIConfig, AtlasAuthClient, ActionAuthValue } from "./context";

// Theme
export { useDarkMode, useThemeMode, setTheme, DarkModeContext, applyBrandColor, DEFAULT_BRAND_COLOR } from "./hooks/use-dark-mode";
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
  SemanticEntitySummary,
  SemanticEntityDetail,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  ConnectionInfo,
  ConnectionHealth,
  DBType,
} from "./lib/types";
export { AUTH_MODES, parseChatError } from "./lib/types";

// Hooks
export { useConversations } from "./hooks/use-conversations";
export type { UseConversationsOptions, UseConversationsReturn } from "./hooks/use-conversations";

// Helpers
export { parseSuggestions, downloadCSV, downloadExcel, toCsvString, formatCell, normalizeList } from "./lib/helpers";
