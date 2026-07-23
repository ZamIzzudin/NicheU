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
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
    name?: string;
  }>;
  summary?: string;
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
