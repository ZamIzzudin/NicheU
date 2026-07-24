import { Memory, MemoryCategory, MemoryExtractionResult } from '../../../shared/types';
import { Client } from '../../core/client';
import { Database } from '../../db/mongo';
import { env } from '../../config/env';

export class MemoryService {
  constructor(private db: Database, private client: Client) {}

  async extractAndStore(
    userId: string,
    message: string,
    options: { minImportance?: number; source?: string } = {}
  ): Promise<Memory[]> {
    const minImportance = options.minImportance ?? env.memoryImportanceThreshold;
    const extracted = await this.extract(userId, message);
    const stored: Memory[] = [];

    for (const item of extracted.memories) {
      if (item.importance < minImportance) continue;
      const near = await this.findNearDuplicate(userId, item.content);
      if (near) {
        // Strengthen / refresh existing instead of creating a twin
        await this.reinforceMemory(near, item.importance, options.source || 'realtime');
        continue;
      }

      const memory = await this.addMemory({
        userId,
        content: item.content,
        importance: item.importance,
        category: item.category,
        metadata: {
          ...(item.metadata || {}),
          source: options.source || 'realtime',
        },
      });
      stored.push(memory);
    }

    return stored;
  }

  /**
   * Nightly "sleep": scan a full day transcript and persist only durable memories.
   * Returns how many memories stored + a short day summary for morning continuity.
   */
  async consolidateDayTranscript(
    userId: string,
    date: string,
    messages: Array<{ role: string; content: string | unknown }>,
    existingDaySummary?: string
  ): Promise<{ stored: Memory[]; daySummary: string }> {
    const transcript = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const content =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as any[])
                  .map((p) => (typeof p === 'string' ? p : p?.text || ''))
                  .filter(Boolean)
                  .join(' ')
              : String(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n')
      .slice(0, 14000);

    if (!transcript.trim()) {
      return { stored: [], daySummary: existingDaySummary || '' };
    }

    const system = `You are the nightly memory consolidator for a personal WhatsApp partner AI.
The day is over (like sleep). Read the day's chat and extract ONLY durable long-term memories.

Return ONLY JSON:
{
  "memories": [
    {
      "content": "short factual memory in Indonesian or original language",
      "importance": 0.0,
      "category": "preference|fact|event|relationship|task|goal",
      "metadata": {}
    }
  ],
  "daySummary": "120 words max: continuous thread of the day for soft morning context",
  "confidence": 0.0
}

Rules:
- Keep: preferences, promises, relationship facts, important events, ongoing tasks/goals.
- Drop: small talk, one-off jokes, temporary mood, pure logistics already done, repeated fluff.
- importance 0-1; only include items you would still want in 2 weeks.
- Prefer fewer high-quality memories over many weak ones.
- Do not invent facts not present in the chat.
- daySummary is NOT a memory list; it's a short story of the day.`;

    let parsed: any = {};
    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Date: ${date}\nUserId: ${userId}\n${
              existingDaySummary ? `Rolling day summary so far:\n${existingDaySummary}\n\n` : ''
            }Transcript:\n${transcript}`,
          },
        ],
        { temperature: 0.25, responseFormat: { type: 'json_object' } }
      );
      parsed = JSON.parse(this.cleanJson(result.content));
    } catch (error) {
      console.warn('Nightly consolidate parse failed:', (error as Error).message);
      // Fallback: run standard extract on the whole transcript
      const fallback = await this.extractAndStore(userId, transcript, {
        minImportance: env.memoryImportanceThreshold,
        source: `nightly:${date}`,
      });
      return {
        stored: fallback,
        daySummary: existingDaySummary || '',
      };
    }

    const stored: Memory[] = [];
    const list = Array.isArray(parsed.memories) ? parsed.memories : [];
    for (const raw of list) {
      if (!raw || typeof raw.content !== 'string') continue;
      const content = String(raw.content).trim();
      if (!content) continue;
      const importance = Math.min(1, Math.max(0, Number(raw.importance) || 0));
      if (importance < env.memoryImportanceThreshold) continue;

      const near = await this.findNearDuplicate(userId, content);
      if (near) {
        await this.reinforceMemory(near, importance, `nightly:${date}`);
        continue;
      }

      const memory = await this.addMemory({
        userId,
        content,
        importance,
        category: this.validateCategory(String(raw.category || 'fact')),
        metadata: {
          ...(raw.metadata || {}),
          source: `nightly:${date}`,
          consolidatedAt: new Date().toISOString(),
        },
      });
      stored.push(memory);
    }

    const daySummary =
      typeof parsed.daySummary === 'string' && parsed.daySummary.trim()
        ? parsed.daySummary.trim()
        : existingDaySummary || '';

    console.log(
      `🌙 Consolidated ${date}: +${stored.length} memories, summary=${daySummary ? 'yes' : 'no'}`
    );
    return { stored, daySummary };
  }

  /**
   * Nightly hygiene: analyse long-term memory bank and merge near-duplicates
   * so retrieval context stays lean. Safe to run after day transcript consolidate.
   */
  async hygienizeMemories(userId: string): Promise<{
    scanned: number;
    clusters: number;
    removed: number;
    merged: number;
  }> {
    if (!env.enableNightlyMemoryHygiene) {
      return { scanned: 0, clusters: 0, removed: 0, merged: 0 };
    }

    const maxScan = Math.max(40, env.memoryDedupMaxScan || 250);
    const memories = await this.db.memories
      .find({ userId })
      .sort({ importance: -1, updatedAt: -1, createdAt: -1 })
      .limit(maxScan)
      .toArray();

    if (memories.length < 2) {
      return { scanned: memories.length, clusters: 0, removed: 0, merged: 0 };
    }

    // Ensure most memories have embeddings for cosine clustering
    for (const m of memories) {
      if (!m.embedding?.length) {
        try {
          m.embedding = await this.client.embed(m.content);
          await this.db.memories.updateOne(
            { _id: m._id as any },
            { $set: { embedding: m.embedding, updatedAt: new Date() } }
          );
        } catch {
          // keep without vector; text methods still apply
        }
      }
    }

    const cosineThr = Math.min(0.99, Math.max(0.8, env.memoryDedupCosineThreshold || 0.9));
    const tokenThr = Math.min(0.95, Math.max(0.55, env.memoryDedupTokenOverlap || 0.72));
    const parent = memories.map((_, i) => i);
    const find = (i: number): number => {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      // keep higher importance as root when possible
      if ((memories[ra].importance || 0) >= (memories[rb].importance || 0)) parent[rb] = ra;
      else parent[ra] = rb;
    };

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (this.areNearDuplicate(memories[i], memories[j], cosineThr, tokenThr)) {
          union(i, j);
        }
      }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < memories.length; i++) {
      const root = find(i);
      const list = clusters.get(root) || [];
      list.push(i);
      clusters.set(root, list);
    }

    let removed = 0;
    let merged = 0;
    let clusterCount = 0;

    for (const [, idxs] of clusters) {
      if (idxs.length < 2) continue;
      clusterCount += 1;
      const group = idxs.map((i) => memories[i]);
      // Prefer canonical: highest importance, then most accessed, then newest
      group.sort((a, b) => {
        if ((b.importance || 0) !== (a.importance || 0)) {
          return (b.importance || 0) - (a.importance || 0);
        }
        if ((b.accessCount || 0) !== (a.accessCount || 0)) {
          return (b.accessCount || 0) - (a.accessCount || 0);
        }
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
      });

      let keeper = group[0];
      const dupes = group.slice(1);

      // LLM merge when cluster is large or contents differ more than exact text
      const needsMerge =
        group.length >= 3 ||
        group.some((g) => this.normalizeMemoryText(g.content) !== this.normalizeMemoryText(keeper.content));

      if (needsMerge) {
        try {
          const mergedContent = await this.llmMergeCluster(group);
          if (mergedContent && mergedContent.trim()) {
            const nextImportance = Math.max(...group.map((g) => g.importance || 0));
            const nextCategory = keeper.category;
            let embedding: number[] | undefined;
            try {
              embedding = await this.client.embed(mergedContent);
            } catch {
              embedding = keeper.embedding;
            }
            await this.db.memories.updateOne(
              { _id: keeper._id as any },
              {
                $set: {
                  content: mergedContent.trim(),
                  importance: nextImportance,
                  category: nextCategory,
                  embedding,
                  updatedAt: new Date(),
                  metadata: {
                    ...(keeper.metadata || {}),
                    mergedFrom: group.length,
                    hygieneAt: new Date().toISOString(),
                  },
                },
                $inc: { accessCount: dupes.reduce((s, d) => s + (d.accessCount || 0), 0) },
              }
            );
            keeper = {
              ...keeper,
              content: mergedContent.trim(),
              importance: nextImportance,
              embedding,
            };
            merged += 1;
          }
        } catch (error) {
          console.warn('LLM merge cluster failed:', (error as Error).message);
        }
      } else {
        // Exact-ish twins: bump importance on keeper
        const nextImportance = Math.max(...group.map((g) => g.importance || 0));
        await this.db.memories.updateOne(
          { _id: keeper._id as any },
          {
            $set: {
              importance: nextImportance,
              updatedAt: new Date(),
              metadata: {
                ...(keeper.metadata || {}),
                mergedFrom: group.length,
                hygieneAt: new Date().toISOString(),
              },
            },
            $inc: { accessCount: dupes.reduce((s, d) => s + (d.accessCount || 0), 0) },
          }
        );
      }

      for (const d of dupes) {
        if (!d._id) continue;
        await this.db.memories.deleteOne({ _id: d._id as any });
        removed += 1;
      }
    }

    console.log(
      `🧹 Memory hygiene user=${userId}: scanned=${memories.length} clusters=${clusterCount} merged=${merged} removed=${removed}`
    );
    return { scanned: memories.length, clusters: clusterCount, removed, merged };
  }

  private async llmMergeCluster(group: Memory[]): Promise<string> {
    const lines = group
      .map((m, i) => `${i + 1}. [${m.category}|imp=${m.importance}] ${m.content}`)
      .join('\n');
    const result = await this.client.chat(
      [
        {
          role: 'system',
          content: `Merge near-duplicate long-term memories into ONE concise factual memory.
Return ONLY JSON: {"content":"...", "category":"preference|fact|event|relationship|task|goal"}
Rules:
- Keep all durable unique details; drop pure repetition.
- One short sentence or two max.
- Language: same as majority (usually Indonesian).
- Do not invent new facts.`,
        },
        { role: 'user', content: lines },
      ],
      { temperature: 0.2, responseFormat: { type: 'json_object' } }
    );
    const parsed = JSON.parse(this.cleanJson(result.content));
    return String(parsed.content || '').trim();
  }

  private async findNearDuplicate(userId: string, content: string): Promise<Memory | null> {
    const normalized = this.normalizeMemoryText(content);
    if (!normalized) return null;

    // 1) Exact normalized match via recent candidates + exact content
    const exact = await this.db.memories.findOne({ userId, content });
    if (exact) return exact;

    let embedding: number[] | undefined;
    try {
      embedding = await this.client.embed(content);
    } catch {
      embedding = undefined;
    }

    const candidates = await this.db.memories
      .find({ userId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(120)
      .toArray();

    const cosineThr = Math.min(0.99, Math.max(0.8, env.memoryDedupCosineThreshold || 0.9));
    const tokenThr = Math.min(0.95, Math.max(0.55, env.memoryDedupTokenOverlap || 0.72));

    let best: { m: Memory; score: number } | null = null;
    for (const c of candidates) {
      if (this.normalizeMemoryText(c.content) === normalized) return c;
      const draft: Memory = {
        content,
        importance: 0,
        category: 'fact',
        userId,
        embedding,
        createdAt: new Date(),
        updatedAt: new Date(),
        accessCount: 0,
      };
      if (this.areNearDuplicate(draft, c, cosineThr, tokenThr)) {
        const score =
          embedding && c.embedding?.length
            ? this.cosine(embedding, c.embedding)
            : this.tokenOverlap(normalized, this.normalizeMemoryText(c.content));
        if (!best || score > best.score) best = { m: c, score };
      }
    }
    return best?.m || null;
  }

  private areNearDuplicate(
    a: Memory,
    b: Memory,
    cosineThr: number,
    tokenThr: number
  ): boolean {
    const na = this.normalizeMemoryText(a.content);
    const nb = this.normalizeMemoryText(b.content);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // containment of short phrases
    if (na.length >= 12 && nb.length >= 12) {
      if (na.includes(nb) || nb.includes(na)) {
        const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
        if (ratio >= 0.55) return true;
      }
    }

    const overlap = this.tokenOverlap(na, nb);
    if (overlap >= tokenThr) return true;

    if (a.embedding?.length && b.embedding?.length) {
      const sim = this.cosine(a.embedding, b.embedding);
      if (sim >= cosineThr) return true;
      // high embedding + moderate token overlap
      if (sim >= cosineThr - 0.04 && overlap >= tokenThr - 0.12) return true;
    }
    return false;
  }

  private async reinforceMemory(existing: Memory, importance: number, source: string) {
    if (!existing._id) return;
    const nextImp = Math.max(existing.importance || 0, importance || 0);
    await this.db.memories.updateOne(
      { _id: existing._id as any },
      {
        $set: {
          importance: nextImp,
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
          metadata: {
            ...(existing.metadata || {}),
            lastReinforcedFrom: source,
            lastReinforcedAt: new Date().toISOString(),
          },
        },
        $inc: { accessCount: 1 },
      }
    );
  }

  private normalizeMemoryText(text: string): string {
    return String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenOverlap(a: string, b: string): number {
    const ta = new Set(a.split(' ').filter((t) => t.length > 1));
    const tb = new Set(b.split(' ').filter((t) => t.length > 1));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter += 1;
    const union = ta.size + tb.size - inter;
    return union ? inter / union : 0;
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
