export type SearchItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type SearchResult = {
  ok: boolean;
  engine: string;
  query: string;
  count: number;
  results: SearchItem[];
  tookMs: number;
  warning?: string;
  summary?: string;
  message?: string;
};
