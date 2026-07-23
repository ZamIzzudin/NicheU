import { Memory, MemoryCategory, MemoryExtractionResult } from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';

export class MemoryService {
  constructor(private db: Database, private client: Client) {}

  async extractAndStore(userId: string, message: string): Promise<Memory[]> {
    const extracted = await this.extract(userId, message);
    const stored: Memory[] = [];

    for (const item of extracted.memories) {
      if (item.importance < env.memoryImportanceThreshold) continue;
      const exists = await this.db.memories.findOne({
        userId,
        content: item.content,
      });
      if (exists) continue;

      const memory = await this.addMemory({
        userId,
        content: item.content,
        importance: item.importance,
        category: item.category,
        metadata: item.metadata,
      });
      stored.push(memory);
    }

    return stored;
  }

  async extract(userId: string, message: string): Promise<MemoryExtractionResult> {
    const system = `You extract long-term memories from a chat message for a personal partner AI.
Return ONLY JSON object:
{
  "memories": [
    {
      "content": "short factual memory",
      "importance": 0.0,
      "category": "preference|fact|event|relationship|task|goal",
      "metadata": {}
    }
  ],
  "confidence": 0.0
}
Rules:
- Only keep durable facts useful later.
- Ignore greetings and temporary small talk.
- importance 0-1; >= ${env.memoryImportanceThreshold} is worth storing.
- If nothing important, memories=[] and confidence low.`;

    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: message },
        ],
        {
          temperature: 0.2,
          responseFormat: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(this.cleanJson(result.content));
      const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
      return {
        memories: memories
          .filter((m: any) => m && typeof m.content === 'string')
          .map((m: any) => ({
            content: String(m.content).trim(),
            importance: Math.min(1, Math.max(0, Number(m.importance) || 0)),
            category: this.validateCategory(m.category),
            metadata: m.metadata || {},
          })),
        confidence: Number(parsed.confidence) || (memories.length ? 0.7 : 0.2),
      };
    } catch (error) {
      console.warn('Memory extraction failed:', (error as Error).message);
      return { memories: [], confidence: 0 };
    }
  }

  async addMemory(
    input: Omit<Memory, 'embedding' | 'createdAt' | 'updatedAt' | 'accessCount'>
  ): Promise<Memory> {
    let embedding: number[] | undefined;
    try {
      embedding = await this.client.embed(input.content);
    } catch (error) {
      console.warn('Embedding failed, storing memory without vector:', (error as Error).message);
    }

    const memory: Memory = {
      ...input,
      embedding,
      createdAt: new Date(),
      updatedAt: new Date(),
      accessCount: 0,
    };

    await this.db.memories.insertOne(memory as any);
    return memory;
  }

  async search(userId: string, query: string, limit = env.memoryRetrievalLimit): Promise<Memory[]> {
    let queryEmbedding: number[] | undefined;
    try {
      queryEmbedding = await this.client.embed(query);
    } catch {
      queryEmbedding = undefined;
    }

    if (queryEmbedding) {
      const candidates = await this.db.memories
        .find({ userId, embedding: { $exists: true } })
        .sort({ importance: -1, createdAt: -1 })
        .limit(80)
        .toArray();

      const scored = candidates
        .map((m) => ({
          memory: m,
          score: this.cosine(queryEmbedding!, m.embedding || []),
        }))
        .filter((x) => Number.isFinite(x.score))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.memory);

      if (scored.length) {
        await this.touch(scored);
        return scored;
      }
    }

    // Text fallback
    const regex = query.trim()
      ? { $regex: query.split(/\s+/).slice(0, 4).join('|'), $options: 'i' }
      : undefined;

    const results = await this.db.memories
      .find(regex ? { userId, content: regex } : { userId })
      .sort({ importance: -1, createdAt: -1 })
      .limit(limit)
      .toArray();

    await this.touch(results);
    return results;
  }

  async stats(userId: string) {
    const total = await this.db.memories.countDocuments({ userId });
    const categories: MemoryCategory[] = [
      'preference',
      'fact',
      'event',
      'relationship',
      'task',
      'goal',
    ];
    const byCategory = {} as Record<MemoryCategory, number>;
    for (const cat of categories) {
      byCategory[cat] = await this.db.memories.countDocuments({ userId, category: cat });
    }
    const highImportance = await this.db.memories.countDocuments({
      userId,
      importance: { $gte: 0.7 },
    });
    return { total, byCategory, highImportance };
  }

  formatContext(memories: Memory[]): string {
    if (!memories.length) return '';
    return memories
      .map((m) => `- [${m.category}] ${m.content}`)
      .join('\n');
  }

  private async touch(memories: Memory[]) {
    const ids = memories.map((m) => m._id).filter(Boolean);
    if (!ids.length) return;
    await this.db.memories.updateMany(
      { _id: { $in: ids as any } },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
    );
  }

  private cosine(a: number[], b: number[]): number {
    if (!a.length || !b.length || a.length !== b.length) return -1;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return -1;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  private validateCategory(category: string): MemoryCategory {
    const valid: MemoryCategory[] = [
      'preference',
      'fact',
      'event',
      'relationship',
      'task',
      'goal',
    ];
    return valid.includes(category as MemoryCategory) ? (category as MemoryCategory) : 'fact';
  }

  private cleanJson(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```')) {
      return trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    }
    return trimmed;
  }
}
