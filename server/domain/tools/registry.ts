import { Tool, ToolExecution, ToolParameter } from '../../../shared/types';
import { ToolDefinition, ToolResult } from '../../core/types';
import { Database } from '../../db/mongo';
import { runToolCode, assertSafeCode } from './sandbox';
import { formatDateInTz, formatTimeInTz, randomId } from '../../utils/time';

type ExecContext = {
  userId?: string;
  memoryService?: {
    search: (userId: string, query: string, limit?: number) => Promise<unknown>;
    addMemory: (input: any) => Promise<unknown>;
  };
  scheduleService?: {
    getToday: (userId: string) => Promise<unknown>;
    formatTodayContext: (schedule: any) => string;
  };
  personaService?: {
    get: (userId: string) => Promise<unknown>;
  };
  moodService?: {
    getToday: (userId: string) => Promise<unknown>;
    formatContext: (mood: any) => string;
    setMood: (userId: string, input: any) => Promise<unknown>;
  };
  reminderService?: {
    createFromNatural: (input: {
      userId: string;
      text: string;
      when: string;
      sourceText?: string;
    }) => Promise<any>;
    create: (input: {
      userId: string;
      text: string;
      dueAt: Date;
      rawWhen?: string;
      sourceText?: string;
    }) => Promise<any>;
    list: (userId: string, options?: any) => Promise<any[]>;
    cancel: (userId: string, reminderId: string) => Promise<any>;
    cancelAllPending: (userId: string) => Promise<number>;
    formatConfirm: (reminder: any) => string;
    formatActiveContext: (reminders: any[]) => string;
    parseWhen: (when: string, sourceText?: string) => Promise<Date>;
  };
  botService?: {
    list: (options?: { enabledOnly?: boolean }) => Promise<any[]>;
    formatCatalog: (bots: any[]) => string;
    enqueueRun: (input: {
      userId: string;
      botName: string;
      parameters?: Record<string, unknown>;
      triggerText?: string;
    }) => Promise<any>;
    listRuns: (userId: string, options?: any) => Promise<any[]>;
    getRun: (runId: string) => Promise<any>;
    getByName: (name: string) => Promise<any>;
  };
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private runtime = new Map<string, (args: Record<string, unknown>, ctx?: ExecContext) => Promise<unknown>>();
  private context: ExecContext = {};

  constructor(private db: Database) {}

  setContext(ctx: ExecContext) {
    this.context = { ...this.context, ...ctx };
  }

  getContext(): ExecContext {
    return this.context;
  }

  async init(): Promise<void> {
    await this.ensureBuiltinTools();
    const stored = await this.db.tools.find({}).toArray();
    for (const tool of stored) {
      this.tools.set(tool.name, tool);
      this.bindRuntime(tool);
    }
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((t) => t.enabled)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: tool.parameters.reduce((acc, param) => {
              acc[param.name] = {
                type: param.type === 'array' ? 'array' : param.type,
                description: param.description,
              };
              return acc;
            }, {} as Record<string, unknown>),
            required: tool.parameters.filter((p) => p.required).map((p) => p.name),
          },
        },
      }));
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getToolsByCategory(category: Tool['category']): Tool[] {
    return this.getAllTools().filter((t) => t.category === category);
  }

  getById(id: string): Tool | undefined {
    return this.getAllTools().find((t) => t.id === id);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async executeBatch(
    calls: Array<{ id: string; name: string; argumentsStr: string }>,
    ctx?: ExecContext
  ): Promise<ToolResult[]> {
    const mergedCtx = { ...this.context, ...ctx };
    const results: ToolResult[] = [];

    for (const call of calls) {
      try {
        const args = this.parseArgs(call.argumentsStr);
        const output = await this.execute(call.name, args, mergedCtx);
        results.push({
          id: call.id,
          output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
        });
      } catch (error: any) {
        results.push({
          id: call.id,
          output: JSON.stringify({ success: false, error: error.message || String(error) }),
        });
      }
    }

    return results;
  }

  async execute(name: string, parameters: Record<string, unknown>, ctx?: ExecContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool '${name}' not found`);
    if (!tool.enabled) throw new Error(`Tool '${name}' is disabled`);

    this.validateParameters(tool, parameters);
    const runtime = this.runtime.get(name);
    if (!runtime) throw new Error(`No runtime bound for tool '${name}'`);

    try {
      const result = await runtime(parameters, { ...this.context, ...ctx });
      await this.logExecution(tool, parameters, result, true);
      return result;
    } catch (error: any) {
      await this.logExecution(tool, parameters, null, false, error.message);
      throw error;
    }
  }

  async createTool(input: {
    name: string;
    description: string;
    category?: Tool['category'];
    functionCode: string;
    parameters?: ToolParameter[];
    source?: Tool['source'];
    builtin?: boolean;
    enabled?: boolean;
  }): Promise<Tool> {
    const name = input.name.trim().replace(/\s+/g, '_').toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
      throw new Error('Invalid tool name. Use snake_case letters/numbers.');
    }

    assertSafeCode(input.functionCode);

    const existing = this.tools.get(name);
    const tool: Tool = {
      id: existing?.id || randomId('tool'),
      name,
      description: input.description,
      category: input.category || 'custom',
      functionCode: input.functionCode,
      parameters: input.parameters || [],
      enabled: input.enabled ?? true,
      builtin: input.builtin ?? false,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
      source: input.source || 'self_created',
    };

    await this.db.tools.updateOne({ name: tool.name }, { $set: tool }, { upsert: true });
    this.tools.set(tool.name, tool);
    this.bindRuntime(tool);
    return tool;
  }

  async updateTool(id: string, updates: Partial<Tool>): Promise<Tool> {
    const tool = this.getById(id);
    if (!tool) throw new Error('Tool not found');

    if (updates.functionCode) assertSafeCode(updates.functionCode);

    const next: Tool = {
      ...tool,
      ...updates,
      id: tool.id,
      name: updates.name || tool.name,
      updatedAt: new Date(),
    };

    if (next.name !== tool.name) {
      this.tools.delete(tool.name);
      this.runtime.delete(tool.name);
    }

    if (next.name !== tool.name) {
      await this.db.tools.deleteOne({ name: tool.name });
    }
    await this.db.tools.updateOne({ name: next.name }, { $set: next }, { upsert: true });
    this.tools.set(next.name, next);
    this.bindRuntime(next);
    return next;
  }

  async deleteTool(id: string): Promise<void> {
    const tool = this.getById(id);
    if (!tool) throw new Error('Tool not found');
    if (tool.builtin) throw new Error('Cannot delete builtin tool');
    await this.db.tools.deleteOne({ name: tool.name });
    this.tools.delete(tool.name);
    this.runtime.delete(tool.name);
  }

  async getExecutionHistory(toolId: string, limit = 20): Promise<ToolExecution[]> {
    return this.db.toolExecutions.find({ toolId }).sort({ timestamp: -1 }).limit(limit).toArray();
  }

  private bindRuntime(tool: Tool) {
    if (tool.builtin) {
      const fn = this.builtinRuntime(tool.name);
      if (fn) {
        this.runtime.set(tool.name, fn);
        return;
      }
    }

    this.runtime.set(tool.name, async (args) => {
      return runToolCode(tool.functionCode, args, {
        // Limited helpers for custom tools
        httpGetJson: async (url: string) => {
          const axios = (await import('axios')).default;
          const res = await axios.get(url, { timeout: 10000 });
          return res.data;
        },
      });
    });
  }

  private builtinRuntime(name: string) {
    const map: Record<string, (args: Record<string, unknown>, ctx?: ExecContext) => Promise<unknown>> = {
      get_current_time: async () => {
        const { buildClockContext } = await import('../../utils/time');
        const clock = buildClockContext();
        return {
          success: true,
          timezone: clock.timezone,
          date: clock.date,
          time: clock.time,
          hour: clock.hour,
          minute: clock.minute,
          period: clock.period,
          periodLabel: clock.periodLabel,
          weekday: clock.weekday,
          longDate: clock.longDate,
          quietHours: clock.quietHours,
          greeting: clock.greeting,
          behaviorHint: clock.behaviorHint,
          antiPatterns: clock.antiPatterns,
          summary: `Sekarang ${clock.longDate}, jam ${clock.time} (${clock.periodLabel}) di ${clock.timezone}.`,
        };
      },
      web_search: async (args, ctx) => {
        // Legacy sync tool is broken/unreliable (DuckDuckGo). Route to background bot.
        const query = String(args.query || args.q || '').trim();
        if (!query) return { success: false, error: 'query required' };
        if (!ctx?.userId || !ctx?.botService) {
          return {
            success: false,
            error:
              'web_search sinkron sudah dinonaktifkan. Gunakan run_bot bot_name=google_search (butuh botService).',
          };
        }
        const result = await ctx.botService.enqueueRun({
          userId: ctx.userId,
          botName: 'google_search',
          parameters: {
            query,
            limit: Number(args.limit || 5),
          },
          triggerText: query,
        });
        if (result.status === 'need_params') {
          return { success: false, need_params: true, ...result };
        }
        if (result.status === 'error') {
          return { success: false, error: result.error };
        }
        return {
          success: true,
          queued: true,
          migrated: true,
          run: result.run,
          instruction:
            'Search dijalankan di BACKGROUND lewat bot google_search (Playwright Firefox). ' +
            'Kasih tau user "nanti aku infoin hasilnya ya". Jangan ngarang hasil sekarang.',
          ackHint: result.ackHint,
        };
      },
      get_my_schedule: async (_args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.scheduleService) return { success: false, error: 'No schedule context' };
        const schedule = await ctx.scheduleService.getToday(userId);
        return {
          success: true,
          context: ctx.scheduleService.formatTodayContext(schedule),
          schedule,
        };
      },
      get_persona: async (_args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.personaService) return { success: false, error: 'No persona context' };
        const persona = await ctx.personaService.get(userId);
        return { success: true, persona };
      },
      get_my_mood: async (_args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.moodService) return { success: false, error: 'No mood context' };
        const mood = await ctx.moodService.getToday(userId);
        return {
          success: true,
          context: ctx.moodService.formatContext(mood),
          mood,
        };
      },
      set_reminder: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.reminderService) {
          return { success: false, error: 'No reminder context' };
        }
        const text = String(args.text || args.message || '').trim();
        const when = String(args.when || args.time || '').trim();
        if (!text) return { success: false, error: 'text required (what to remind)' };
        if (!when) {
          return {
            success: false,
            error: 'when required, e.g. "15 menit lagi", "jam 20:00", "besok jam 8"',
          };
        }
        try {
          const reminder = await ctx.reminderService.createFromNatural({
            userId,
            text,
            when,
            sourceText: args.source_text ? String(args.source_text) : undefined,
          });
          return {
            success: true,
            reminder: {
              id: reminder.id,
              text: reminder.text,
              dueAt: reminder.dueAt,
              status: reminder.status,
              localDue: `${formatDateInTz(new Date(reminder.dueAt))} ${formatTimeInTz(new Date(reminder.dueAt))}`,
            },
            confirmHint: ctx.reminderService.formatConfirm(reminder),
            note: 'Reminder is EPHEMERAL (not long-term memory). It will fire once then leave active context.',
          };
        } catch (error: any) {
          return { success: false, error: error?.message || String(error) };
        }
      },
      list_reminders: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.reminderService) {
          return { success: false, error: 'No reminder context' };
        }
        const status = (args.status as string) || 'active';
        const reminders = await ctx.reminderService.list(userId, {
          status: status as any,
          limit: Number(args.limit || 20),
        });
        const { formatDateInTz, formatTimeInTz } = await import('../../utils/time');
        return {
          success: true,
          count: reminders.length,
          reminders: reminders.map((r: any) => ({
            id: r.id,
            text: r.text,
            status: r.status,
            dueAt: r.dueAt,
            localDue: `${formatDateInTz(new Date(r.dueAt))} ${formatTimeInTz(new Date(r.dueAt))}`,
          })),
          context: ctx.reminderService.formatActiveContext(reminders),
        };
      },
      cancel_reminder: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.reminderService) {
          return { success: false, error: 'No reminder context' };
        }
        if (args.all === true || String(args.reminder_id || '').toLowerCase() === 'all') {
          const n = await ctx.reminderService.cancelAllPending(userId);
          return { success: true, cancelled: n, message: `Cancelled ${n} pending reminders` };
        }
        const id = String(args.reminder_id || args.id || '').trim();
        if (!id) return { success: false, error: 'reminder_id required (or all=true)' };
        const rem = await ctx.reminderService.cancel(userId, id);
        if (!rem) return { success: false, error: 'Reminder not found' };
        return { success: true, reminder: { id: rem.id, status: rem.status, text: rem.text } };
      },
      list_bots: async (args, ctx) => {
        if (!ctx?.botService) return { success: false, error: 'No bot service' };
        const bots = await ctx.botService.list({ enabledOnly: args.include_disabled !== true });
        return {
          success: true,
          count: bots.length,
          catalog: ctx.botService.formatCatalog(bots),
          bots: bots.map((b: any) => ({
            name: b.name,
            title: b.title,
            description: b.description,
            triggers: b.triggers || [],
            parameters: b.parameters || [],
            enabled: b.enabled,
          })),
          note: 'Bots are HEAVY background automations (not sync tools). Use run_bot; user will get WA notify when done.',
        };
      },
      run_bot: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.botService) {
          return { success: false, error: 'No bot service / user' };
        }
        const botName = String(args.bot_name || args.name || '').trim();
        if (!botName) return { success: false, error: 'bot_name required' };

        let parameters: Record<string, unknown> = {};
        if (args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)) {
          parameters = args.parameters as Record<string, unknown>;
        } else if (typeof args.parameters_json === 'string' && args.parameters_json.trim()) {
          try {
            parameters = JSON.parse(args.parameters_json);
          } catch {
            return { success: false, error: 'parameters_json must be valid JSON object' };
          }
        }

        // Also accept flat extra keys (except reserved)
        const reserved = new Set([
          'bot_name',
          'name',
          'parameters',
          'parameters_json',
          'trigger_text',
          'source_text',
        ]);
        for (const [k, v] of Object.entries(args)) {
          if (!reserved.has(k) && parameters[k] === undefined) parameters[k] = v;
        }

        const result = await ctx.botService.enqueueRun({
          userId,
          botName,
          parameters,
          triggerText: args.trigger_text
            ? String(args.trigger_text)
            : args.source_text
              ? String(args.source_text)
              : undefined,
        });

        if (result.status === 'need_params') {
          return {
            success: false,
            need_params: true,
            missing: result.missing,
            errors: result.errors,
            bot: result.bot,
            instruction:
              'ASK the user for the missing parameters in persona style, then call run_bot again with complete params. Do NOT pretend the bot finished.',
            askHint: result.askHint,
          };
        }
        if (result.status === 'error') {
          return { success: false, error: result.error };
        }

        return {
          success: true,
          queued: true,
          run: result.run,
          instruction:
            'Tell user the bot is running in background in persona style (e.g. "nanti aku infoin lagi ya"). Do NOT invent the result now — WhatsApp notify comes later.',
          ackHint: result.ackHint,
        };
      },
      list_bot_runs: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.botService) {
          return { success: false, error: 'No bot service / user' };
        }
        const status = (args.status as string) || 'active';
        const runs = await ctx.botService.listRuns(userId, {
          status: status as any,
          limit: Number(args.limit || 20),
        });
        return {
          success: true,
          count: runs.length,
          runs: runs.map((r: any) => ({
            id: r.id,
            botName: r.botName,
            status: r.status,
            parameters: r.parameters,
            createdAt: r.createdAt,
            finishedAt: r.finishedAt,
            error: r.error,
          })),
        };
      },
      remember_fact: async (args, ctx) => {
        const userId = ctx?.userId;
        if (!userId || !ctx?.memoryService) return { success: false, error: 'No memory context' };
        const content = String(args.content || '').trim();
        if (!content) return { success: false, error: 'content required' };
        const memory = await ctx.memoryService.addMemory({
          userId,
          content,
          importance: Number(args.importance || 0.85),
          category: (args.category as any) || 'fact',
          metadata: { source: 'tool' },
        });
        return { success: true, memory };
      },
      create_custom_tool: async (args) => {
        const name = String(args.name || '');
        const description = String(args.description || '');
        const functionCode = String(args.function_code || args.functionCode || '');
        let parameters: ToolParameter[] = [];
        if (typeof args.parameters_json === 'string' && args.parameters_json.trim()) {
          parameters = JSON.parse(args.parameters_json);
        } else if (Array.isArray(args.parameters)) {
          parameters = args.parameters as ToolParameter[];
        }

        const tool = await this.createTool({
          name,
          description,
          functionCode,
          parameters,
          category: 'custom',
          source: 'self_created',
          enabled: true,
        });

        return {
          success: true,
          message: `Tool '${tool.name}' created and enabled.`,
          tool: {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        };
      },
      list_tools: async () => {
        return {
          success: true,
          tools: this.getAllTools().map((t) => ({
            name: t.name,
            description: t.description,
            enabled: t.enabled,
            category: t.category,
            source: t.source,
          })),
        };
      },
    };

    return map[name];
  }

  private async ensureBuiltinTools() {
    const builtins: Array<Omit<Tool, 'createdAt' | 'updatedAt'>> = [
      {
        id: 'builtin_get_current_time',
        name: 'get_current_time',
        description:
          'Get accurate local date/time, day period (pagi/siang/sore/malam), timezone, and greeting hints. Use when unsure about current time-of-day.',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_web_search',
        name: 'web_search',
        description:
          'Cari info di internet (background Google via Playwright). Panggil otomatis saat user minta dicarikan sesuatu dengan bahasa natural: "cariin", "bisa bantu cari ... gak?", "tolong carikan", "tau gak ...", cek harga/berita/jadwal/fakta terbaru. query = intisari topik (bukan full basabasi). Setelah queue, bilang nanti dikabari; hasil menyusul di WA. Jangan mengarang hasil.',
        category: 'information',
        functionCode: 'async function execute({ query }) { return { query }; }',
        parameters: [
          {
            name: 'query',
            type: 'string',
            description:
              'Intisari yang dicari. "bisa cariin harga RTX 5090 gak?" → "harga RTX 5090"',
            required: true,
          },
          { name: 'limit', type: 'number', description: 'Max results (default 5)', required: false },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_get_my_schedule',
        name: 'get_my_schedule',
        description: 'Get my daily activities/schedule and current status relative to now',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_get_persona',
        name: 'get_persona',
        description: 'Get current persona/relationship profile',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_get_my_mood',
        name: 'get_my_mood',
        description: 'Get current daily mood (label, color, valence, energy, speech hint)',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_set_reminder',
        name: 'set_reminder',
        description:
          'Set a one-shot timed reminder (INGATKAN). Use when user says ingatkan/remind/nanti ingetin. This is NOT long-term memory — fires once then leaves context.',
        category: 'productivity',
        functionCode: 'async function execute(params) { return params; }',
        parameters: [
          {
            name: 'text',
            type: 'string',
            description: 'What to remind about (short)',
            required: true,
          },
          {
            name: 'when',
            type: 'string',
            description:
              'When: natural language relative or absolute, e.g. "15 menit lagi", "1 jam lagi", "jam 20:00", "besok jam 8"',
            required: true,
          },
          {
            name: 'source_text',
            type: 'string',
            description: 'Original user message (optional, helps parsing)',
            required: false,
          },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_list_reminders',
        name: 'list_reminders',
        description: 'List active (or all) timed reminders for the user',
        category: 'productivity',
        functionCode: 'async function execute() { return {}; }',
        parameters: [
          {
            name: 'status',
            type: 'string',
            description: 'active|pending|sent|cancelled|all (default active)',
            required: false,
          },
          { name: 'limit', type: 'number', description: 'Max items', required: false },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_cancel_reminder',
        name: 'cancel_reminder',
        description: 'Cancel a pending reminder by id, or cancel all pending',
        category: 'productivity',
        functionCode: 'async function execute(params) { return params; }',
        parameters: [
          {
            name: 'reminder_id',
            type: 'string',
            description: 'Reminder id from list_reminders (or "all")',
            required: false,
          },
          {
            name: 'all',
            type: 'boolean',
            description: 'If true, cancel all pending reminders',
            required: false,
          },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_remember_fact',
        name: 'remember_fact',
        description:
          'Store an important LONG-TERM memory about the user. Do NOT use for timed reminders ("ingatkan saya"); use set_reminder instead.',
        category: 'system',
        functionCode: 'async function execute({ content }) { return { content }; }',
        parameters: [
          { name: 'content', type: 'string', description: 'Memory content', required: true },
          { name: 'importance', type: 'number', description: '0-1 importance', required: false },
          { name: 'category', type: 'string', description: 'preference|fact|event|relationship|task|goal', required: false },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_create_custom_tool',
        name: 'create_custom_tool',
        description:
          'Create and auto-enable a new custom tool when current tools cannot fulfill a user request. function_code must define async function execute(params){...}',
        category: 'system',
        functionCode: 'async function execute(params) { return params; }',
        parameters: [
          { name: 'name', type: 'string', description: 'snake_case tool name', required: true },
          { name: 'description', type: 'string', description: 'What the tool does', required: true },
          {
            name: 'function_code',
            type: 'string',
            description: 'JS code containing async function execute(params) { ... }',
            required: true,
          },
          {
            name: 'parameters_json',
            type: 'string',
            description: 'JSON array of parameter defs: [{name,type,description,required}]',
            required: false,
          },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_list_tools',
        name: 'list_tools',
        description: 'List all available tools',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_list_bots',
        name: 'list_bots',
        description:
          'List manual automation BOTS (heavy background jobs, not sync tools). Use when user wants a long-running automation matching a bot description.',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [
          {
            name: 'include_disabled',
            type: 'boolean',
            description: 'Include disabled bots',
            required: false,
          },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_run_bot',
        name: 'run_bot',
        description:
          'Start a heavy automation bot in BACKGROUND. For web info requests use bot_name=google_search even if user only says natural phrases like "cariin ...". If required parameters are missing, ask user then re-call. Immediately ack in persona ("nanti aku infoin lagi"); result arrives later via WhatsApp. NOT for lightweight tools.',
        category: 'productivity',
        functionCode: 'async function execute(params) { return params; }',
        parameters: [
          {
            name: 'bot_name',
            type: 'string',
            description: 'Bot name from list_bots (snake_case). Search → google_search',
            required: true,
          },
          {
            name: 'parameters_json',
            type: 'string',
            description: 'JSON object of bot parameters',
            required: false,
          },
          {
            name: 'trigger_text',
            type: 'string',
            description: 'Original user request snippet',
            required: false,
          },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_list_bot_runs',
        name: 'list_bot_runs',
        description: 'List recent automation bot runs (queued/running/done)',
        category: 'system',
        functionCode: 'async function execute() { return {}; }',
        parameters: [
          {
            name: 'status',
            type: 'string',
            description: 'active|queued|running|succeeded|failed|all',
            required: false,
          },
          { name: 'limit', type: 'number', description: 'Max items', required: false },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
    ];

    for (const tool of builtins) {
      const existing = await this.db.tools.findOne({ name: tool.name });
      const doc: Tool = {
        ...tool,
        createdAt: existing?.createdAt || new Date(),
        updatedAt: new Date(),
      };
      await this.db.tools.updateOne({ name: tool.name }, { $set: doc }, { upsert: true });
    }
  }

  private parseArgs(argsStr: string): Record<string, unknown> {
    try {
      return JSON.parse(argsStr || '{}');
    } catch {
      return {};
    }
  }

  private validateParameters(tool: Tool, parameters: Record<string, unknown>) {
    for (const param of tool.parameters) {
      if (param.required && !(param.name in parameters)) {
        throw new Error(`Missing required parameter: ${param.name}`);
      }
    }
  }

  private async logExecution(
    tool: Tool,
    parameters: Record<string, unknown>,
    result: unknown,
    success: boolean,
    error?: string
  ) {
    const execution: ToolExecution = {
      toolId: tool.id,
      toolName: tool.name,
      parameters,
      result,
      success,
      error,
      timestamp: new Date(),
    };
    await this.db.toolExecutions.insertOne(execution as any);
  }
}
