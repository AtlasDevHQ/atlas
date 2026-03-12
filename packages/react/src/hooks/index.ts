// Provider
export { AtlasProvider, useAtlasContext } from "./provider";
export type {
  AtlasProviderProps,
  AtlasContextValue,
  AtlasAuthClient,
} from "./provider";

// Hooks
export { useAtlasChat } from "./use-atlas-chat";
export type {
  AtlasChatStatus,
  UseAtlasChatOptions,
  UseAtlasChatReturn,
} from "./use-atlas-chat";

export { useAtlasAuth } from "./use-atlas-auth";
export type { UseAtlasAuthReturn } from "./use-atlas-auth";

export { useAtlasTheme } from "./use-atlas-theme";
export type { UseAtlasThemeReturn, ThemeMode } from "./use-atlas-theme";

export { useAtlasConversations } from "./use-atlas-conversations";
export type {
  UseAtlasConversationsOptions,
  UseAtlasConversationsReturn,
} from "./use-atlas-conversations";

// Types re-exported for consumers who only import from hooks
export type {
  AuthMode,
  Conversation,
  Message,
  ConversationWithMessages,
  ChatErrorCode,
  ChatErrorInfo,
} from "../lib/types";
export { AUTH_MODES, parseChatError } from "../lib/types";
