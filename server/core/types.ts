/** OpenAI-style multimodal content parts (vision). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** String for normal chat; array for vision turns. */
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: ToolCallFunction;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: StreamChoice[];
}

export interface StreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    tool_calls?: StreamToolCall[];
  };
  finish_reason?: string;
}

export interface StreamToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
  temperature?: number;
  response_format?: { type: string };
}

export class ApiError extends Error {
  constructor(
    public type: 'request' | 'status' | 'parse',
    public statusCode?: number,
    public body?: string
  ) {
    super(body || 'API Error');
    this.name = 'ApiError';
  }
}

export interface ToolResult {
  id: string;
  output: string;
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

export interface ActiveModel {
  name: string;
  base_url: string;
  api_key: string;
}
