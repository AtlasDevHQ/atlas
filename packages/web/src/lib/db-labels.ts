export function detectDbLabel(url: string): string {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "PostgreSQL";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "MySQL";
  return "Database";
}
