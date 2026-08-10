export type SearchItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  /** Domain/display URL (opsional, dari cite SERP). */
  source?: string;
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

/** Output dari search provider (camofox) sebelum dinormalisasi ke SearchResult. */
export type SearchProviderResult = {
  ok: boolean;
  engine: string;
  query: string;
  count: number;
  results: SearchItem[];
  tookMs: number;
  warning?: string;
  answerBox?: string;
  knowledgeGraph?: string;
};
