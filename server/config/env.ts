import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
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

export const env = {
  mongodbUri: required('MONGODB_URI', 'mongodb://localhost:27017/niche-daily'),
  apiBaseUrl: required('API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: required('API_KEY', ''),
  apiModel: required('API_MODEL', 'gpt-4o-mini'),
  embeddingModel: required('EMBEDDING_MODEL', 'text-embedding-3-small'),
  authorizedPhone: required('AUTHORIZED_PHONE', ''),
  port: num('PORT', 3000),
  webPort: num('WEB_PORT', 3001),
  apiToken: process.env.API_TOKEN || 'niche-daily-local',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  memoryImportanceThreshold: num('MEMORY_IMPORTANCE_THRESHOLD', 0.7),
  memoryRetrievalLimit: num('MEMORY_RETRIEVAL_LIMIT', 5),
  historyMaxMessages: num('HISTORY_MAX_MESSAGES', 24),
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
};

export type AppEnv = typeof env;
