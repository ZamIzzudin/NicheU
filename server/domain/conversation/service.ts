import { ConversationState } from '../../../shared/types';
import { Message } from '../../core/types';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';
import { Client } from '../../core/client';
import { formatDateInTz } from '../../utils/time';
import { MemoryService } from '../memory/service';

type StoredMessage = ConversationState['messages'][number];

/**
 * Day-scoped conversation memory ("working memory").
 * - Same calendar day: load full(ish) chat as context
 * - Midnight / day roll: consolidate important facts into long-term memories, then clear
 */
export class ConversationService {
  private consolidating = new Set<string>();

  constructor(
    private db: Database,
    private client: Client,
    private memoryService?: MemoryService
  ) {}

  setMemoryService(memoryService: MemoryService) {
    this.memoryService = memoryService;
  }

  todayDate(): string {
    return formatDateInTz(new Date(), env.timezone);
  }

  async getState(userId: string): Promise<ConversationState | null> {
    return this.db.conversations.findOne({ userId });
  }

  /**
   * Ensure transcript is for *today*. If a previous day remains, run sleep consolidation first.
   */
  async ensureCurrentDay(userId: string): Promise<ConversationState> {
    const today = this.todayDate();
    const existing = await this.getState(userId);

    if (!existing) {
      const fresh: ConversationState = {
        userId,
        conversationDate: today,
        messages: [],
        updatedAt: new Date(),
      };
      await this.db.conversations.updateOne({ userId }, { $set: fresh }, { upsert: true });
      return fresh;
    }

    const day = existing.conversationDate || today;
    if (day === today) {
      // Backfill date on legacy docs
      if (!existing.conversationDate) {
        await this.db.conversations.updateOne(
          { userId },
          { $set: { conversationDate: today, updatedAt: new Date() } }
        );
        existing.conversationDate = today;
      }
      return existing;
    }

    // Stale day still in buffer → sleep that day, then start fresh
    console.log(`😴 Day rolled for ${userId}: consolidating ${day} -> start ${today}`);
    await this.sleepAndReset(userId, day);
    const after = await this.getState(userId);
    return (
      after || {
        userId,
        conversationDate: today,
        messages: [],
        updatedAt: new Date(),
      }
    );
  }

  async getHistory(userId: string): Promise<Message[]> {
    const state = await this.ensureCurrentDay(userId);
    return (state.messages as Message[]) || [];
  }

  async getDayContext(userId: string): Promise<{
    messages: Message[];
    daySummary?: string;
    previousDaySummary?: string;
    conversationDate: string;
  }> {
    const state = await this.ensureCurrentDay(userId);
    return {
      messages: (state.messages as Message[]) || [],
      daySummary: state.summary,
      previousDaySummary: state.previousDaySummary,
      conversationDate: state.conversationDate || this.todayDate(),
    };
  }

  /**
   * Persist chat turns for today. Only durable user/assistant bubbles are stored
   * (system prompts & few-shots are rebuilt each turn).
   */
  async saveHistory(userId: string, messages: Message[], summary?: string): Promise<void> {
    await this.ensureCurrentDay(userId);
    const today = this.todayDate();
    const chatOnly = this.toDurableChat(messages);
    const existing = await this.getState(userId);
    const compact = await this.softCompactDay(
      userId,
      chatOnly,
      summary !== undefined ? summary : existing?.summary
    );

    const doc: Partial<ConversationState> = {
      userId,
      conversationDate: today,
      messages: compact.messages as StoredMessage[],
      summary: compact.summary,
      previousDaySummary: existing?.previousDaySummary,
      lastConsolidatedDate: existing?.lastConsolidatedDate,
      updatedAt: new Date(),
    };

    await this.db.conversations.updateOne({ userId }, { $set: doc }, { upsert: true });
  }

  /**
   * Nightly / day-roll sleep:
   * 1) mine durable memories from today's transcript
   * 2) write short previousDaySummary
   * 3) clear day transcript
   */
  async sleepAndReset(userId: string, forDate?: string): Promise<{
    storedMemories: number;
    previousDaySummary?: string;
    hygiene?: { scanned: number; clusters: number; removed: number; merged: number };
  }> {
    if (this.consolidating.has(userId)) {
      return { storedMemories: 0 };
    }
    this.consolidating.add(userId);

    try {
      const state = await this.getState(userId);
      const today = this.todayDate();
      const day = forDate || state?.conversationDate || today;

      // Idempotency: already consolidated this day
      if (state?.lastConsolidatedDate === day && (!state.messages || state.messages.length === 0)) {
        return { storedMemories: 0, previousDaySummary: state.previousDaySummary };
      }

      const metaKey = `nightly_consolidate:${userId}:${day}`;
      const already = await this.db.meta.findOne({ _id: metaKey } as any);
      if (already && state?.lastConsolidatedDate === day) {
        return { storedMemories: 0, previousDaySummary: state.previousDaySummary };
      }

      const transcript = (state?.messages || []) as Message[];
      const chat = this.toDurableChat(transcript);
      let storedCount = 0;
      let dayRecap = '';
      let hygiene:
        | { scanned: number; clusters: number; removed: number; merged: number }
        | undefined;

      if (chat.length > 0 && this.memoryService) {
        console.log(`🌙 Sleep consolidate ${userId} date=${day} turns=${chat.length}`);
        const result = await this.memoryService.consolidateDayTranscript(
          userId,
          day,
          chat,
          state?.summary
        );
        storedCount = result.stored.length;
        dayRecap = result.daySummary || '';
      } else if (chat.length > 0) {
        dayRecap = await this.summarizeDayFallback(chat, state?.summary);
      } else {
        dayRecap = state?.summary || '';
      }

      // Always analyse/merge near-duplicate long-term memories during sleep
      if (this.memoryService) {
        try {
          hygiene = await this.memoryService.hygienizeMemories(userId);
        } catch (error) {
          console.warn('Memory hygiene failed:', (error as Error).message);
        }
      }

      // Mark meta + reset working memory for the new day
      await this.db.meta.updateOne(
        { _id: metaKey } as any,
        {
          $set: {
            _id: metaKey,
            value: {
              userId,
              date: day,
              storedMemories: storedCount,
              hygiene,
              at: new Date().toISOString(),
            },
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );

      const nextDate = day < today ? today : today;
      const reset: ConversationState = {
        userId,
        conversationDate: nextDate,
        messages: [],
        summary: undefined,
        previousDaySummary: dayRecap || state?.previousDaySummary,
        lastConsolidatedDate: day,
        updatedAt: new Date(),
      };
      await this.db.conversations.updateOne({ userId }, { $set: reset }, { upsert: true });

      console.log(
        `✓ Sleep done for ${userId} day=${day}: memories+=${storedCount}` +
          (hygiene ? `, hygiene removed=${hygiene.removed} merged=${hygiene.merged}` : '') +
          ', transcript cleared'
      );
      return {
        storedMemories: storedCount,
        previousDaySummary: reset.previousDaySummary,
        hygiene,
      };
    } finally {
      this.consolidating.delete(userId);
    }
  }

  /** Used by scheduler: true when local time is past nightly window and today not yet slept. */
  async needsNightlySleep(userId: string, now = new Date()): Promise<boolean> {
    if (!env.enableNightlyConsolidate) return false;
    const today = formatDateInTz(now, env.timezone);
    const state = await this.getState(userId);
    if (!state) return false;

    // If transcript is for an older day, always need sleep
    if (state.conversationDate && state.conversationDate < today) return true;

    // Same day: only after configured hour:minute, and only if there is chat to clear
    // or not yet marked consolidated for yesterday→today boundary right after midnight.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const nowM = hour * 60 + minute;
    const targetM = env.nightlyConsolidateHour * 60 + env.nightlyConsolidateMinute;
    if (nowM < targetM) return false;

    // After midnight window: consolidate *yesterday* if not done.
    // conversationDate still "yesterday" until sleep; if already today with empty msgs + lastConsolidated=yesterday, done.
    const yesterday = formatDateInTz(new Date(now.getTime() - 24 * 60 * 60 * 1000), env.timezone);

    if (state.conversationDate === yesterday) return true;
    if (state.conversationDate === today) {
      // If we somehow still hold yesterdays chats under today's date, skip.
      // Trigger when previous day not consolidated and we have messages from "late night session"
      // Standard path: after sleep, lastConsolidatedDate becomes yesterday and messages=[].
      if (state.lastConsolidatedDate === yesterday || state.lastConsolidatedDate === today) {
        return false;
      }
      // Fresh day never slept yesterday (first run / legacy): consolidate only if non-empty and date mismatch handled above.
      // Right after midnight with conversationDate already rolled to today but messages still full of yesterday:
      // ensureCurrentDay rolls date only on ensure — save keeps today. So at 00:05, conversationDate is still
      // yesterday until a message triggers ensure OR we consolidate here.
      return false;
    }

    return false;
  }

  private toDurableChat(messages: Message[]): Message[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .map((p: any) => (typeof p === 'string' ? p : p?.text || ''))
                  .filter(Boolean)
                  .join(' ')
              : String(m.content ?? ''),
      }))
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);
  }

  /**
   * Keep the full day when possible. If over day cap, roll oldest into summary.
   */
  private async softCompactDay(
    userId: string,
    messages: Message[],
    existingSummary?: string
  ): Promise<{ messages: Message[]; summary?: string }> {
    const max = Math.max(40, env.dayHistoryMaxMessages || env.historyMaxMessages || 200);
    if (messages.length <= max) {
      return { messages, summary: existingSummary };
    }

    const keep = max - 4;
    const overflow = messages.slice(0, Math.max(0, messages.length - keep));
    const kept = messages.slice(overflow.length);

    let summary = existingSummary || '';
    try {
      const result = await this.client.chat(
        [
          {
            role: 'system',
            content:
              'Ringkas percakapan WhatsApp seharian (bahasa Indonesia). ' +
              'Simpan benang cerita, preferensi, janji, emosi penting, topik yang masih nyambung. Max 180 kata. Jangan invent.',
          },
          {
            role: 'user',
            content: `${existingSummary ? `Ringkasan sebelumnya hari ini:\n${existingSummary}\n\n` : ''}Potongan lama:\n${overflow
              .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
              .join('\n')
              .slice(0, 12000)}`,
          },
        ],
        { temperature: 0.3 }
      );
      summary = result.content.trim() || summary;
    } catch {
      // keep previous summary
    }

    console.log(
      `📝 Soft-compact day chat for ${userId}: ${messages.length} -> ${kept.length} (+summary)`
    );
    return { messages: kept, summary };
  }

  private async summarizeDayFallback(messages: Message[], existingSummary?: string): Promise<string> {
    try {
      const result = await this.client.chat(
        [
          {
            role: 'system',
            content:
              'Buat ringkasan singkat percakapan hari ini (max 100 kata, Bahasa Indonesia).',
          },
          {
            role: 'user',
            content: `${existingSummary ? `Summary: ${existingSummary}\n` : ''}${messages
              .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
              .join('\n')
              .slice(0, 10000)}`,
          },
        ],
        { temperature: 0.3 }
      );
      return result.content.trim();
    } catch {
      return existingSummary || '';
    }
  }
}
