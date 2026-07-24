import { Collection, Db, MongoClient } from 'mongodb';
import {
  ConversationState,
  DailyMood,
  DailySchedule,
  Memory,
  PersonaProfile,
  ProactiveMessage,
  Reminder,
  Tool,
  ToolExecution,
} from '../../shared/types';
import { env } from '../config/env';

export class Database {
  private client: MongoClient;
  private db!: Db;

  memories!: Collection<Memory>;
  tools!: Collection<Tool>;
  toolExecutions!: Collection<ToolExecution>;
  personas!: Collection<PersonaProfile>;
  schedules!: Collection<DailySchedule>;
  proactive!: Collection<ProactiveMessage>;
  conversations!: Collection<ConversationState>;
  moods!: Collection<DailyMood>;
  reminders!: Collection<Reminder>;
  meta!: Collection<{ _id: string; value: unknown; updatedAt: Date }>;

  constructor(uri = env.mongodbUri) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db();

    this.memories = this.db.collection<Memory>('memories');
    this.tools = this.db.collection<Tool>('tools');
    this.toolExecutions = this.db.collection<ToolExecution>('tool_executions');
    this.personas = this.db.collection<PersonaProfile>('personas');
    this.schedules = this.db.collection<DailySchedule>('daily_schedules');
    this.proactive = this.db.collection<ProactiveMessage>('proactive_messages');
    this.conversations = this.db.collection<ConversationState>('conversations');
    this.moods = this.db.collection<DailyMood>('daily_moods');
    this.reminders = this.db.collection<Reminder>('reminders');
    this.meta = this.db.collection('meta');

    await Promise.all([
      this.memories.createIndex({ userId: 1, createdAt: -1 }),
      this.memories.createIndex({ userId: 1, category: 1 }),
      this.memories.createIndex({ userId: 1, content: 1 }),
      this.tools.createIndex({ name: 1 }, { unique: true }),
      this.tools.createIndex({ enabled: 1 }),
      this.toolExecutions.createIndex({ toolId: 1, timestamp: -1 }),
      this.personas.createIndex({ userId: 1 }, { unique: true }),
      this.schedules.createIndex({ userId: 1, date: 1 }, { unique: true }),
      this.proactive.createIndex({ userId: 1, status: 1, dueAt: 1 }),
      this.conversations.createIndex({ userId: 1 }, { unique: true }),
      this.moods.createIndex({ userId: 1, date: 1 }, { unique: true }),
      this.moods.createIndex({ userId: 1, updatedAt: -1 }),
      this.reminders.createIndex({ id: 1 }, { unique: true }),
      this.reminders.createIndex({ userId: 1, status: 1, dueAt: 1 }),
      this.reminders.createIndex({ status: 1, dueAt: 1 }),
      this.reminders.createIndex({ userId: 1, updatedAt: -1 }),
    ]);
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
