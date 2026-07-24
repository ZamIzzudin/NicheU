// Shared types for Niche Daily

export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'event'
  | 'relationship'
  | 'task'
  | 'goal';

export type ToolCategory = 'productivity' | 'information' | 'lifestyle' | 'system' | 'custom';

export type ActivityStatus = 'planned' | 'ongoing' | 'done' | 'skipped';

export type ProactiveType =
  | 'morning_greeting'
  | 'activity_start'
  | 'activity_end'
  | 'midday_checkin'
  | 'evening_wrap'
  | 'idle_nudge'
  | 'custom';

export type ProactiveStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

/** Ephemeral timed reminders — NOT long-term memories. Drop after sent/cancel. */
export type ReminderStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface Reminder {
  _id?: string;
  id: string;
  userId: string;
  /** What to remind about (short). */
  text: string;
  /** When to fire (absolute UTC Date). */
  dueAt: Date;
  status: ReminderStatus;
  /** Original user phrasing, e.g. "15 menit lagi" / "jam 20:00". */
  rawWhen?: string;
  /** Optional source message snippet. */
  sourceText?: string;
  createdAt: Date;
  updatedAt: Date;
  sentAt?: Date;
  cancelledAt?: Date;
  error?: string;
}

export interface Memory {
  _id?: string;
  userId: string;
  content: string;
  importance: number;
  category: MemoryCategory;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryExtractionResult {
  memories: Array<{
    content: string;
    importance: number;
    category: MemoryCategory;
    metadata?: Record<string, unknown>;
  }>;
  confidence: number;
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  functionCode: string;
  parameters: ToolParameter[];
  enabled: boolean;
  builtin: boolean;
  createdAt: Date;
  updatedAt: Date;
  source?: 'builtin' | 'self_created' | 'web_ui';
}

export interface ToolExecution {
  toolId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
  timestamp: Date;
}

/**
 * Heavy automation "bots" — manually authored, not auto-generated tools.
 * Triggered by chat, run in background, notify WhatsApp when finished.
 */
export type BotParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface BotParameter {
  name: string;
  type: BotParameterType;
  description: string;
  required: boolean;
  default?: unknown;
  /** Optional examples shown when agent asks for missing params. */
  examples?: string[];
}

export type BotRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AutomationBot {
  _id?: string;
  /** Stable id, e.g. bot_research_report */
  id: string;
  /** Unique snake_case name for tools, e.g. research_report */
  name: string;
  /** Human title */
  title: string;
  /** Rich description for matching user intent */
  description: string;
  /** Optional trigger phrases / keywords to help matching */
  triggers?: string[];
  parameters: BotParameter[];
  /**
   * Named handler registered in code (preferred for heavy work).
   * Example: "http_fetch", "shell_job" (only if you implement handler).
   */
  handler: string;
  /** Optional static config passed to handler (URLs, defaults, etc.) */
  config?: Record<string, unknown>;
  /** Optional sandbox code (async function execute(params, ctx)) — only if no named handler needs it */
  functionCode?: string;
  enabled: boolean;
  /** Max runtime before fail (ms). Default 10 minutes. */
  timeoutMs?: number;
  /** Message template pieces (agent may rephrase in persona) */
  ackMessageHint?: string;
  successMessageHint?: string;
  failureMessageHint?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BotRun {
  _id?: string;
  id: string;
  botId: string;
  botName: string;
  userId: string;
  status: BotRunStatus;
  parameters: Record<string, unknown>;
  triggerText?: string;
  result?: unknown;
  error?: string;
  /** True after WA/user was notified of terminal status */
  notified?: boolean;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  updatedAt: Date;
}

export interface PersonaProfile {
  _id?: string;
  userId: string;
  name: string;
  role: string;
  speechStyle: string;
  traits: string[];
  relationshipToUser: string;
  boundaries?: string;
  timezone: string;
  userName?: string;
  rawIntro?: string;
  onboarded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Activity {
  id: string;
  title: string;
  description?: string;
  startAt: Date;
  endAt: Date;
  status: ActivityStatus;
  note?: string;
  notifiedStart?: boolean;
  notifiedEnd?: boolean;
}

export interface DailySchedule {
  _id?: string;
  userId: string;
  date: string; // YYYY-MM-DD in user timezone
  activities: Activity[];
  generatedAt: Date;
  summary?: string;
  moodLabel?: MoodLabel;
}

export type MoodLabel =
  | 'ceria'
  | 'romantis'
  | 'tenang'
  | 'netral'
  | 'fokus'
  | 'lelah'
  | 'cemas'
  | 'sedih'
  | 'kesal'
  | 'semangat';

export type MoodSource = 'generated' | 'drift' | 'manual' | 'activity' | 'conversation';

export interface MoodSnapshot {
  label: MoodLabel;
  valence: number; // -1 .. 1
  energy: number; // 0 .. 1
  color: string; // hex
  emoji: string;
  note: string;
  speechHint: string;
}

export interface MoodHistoryEntry {
  at: Date;
  label: MoodLabel;
  valence: number;
  energy: number;
  color: string;
  note: string;
  source: MoodSource;
}

export interface DailyMood {
  _id?: string;
  userId: string;
  date: string; // YYYY-MM-DD
  current: MoodSnapshot;
  history: MoodHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProactiveMessage {
  _id?: string;
  userId: string;
  type: ProactiveType;
  dueAt: Date;
  payload: {
    textHint?: string;
    activityId?: string;
    activityTitle?: string;
  };
  status: ProactiveStatus;
  createdAt: Date;
  sentAt?: Date;
  error?: string;
}

export interface ConversationState {
  userId: string;
  /** Calendar day (YYYY-MM-DD in app timezone) this transcript belongs to. */
  conversationDate?: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Text history preferred; multimodal parts allowed for vision turns. */
    content: string | Array<Record<string, unknown>>;
    tool_call_id?: string;
    tool_calls?: unknown[];
    name?: string;
  }>;
  /** Rolling/soft summary within the same day if transcript got long. */
  summary?: string;
  /** After nightly sleep: short carry-over from previous day (not full chat). */
  previousDaySummary?: string;
  lastConsolidatedDate?: string;
  updatedAt: Date;
}

export interface ToolDefinitionOpenAI {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}
