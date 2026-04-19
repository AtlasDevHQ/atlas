import {
  Database,
  Globe,
  FilePenLine,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const ACTION_TYPE_ICONS: Record<string, LucideIcon> = {
  sql_write: Database,
  sql: Database,
  api_call: Globe,
  api: Globe,
  file_write: FilePenLine,
  file: FilePenLine,
  shell: Terminal,
  command: Terminal,
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  sql_write: "SQL Write",
  sql: "SQL",
  api_call: "API Call",
  api: "API",
  file_write: "File Write",
  file: "File",
  shell: "Shell",
  command: "Command",
};

export function actionTypeIcon(type: string): LucideIcon {
  return ACTION_TYPE_ICONS[type.toLowerCase()] ?? Zap;
}

export function actionTypeLabel(type: string): string {
  return ACTION_TYPE_LABELS[type.toLowerCase()] ?? type;
}
