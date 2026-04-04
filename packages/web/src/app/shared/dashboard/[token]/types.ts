export interface SharedCard {
  id: string;
  title: string;
  sql: string;
  chartConfig: unknown;
  cachedColumns: string[] | null;
  cachedRows: Record<string, unknown>[] | null;
  cachedAt: string | null;
  position: number;
}

export interface SharedDashboard {
  title: string;
  description: string | null;
  shareMode: string;
  cards: SharedCard[];
  createdAt: string;
  updatedAt: string;
}
