import { ConversationState } from '../../../shared/types';
import { Message } from '../../core/types';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';
import { Client } from '../../core/client';

export class ConversationService {
  constructor(private db: Database, private client: Client) {}

  async getHistory(userId: string): Promise<Message[]> {
    const state = await this.db.conversations.findOne({ userId });
    return (state?.messages as Message[]) || [];
  }

  async saveHistory(userId: string, messages: Message[], summary?: string): Promise<void> {
    const compact = await this.compact(userId, messages, summary);
    const doc: ConversationState = {
      userId,
      messages: compact.messages,
      summary: compact.summary,
      updatedAt: new Date(),
    };
    await this.db.conversations.updateOne(
      { userId },
      { $set: doc },
      { upsert: true }
    );
  }

  private async compact(
    userId: string,
    messages: Message[],
    existingSummary?: string
  ): Promise<{ messages: Message[]; summary?: string }> {
    if (messages.length <= env.historyMaxMessages) {
      return { messages, summary: existingSummary };
    }

    const system = messages.find((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    const overflow = rest.slice(0, Math.max(0, rest.length - (env.historyMaxMessages - 2)));
    const kept = rest.slice(overflow.length);

    let summary = existingSummary || '';
    if (overflow.length) {
      try {
        const result = await this.client.chat(
          [
            {
              role: 'system',
              content:
                'Ringkas percakapan menjadi poin penting hubungan, preferensi, dan janji. Bahasa Indonesia, max 120 kata.',
            },
            {
              role: 'user',
              content: `${existingSummary ? `Ringkasan lama:\n${existingSummary}\n\n` : ''}Percakapan baru:\n${overflow
                .map((m) => `${m.role}: ${m.content}`)
                .join('\n')}`,
            },
          ],
          { temperature: 0.3 }
        );
        summary = result.content.trim();
      } catch {
        summary = existingSummary || '';
      }
    }

    const next: Message[] = [];
    if (system) next.push(system);
    if (summary) {
      next.push({
        role: 'system',
        content: `Ringkasan percakapan sebelumnya dengan user ${userId}:\n${summary}`,
      });
    }
    next.push(...kept);
    return { messages: next, summary };
  }
}
