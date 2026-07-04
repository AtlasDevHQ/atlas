// Core component
export { AtlasChat } from "./components/atlas-chat";
export type { AtlasChatProps } from "./components/atlas-chat";

// Context & provider
export { AtlasProvider, useAtlasContext } from "./context";
export type { AtlasProviderProps, AtlasContextValue, AtlasAuthClient } from "./context";

// Theme
export { setTheme, DarkModeContext } from "./hooks/use-dark-mode";
export type { ThemeMode } from "./hooks/use-dark-mode";
export { buildThemeInitScript, THEME_STORAGE_KEY } from "./hooks/theme-init-script";

// Shared chat render primitives (#4193) — the single home for the leaf
// components both chat orchestrators (this package's AtlasChat and
// @atlas/web's app shell) render. Per-side behaviors are opt-in props:
// web passes `disallowImages` / drilldown / cross-filter / `renderActions`;
// the widget passes `notifyHostOnError`. NOTE: `ResultChart` itself is NOT
// exported here — it imports recharts (an optional peer) statically, so it
// lives behind the `@useatlas/react/chart` subpath; this root entry only
// reaches it via lazy().
export { Markdown } from "./components/chat/markdown";
export { DataTable } from "./components/chat/data-table";
export { ErrorBanner } from "./components/chat/error-banner";
export { SQLResultCard } from "./components/chat/sql-result-card";
export type {
  SQLResultCardProps,
  SqlResultActionContext,
  PreviousExecution,
} from "./components/chat/sql-result-card";
export { PythonResultCard } from "./components/chat/python-result-card";
export type { PythonResultCardProps, PythonProgressData } from "./components/chat/python-result-card";
export { ResultCardBase, ResultCardErrorBoundary } from "./components/chat/result-card-base";
export type { ResultCardBaseProps } from "./components/chat/result-card-base";

// Chart detection — pure functions, zero recharts runtime dependency (its one
// recharts import is type-only), so it is safe to export from the root.
export {
  detectCharts,
  transformData,
  classifyColumn,
  categoryFromChartClick,
  categoryFromPieClick,
  resolveThresholdLines,
  resolveAnnotationLines,
  CHART_COLORS_LIGHT,
  CHART_COLORS_DARK,
  THRESHOLD_LINE_LIGHT,
  THRESHOLD_LINE_DARK,
  ANNOTATION_LINE_LIGHT,
  ANNOTATION_LINE_DARK,
  MAX_THRESHOLD_LINES,
  MAX_ANNOTATION_LINES,
} from "./components/chart/chart-detection";
export type {
  ChartDetectionResult,
  ChartRecommendation,
  ChartType,
  ClassifiedColumn,
  ColumnType,
  RechartsRow,
  ThresholdInput,
  ThresholdLine,
  AnnotationInput,
  AnnotationLine,
} from "./components/chart/chart-detection";

// Shared chat/result helpers — tool-part parsing, CSV/Excel export, cell
// formatting, cross-filter matching.
export {
  getToolArgs,
  getToolResult,
  isToolComplete,
  parseCSV,
  toCsvString,
  downloadCSV,
  downloadBlob,
  parseAttachmentFilename,
  coerceExcelCell,
  downloadExcel,
  parseSuggestions,
  normalizeList,
  categoryMatchesSelection,
  formatCell,
} from "./lib/helpers";

// Types
export type {
  AuthMode,
  Conversation,
  Message,
  ConversationWithMessages,
  ChatErrorCode,
  // Client-side error classification. Re-exported (from @useatlas/types via
  // ./lib/types) so consumers can name the `ChatErrorInfo.clientCode` field's
  // type from the same barrel that exports ChatErrorInfo / ChatErrorCode.
  ClientErrorCode,
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

// Shared cold-start fallback prompts — the static NovaMart set the widget
// empty state shows while the adaptive list loads / when it resolves empty
// (#3936 §F5). Exported so the post-signup success page (#3935 §F4) draws
// from this one source rather than re-hardcoding a divergent set; this
// package is the only one both the widget and @atlas/web can import.
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
