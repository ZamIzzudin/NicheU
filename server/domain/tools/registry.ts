import { Tool, ToolExecution, ToolParameter } from '../../../shared/types';
import { ToolDefinition, ToolResult } from '../../core/types';
import { Database } from '../../db/mongo';
import { runToolCode, assertSafeCode } from './sandbox';
import { duckDuckGoSearch } from '../../integrations/search/duckduckgo';
import { randomId } from '../../utils/time';

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
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private runtime = new Map<string, (args: Record<string, unknown>, ctx?: ExecContext) => Promise<unknown>>();
  private context: ExecContext = {};

  constructor(private db: Database) {}

  setContext(ctx: ExecContext) {
    this.context = { ...this.context, ...ctx };
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
      web_search: async (args) => {
        const query = String(args.query || '');
        const limit = Number(args.limit || 5);
        const results = await duckDuckGoSearch(query, limit);
        return { success: true, query, count: results.length, results };
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
        id: 'builtin_web_search',
        name: 'web_search',
        description: 'Search the web via DuckDuckGo for fresh information',
        category: 'information',
        functionCode: 'async function execute({ query }) { return { query }; }',
        parameters: [
          { name: 'query', type: 'string', description: 'Search query', required: true },
          { name: 'limit', type: 'number', description: 'Max results (default 5)', required: false },
        ],
        enabled: true,
        builtin: true,
        source: 'builtin',
      },
      {
        id: 'builtin_get_my_schedule',
        name: 'get_my_schedule',
        description: 'Get my daily activities/schedule and current status',
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
        id: 'builtin_remember_fact',
        name: 'remember_fact',
        description: 'Store an important long-term memory about the user',
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
