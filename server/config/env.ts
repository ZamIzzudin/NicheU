import dotenv from 'dotenv';
import path from 'path';

// Load .env for local dev only. Never override real process env (Docker/Dokploy).
dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  override: false,
});

function trimEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const t = String(v).trim();
  return t.length ? t : undefined;
}

function required(name: string, fallback?: string): string {
  const value = trimEnv(name) ?? fallback;
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** Digits-only phone id used as persona/memory/schedule userId everywhere. */
export function normalizeUserId(phone: string): string {
  return String(phone || '').replace(/\D/g, '');
}

export const env = {
  mongodbUri: required('MONGODB_URI', 'mongodb://localhost:27017/niche-daily'),
  apiBaseUrl: required('API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: required('API_KEY', ''),
  apiModel: required('API_MODEL', 'gpt-4o-mini'),
  embeddingModel: required('EMBEDDING_MODEL', 'text-embedding-3-small'),
  /** Vision-capable model for image understanding (defaults to API_MODEL). */
  visionModel: process.env.VISION_MODEL || process.env.API_MODEL || 'gpt-4o-mini',
  enableImageUnderstanding: bool('ENABLE_IMAGE_UNDERSTANDING', true),
  /** Max image bytes to download/describe (default 5MB). */
  maxImageBytes: num('MAX_IMAGE_BYTES', 5 * 1024 * 1024),
  // Always store/lookup as digits only so API + WA bot share the same key
  authorizedPhone: normalizeUserId(required('AUTHORIZED_PHONE', '')),
  port: num('PORT', 3000),
  webPort: num('WEB_PORT', 3001),
  apiToken: process.env.API_TOKEN || 'niche-daily-local',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  memoryImportanceThreshold: num('MEMORY_IMPORTANCE_THRESHOLD', 0.7),
  memoryRetrievalLimit: num('MEMORY_RETRIEVAL_LIMIT', 5),
  /** Soft hard-cap for SAME-DAY transcript (default high so full-day context stays). */
  historyMaxMessages: num('HISTORY_MAX_MESSAGES', 200),
  dayHistoryMaxMessages: num('DAY_HISTORY_MAX_MESSAGES', 200),
  /** Realtime extract only stores high-importance facts; rest waits for nightly sleep. */
  realtimeMemoryImportanceThreshold: num(
    'REALTIME_MEMORY_IMPORTANCE_THRESHOLD',
    Math.max(0.85, num('MEMORY_IMPORTANCE_THRESHOLD', 0.7))
  ),
  enableNightlyConsolidate: bool('ENABLE_NIGHTLY_CONSOLIDATE', true),
  /** Local hour/minute in TIMEZONE when "sleep" consolidation runs. */
  nightlyConsolidateHour: num('NIGHTLY_CONSOLIDATE_HOUR', 0),
  nightlyConsolidateMinute: num('NIGHTLY_CONSOLIDATE_MINUTE', 5),
  /** During sleep: scan long-term memories and merge/drop near-duplicates. */
  enableNightlyMemoryHygiene: bool('ENABLE_NIGHTLY_MEMORY_HYGIENE', true),
  /** Cosine similarity to treat two memory embeddings as duplicates (0-1). */
  memoryDedupCosineThreshold: num('MEMORY_DEDUP_COSINE_THRESHOLD', 0.9),
  /** Max memories scanned per nightly hygiene pass. */
  memoryDedupMaxScan: num('MEMORY_DEDUP_MAX_SCAN', 250),
  /** Soft threshold for token-overlap / normalized-text near match. */
  memoryDedupTokenOverlap: num('MEMORY_DEDUP_TOKEN_OVERLAP', 0.72),
  proactiveMinIntervalSec: num('PROACTIVE_MIN_INTERVAL_SEC', 300),
  proactiveMaxPerDay: num('PROACTIVE_MAX_PER_DAY', 12),
  proactiveMaxOverdueMin: num('PROACTIVE_MAX_OVERDUE_MIN', 8),
  quietHoursStart: process.env.QUIET_HOURS_START || '23:30',
  quietHoursEnd: process.env.QUIET_HOURS_END || '06:30',
  enableQuietHours: bool('ENABLE_QUIET_HOURS', true),
  scheduleTickMs: num('SCHEDULE_TICK_MS', 30000),
  whatsappAuthDir: process.env.WHATSAPP_AUTH_DIR || 'whatsapp_auth',
  /** Wait this long after last user bubble before replying (merge multipesan). */
  userBubbleDebounceSec: num('USER_BUBBLE_DEBOUNCE_SEC', 120),
  /**
   * Snapshot of SerpAPI key at boot (may be empty if compose omitted it).
   * Prefer getSerpApiKey() at call-time so live process.env is always used.
   */
  get serpApiKey(): string {
    return getSerpApiKey();
  },
  /** SerpAPI engine: google | bing | duckduckgo */
  get serpApiEngine(): string {
    return (trimEnv('SERPAPI_ENGINE') || 'google').toLowerCase();
  },
};

/** Read SerpAPI key live from process.env (Docker/Dokploy-safe). */
export function getSerpApiKey(): string {
  return (
    trimEnv('SERPAPI_API_KEY') ||
    trimEnv('SERP_API_KEY') ||
    trimEnv('SERPAPI_KEY') ||
    ''
  );
}

export function isSerpApiConfigured(): boolean {
  return getSerpApiKey().length > 8;
}

export type AppEnv = typeof env;
