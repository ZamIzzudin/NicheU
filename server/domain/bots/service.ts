import { AutomationBot, BotParameter, BotRun, BotRunStatus } from '../../../shared/types';
import { Database } from '../../db/mongo';
import { randomId } from '../../utils/time';
import { runToolCode, assertSafeCode } from '../tools/sandbox';
import { getBotHandler, listHandlerNames } from './handlers';

export type BotNotify = (userId: string, text: string) => Promise<void>;

/**
 * Manual automation bots (not auto-generated tools).
 * - Triggered by agent via list_bots / run_bot
 * - Validate required params; if missing → agent asks user
 * - Heavy work runs in background; success/fail notified on WhatsApp
 */
export class BotService {
  private notify: BotNotify | null = null;
  private running = new Set<string>();
  private maxConcurrent = 3;

  constructor(private db: Database) {}

  setNotify(fn: BotNotify) {
    this.notify = fn;
  }

  async list(options: { enabledOnly?: boolean } = {}): Promise<AutomationBot[]> {
    const filter: Record<string, unknown> = {};
    if (options.enabledOnly !== false) filter.enabled = true;
    return this.db.bots.find(filter as any).sort({ name: 1 }).toArray();
  }

  async getByName(name: string): Promise<AutomationBot | null> {
    return this.db.bots.findOne({ name });
  }

  async getById(id: string): Promise<AutomationBot | null> {
    return this.db.bots.findOne({ $or: [{ id }, { name: id }] } as any);
  }

  async upsert(input: {
    id?: string;
    name: string;
    title: string;
    description: string;
    triggers?: string[];
    parameters?: BotParameter[];
    handler: string;
    config?: Record<string, unknown>;
    functionCode?: string;
    enabled?: boolean;
    timeoutMs?: number;
    ackMessageHint?: string;
    successMessageHint?: string;
    failureMessageHint?: string;
  }): Promise<AutomationBot> {
    const name = this.normalizeName(input.name);
    if (!name) throw new Error('name required (snake_case)');
    if (!input.title?.trim()) throw new Error('title required');
    if (!input.description?.trim()) throw new Error('description required');
    if (!input.handler?.trim()) throw new Error('handler required');

    if (input.functionCode) {
      assertSafeCode(input.functionCode);
    }

    // Prefer named handlers for heavy work; allow functionCode-only with handler="code"
    if (input.handler !== 'code' && !getBotHandler(input.handler) && !input.functionCode) {
      throw new Error(
        `Unknown handler '${input.handler}'. Registered: ${listHandlerNames().join(', ')} (or use handler=code + functionCode)`
      );
    }

    const existing = await this.db.bots.findOne({ name });
    const now = new Date();
    const bot: AutomationBot = {
      id: input.id || existing?.id || randomId('bot'),
      name,
      title: input.title.trim(),
      description: input.description.trim(),
      triggers: input.triggers || existing?.triggers || [],
      parameters: input.parameters || existing?.parameters || [],
      handler: input.handler.trim(),
      config: input.config ?? existing?.config,
      functionCode: input.functionCode ?? existing?.functionCode,
      enabled: input.enabled ?? existing?.enabled ?? true,
      timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 10 * 60 * 1000,
      ackMessageHint:
        input.ackMessageHint ||
        existing?.ackMessageHint ||
        'okee, nanti aku infoin lagi yaa kalo udah selesai',
      successMessageHint: input.successMessageHint || existing?.successMessageHint,
      failureMessageHint: input.failureMessageHint || existing?.failureMessageHint,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await this.db.bots.updateOne({ name }, { $set: bot }, { upsert: true });
    return bot;
  }

  async setEnabled(name: string, enabled: boolean): Promise<AutomationBot | null> {
    const bot = await this.getByName(name);
    if (!bot) return null;
    await this.db.bots.updateOne(
      { name },
      { $set: { enabled, updatedAt: new Date() } }
    );
    return { ...bot, enabled, updatedAt: new Date() };
  }

  async delete(name: string): Promise<boolean> {
    const res = await this.db.bots.deleteOne({ name });
    return (res.deletedCount || 0) > 0;
  }

  /** Catalog for agent system/tool use. */
  formatCatalog(bots: AutomationBot[]): string {
    if (!bots.length) return 'Tidak ada bot automation aktif.';
    return bots
      .map((b) => {
        const params = b.parameters.length
          ? b.parameters
              .map(
                (p) =>
                  `${p.name}${p.required ? '*' : ''}(${p.type}): ${p.description}` +
                  (p.examples?.length ? ` e.g. ${p.examples.join('|')}` : '')
              )
              .join('; ')
          : '(no params)';
        const triggers = b.triggers?.length ? ` triggers=[${b.triggers.join(', ')}]` : '';
        return `- ${b.name}: ${b.title} — ${b.description}${triggers}\n  params: ${params}`;
      })
      .join('\n');
  }

  validateParameters(
    bot: AutomationBot,
    raw: Record<string, unknown> = {}
  ): {
    ok: boolean;
    params: Record<string, unknown>;
    missing: Array<{ name: string; description: string; type: string; examples?: string[] }>;
    errors: string[];
  } {
    const params: Record<string, unknown> = { ...raw };
    const missing: Array<{ name: string; description: string; type: string; examples?: string[] }> =
      [];
    const errors: string[] = [];

    for (const p of bot.parameters || []) {
      let val = params[p.name];
      if ((val === undefined || val === null || val === '') && p.default !== undefined) {
        val = p.default;
        params[p.name] = val;
      }
      if ((val === undefined || val === null || val === '') && p.required) {
        missing.push({
          name: p.name,
          description: p.description,
          type: p.type,
          examples: p.examples,
        });
        continue;
      }
      if (val === undefined || val === null || val === '') continue;

      // light type coercion
      try {
        params[p.name] = this.coerce(val, p.type);
      } catch (e: any) {
        errors.push(`${p.name}: ${e.message || e}`);
      }
    }

    return { ok: missing.length === 0 && errors.length === 0, params, missing, errors };
  }

  /**
   * Enqueue background run. Returns immediately.
   * Agent should tell user something like "nanti aku infoin lagi ya".
   */
  async enqueueRun(input: {
    userId: string;
    botName: string;
    parameters?: Record<string, unknown>;
    triggerText?: string;
  }): Promise<
    | {
        status: 'need_params';
        bot: { name: string; title: string; description: string };
        missing: Array<{ name: string; description: string; type: string; examples?: string[] }>;
        errors: string[];
        askHint: string;
      }
    | {
        status: 'queued';
        run: { id: string; botName: string; parameters: Record<string, unknown> };
        ackHint: string;
      }
    | { status: 'error'; error: string }
  > {
    const bot = await this.getByName(input.botName);
    if (!bot || !bot.enabled) {
      return { status: 'error', error: `Bot '${input.botName}' not found or disabled` };
    }

    const validation = this.validateParameters(bot, input.parameters || {});
    if (!validation.ok) {
      const askLines = validation.missing.map(
        (m) =>
          `- ${m.name} (${m.type}): ${m.description}` +
          (m.examples?.length ? ` contoh: ${m.examples.join(', ')}` : '')
      );
      return {
        status: 'need_params',
        bot: { name: bot.name, title: bot.title, description: bot.description },
        missing: validation.missing,
        errors: validation.errors,
        askHint:
          `Butuh konfirmasi parameter dulu untuk bot ${bot.title}:\n` +
          askLines.join('\n') +
          (validation.errors.length ? `\nError: ${validation.errors.join('; ')}` : ''),
      };
    }

    const now = new Date();
    const run: BotRun = {
      id: randomId('brun'),
      botId: bot.id,
      botName: bot.name,
      userId: input.userId,
      status: 'queued',
      parameters: validation.params,
      triggerText: input.triggerText?.slice(0, 500),
      notified: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.botRuns.insertOne(run as any);

    // Fire-and-forget background execution
    setImmediate(() => {
      this.processQueue().catch((err) => console.error('Bot queue error:', err));
    });

    return {
      status: 'queued',
      run: { id: run.id, botName: bot.name, parameters: validation.params },
      ackHint:
        bot.ackMessageHint ||
        'okee, nanti aku infoin lagi yaa kalo udah kelar',
    };
  }

  async listRuns(
    userId: string,
    options: { status?: BotRunStatus | 'active' | 'all'; limit?: number } = {}
  ): Promise<BotRun[]> {
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const filter: Record<string, unknown> = { userId };
    if (options.status === 'active' || !options.status) {
      filter.status = { $in: ['queued', 'running'] };
    } else if (options.status !== 'all') {
      filter.status = options.status;
    }
    return this.db.botRuns
      .find(filter as any)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getRun(runId: string): Promise<BotRun | null> {
    return this.db.botRuns.findOne({ id: runId });
  }

  /** Drain queued runs respecting concurrency. */
  async processQueue(): Promise<void> {
    if (this.running.size >= this.maxConcurrent) return;

    const slots = this.maxConcurrent - this.running.size;
    const queued = await this.db.botRuns
      .find({ status: 'queued' })
      .sort({ createdAt: 1 })
      .limit(slots)
      .toArray();

    for (const run of queued) {
      if (this.running.has(run.id)) continue;
      // claim
      const claim = await this.db.botRuns.findOneAndUpdate(
        { id: run.id, status: 'queued' },
        { $set: { status: 'running', startedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const claimed = (claim as any)?.value || (claim as any);
      if (!claimed || claimed.status !== 'running') continue;

      this.running.add(run.id);
      this.executeRun(claimed)
        .catch((err) => console.error(`Bot run ${run.id} fatal:`, err))
        .finally(() => {
          this.running.delete(run.id);
          // try next
          setImmediate(() => {
            this.processQueue().catch(console.error);
          });
        });
    }
  }

  private async executeRun(run: BotRun): Promise<void> {
    const bot = await this.getById(run.botId) || (await this.getByName(run.botName));
    if (!bot) {
      await this.finishRun(run, {
        status: 'failed',
        error: 'Bot definition missing',
      });
      return;
    }

    const timeoutMs = bot.timeoutMs || 10 * 60 * 1000;
    const log = (msg: string, extra?: unknown) => {
      if (extra !== undefined) console.log(`[bot:${bot.name}:${run.id}] ${msg}`, extra);
      else console.log(`[bot:${bot.name}:${run.id}] ${msg}`);
    };

    try {
      log('start', run.parameters);
      const result = await this.withTimeout(
        this.invokeHandler(bot, run, log),
        timeoutMs,
        `Bot '${bot.name}' timeout after ${timeoutMs}ms`
      );
      await this.finishRun(run, { status: 'succeeded', result });
      log('success');
    } catch (error: any) {
      const message = error?.message || String(error);
      await this.finishRun(run, { status: 'failed', error: message });
      log('failed: ' + message);
    }
  }

  private async invokeHandler(
    bot: AutomationBot,
    run: BotRun,
    log: (msg: string, extra?: unknown) => void
  ): Promise<unknown> {
    const ctx = {
      userId: run.userId,
      botName: bot.name,
      runId: run.id,
      config: bot.config,
      log,
    };

    if (bot.handler && bot.handler !== 'code') {
      const handler = getBotHandler(bot.handler);
      if (!handler) throw new Error(`Handler '${bot.handler}' not registered in code`);
      return handler(run.parameters || {}, ctx);
    }

    if (bot.functionCode) {
      // Longer timeout for bot code than interactive tools
      return runToolCode(
        bot.functionCode,
        {
          ...run.parameters,
          __userId: run.userId,
          __runId: run.id,
          __config: bot.config || {},
        },
        {
          httpGetJson: async (url: string) => {
            const axios = (await import('axios')).default;
            const res = await axios.get(url, { timeout: 60000 });
            return res.data;
          },
          httpPostJson: async (url: string, body: unknown) => {
            const axios = (await import('axios')).default;
            const res = await axios.post(url, body, { timeout: 60000 });
            return res.data;
          },
          sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 120000))),
        },
        bot.timeoutMs || 10 * 60 * 1000
      );
    }

    throw new Error('Bot has neither named handler nor functionCode');
  }

  private async finishRun(
    run: BotRun,
    outcome: { status: 'succeeded' | 'failed'; result?: unknown; error?: string }
  ) {
    const finishedAt = new Date();
    await this.db.botRuns.updateOne(
      { id: run.id },
      {
        $set: {
          status: outcome.status,
          result: outcome.result,
          error: outcome.error,
          finishedAt,
          updatedAt: finishedAt,
        },
      }
    );

    // Notify user on WhatsApp (success or fail)
    await this.notifyOutcome({ ...run, ...outcome, finishedAt, status: outcome.status });
  }

  private async notifyOutcome(run: BotRun) {
    if (!this.notify) {
      console.warn(`[bot] no notify callback; run ${run.id} ${run.status}`);
      return;
    }
    if (run.notified) return;

    const bot = (await this.getByName(run.botName)) || null;
    const title = bot?.title || run.botName;
    const resultObj =
      run.result && typeof run.result === 'object'
        ? (run.result as Record<string, unknown>)
        : null;
    const humanChat = resultObj?.notifyStyle === 'human_chat';
    let text = '';

    if (run.status === 'succeeded') {
      const summary = this.summarizeResult(run.result);
      if (humanChat) {
        // Natural persona chat only — no "bot finished", no run id, no link dump
        text = summary || 'udah aku cek yaa';
      } else {
        text =
          (bot?.successMessageHint
            ? `${bot.successMessageHint}\n\n`
            : `bot *${title}* udah kelarr\n\n`) + (summary ? `${summary}` : '');
      }
    } else {
      if (humanChat) {
        text =
          this.summarizeResult(run.result) ||
          'waduh barusan gagal nyariin 😞\n\ncoba lagi bentar yaa';
      } else {
        // Soften technical errors for chat
        const err = String(run.error || 'unknown error');
        const soft =
          /captcha|blocked|quota|429|timeout/i.test(err)
            ? 'aduuh barusan macet pas lagi ngerjain\n\ncoba lagi nanti yaa'
            : `aduuh gagal barusan\n\n${err.slice(0, 200)}`;
        text = soft;
      }
    }

    // Never append internal run ids in user-facing notify
    text = text
      .replace(/\bid:\s*brun_\w+/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 2800);

    try {
      await this.notify(run.userId, text);
      await this.db.botRuns.updateOne(
        { id: run.id },
        { $set: { notified: true, updatedAt: new Date() } }
      );
    } catch (error: any) {
      console.warn(`[bot] notify failed for ${run.id}:`, error?.message || error);
    }
  }

  private summarizeResult(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result.slice(0, 2800);
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      // Prefer human chat body from handlers (e.g. google_search)
      if (typeof obj.message === 'string' && obj.message.trim()) {
        return obj.message.trim().slice(0, 2800);
      }
      if (typeof obj.summary === 'string' && obj.summary.trim()) {
        return obj.summary.trim().slice(0, 2800);
      }
      // Never dump results[] arrays as numbered link lists to WA
      if (Array.isArray(obj.results)) {
        return '';
      }
    }
    try {
      const s = JSON.stringify(result, null, 0);
      return s.length > 800 ? s.slice(0, 797) + '...' : s;
    } catch {
      return String(result).slice(0, 800);
    }
  }

  private coerce(value: unknown, type: string): unknown {
    if (type === 'string') return String(value);
    if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('must be number');
      return n;
    }
    if (type === 'boolean') {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (['1', 'true', 'yes', 'ya', 'y'].includes(s)) return true;
      if (['0', 'false', 'no', 'tidak', 'n'].includes(s)) return false;
      throw new Error('must be boolean');
    }
    if (type === 'object' || type === 'array') {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          throw new Error(`must be valid JSON ${type}`);
        }
      }
      return value;
    }
    return value;
  }

  private normalizeName(name: string): string {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Ensure stock bots exist (idempotent upsert for critical ones).
   * google_search is always kept in sync; demos only if catalog was empty.
   */
  async ensureDemoBots(): Promise<void> {
    const count = await this.db.bots.countDocuments({});

    // Always ensure google_search bot (replaces broken DuckDuckGo sync tool)
    await this.upsert({
      name: 'google_search',
      title: 'Google Search',
      description:
        'Mencari informasi di internet (Google, browser Firefox headless). ' +
        'PAKAI otomatis saat user minta tolong dicarikan info, meski kalimatnya santai dan tidak menyebut "google" atau "bot". ' +
        'Contoh niat: "bisa cariin ... gak?", "cariin dong ...", "tolong carikan ...", "tau gak ...", ' +
        '"ada info ...", cek harga/berita/jadwal/cuaca/fakta terbaru, atau hal yang butuh data web. ' +
        'Background job: setelah jalan, bilang nanti dikabari; hasil final via WhatsApp. ' +
        'Param query = intisari yang dicari (bukan seluruh basabasi user).',
      triggers: [
        'cariin',
        'carikan',
        'bantu cari',
        'bantuin cari',
        'bisa cari',
        'tolong cari',
        'cari dong',
        'cariin dong',
        'googlein',
        'search',
        'cari berita',
        'cari info',
        'cek dulu',
        'tau gak',
        'ada info',
        'berapa sih',
        'browsing',
        'web search',
      ],
      handler: 'google_search',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description:
            'Intisari pencarian (natural). Contoh user "bisa cariin harga iPhone 16 gak?" → "harga iPhone 16"',
          required: true,
          examples: [
            'cuaca Jakarta hari ini',
            'harga bitcoin',
            'jadwal F1 2026',
            'siapa CEO OpenAI',
          ],
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Jumlah hasil (1-10, default 5)',
          required: false,
          default: 5,
          examples: ['5', '8'],
        },
      ],
      enabled: true,
      timeoutMs: 4 * 60 * 1000,
      config: { defaultLimit: 5, readPages: 3 },
      ackMessageHint:
        'bisaaa\n\naku carikan duluu yaa\n\nnanti aku kabarin kalo udah ketemu',
      // Empty hints: notify uses pure humanized message from handler
      successMessageHint: '',
      failureMessageHint: '',
    });

    if (count > 0) {
      console.log('✓ Ensured automation bot: google_search');
      return;
    }

    await this.upsert({
      name: 'demo_long_job',
      title: 'Demo Long Job',
      description:
        'Job demo berjalan di background beberapa detik untuk tes notifikasi WhatsApp. Gunakan untuk uji bot automation, bukan pekerjaan sungguhan.',
      triggers: ['demo bot', 'tes bot', 'long job'],
      handler: 'demo_long_job',
      parameters: [
        {
          name: 'seconds',
          type: 'number',
          description: 'Durasi dummy job dalam detik (1-120)',
          required: false,
          default: 5,
          examples: ['5', '15'],
        },
        {
          name: 'label',
          type: 'string',
          description: 'Label opsional untuk hasil',
          required: false,
          examples: ['tes deploy'],
        },
      ],
      enabled: true,
      timeoutMs: 3 * 60 * 1000,
      ackMessageHint: 'okees, aku jalanin di belakang yaa\n\nnanti aku kabarin kalo udah selesai',
      successMessageHint: 'demo long job kelarr ✅',
      failureMessageHint: 'demo long job gagal ❌',
    });

    await this.upsert({
      name: 'http_fetch',
      title: 'HTTP Fetch',
      description:
        'Ambil konten dari URL di background (bukan tool sinkron). Cocok untuk fetch halaman/API yang butuh waktu.',
      triggers: ['fetch url', 'ambil url', 'http fetch'],
      handler: 'http_fetch',
      parameters: [
        {
          name: 'url',
          type: 'string',
          description: 'URL lengkap yang mau di-fetch',
          required: true,
          examples: ['https://example.com'],
        },
      ],
      enabled: true,
      timeoutMs: 2 * 60 * 1000,
      ackMessageHint: 'siapp, aku fetch di belakang duluu\n\nnanti aku infoin hasilnya',
    });

    console.log('✓ Seeded automation bots (google_search, demo_long_job, http_fetch)');
  }
}
