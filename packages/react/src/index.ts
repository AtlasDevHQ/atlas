// Core component
export { AtlasChat } from "./components/atlas-chat";
export type { AtlasChatProps } from "./components/atlas-chat";

// Context & providers
export { AtlasUIProvider, useAtlasConfig } from "./context";
export type { AtlasUIConfig, AtlasAuthClient } from "./context";

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

// Hooks
export { useConversations } from "./hooks/use-conversations";
export type { UseConversationsOptions, UseConversationsReturn } from "./hooks/use-conversations";
