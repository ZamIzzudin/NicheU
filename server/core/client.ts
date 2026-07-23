import axios, { AxiosInstance } from 'axios';
import {
  ChatRequest,
  StreamChunk,
  ApiError,
  StreamResult,
  ToolCall,
  ToolCallFunction,
  Message,
  ActiveModel,
  ToolDefinition,
} from './types';
import { env } from '../config/env';

export class Client {
  private http: AxiosInstance;
  private activeModel: ActiveModel;

  constructor(activeModel: ActiveModel) {
    this.activeModel = activeModel;
    this.http = axios.create({
      timeout: 300000,
      validateStatus: () => true,
    });
  }

  setActiveModel(model: ActiveModel) {
    this.activeModel = model;
  }

  getActiveModel(): ActiveModel {
    return this.activeModel;
  }

  async chat(
    messages: Message[],
    options: {
      tools?: ToolDefinition[];
      temperature?: number;
      responseFormat?: { type: string };
      stream?: boolean;
    } = {}
  ): Promise<{ content: string; toolCalls: ToolCall[]; raw?: unknown }> {
    if (options.stream) {
      const result = await this.chatStream(messages, options.tools || [], () => {});
      return { content: result.content, toolCalls: result.toolCalls };
    }

    const baseUrl = this.activeModel.base_url || env.apiBaseUrl;
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: ChatRequest = {
      model: this.activeModel.name,
      messages,
      tools: options.tools,
      stream: false,
      temperature: options.temperature ?? 0.7,
      response_format: options.responseFormat,
    };

    try {
      const response = await this.http.post(url, body, {
        headers: {
          Authorization: `Bearer ${this.activeModel.api_key}`,
          'Content-Type': 'application/json',
        },
        responseType: 'json',
      });

      if (response.status >= 400) {
        throw new ApiError('status', response.status, JSON.stringify(response.data));
      }

      const choice = response.data?.choices?.[0];
      const message = choice?.message || {};
      return {
        content: message.content || '',
        toolCalls: message.tool_calls || [],
        raw: response.data,
      };
    } catch (error: any) {
      if (error instanceof ApiError) throw error;
      if (axios.isAxiosError(error)) {
        throw new ApiError('request', error.response?.status, error.message);
      }
      throw new ApiError('request', undefined, error.message);
    }
  }

  async chatStream(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void
  ): Promise<StreamResult> {
    const baseUrl = this.activeModel.base_url || env.apiBaseUrl;
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const request: ChatRequest = {
      model: this.activeModel.name,
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      // slightly higher for more natural chat variance (persona style)
      temperature: 0.95,
    };

    try {
      const response = await axios.post(url, request, {
        headers: {
          Authorization: `Bearer ${this.activeModel.api_key}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 300000,
        validateStatus: () => true,
      });

      if (response.status >= 400) {
        const body = await this.getStreamText(response.data);
        throw new ApiError('status', response.status, body);
      }

      return await this.processStream(response.data, onToken);
    } catch (error: any) {
      if (error instanceof ApiError) throw error;
      if (axios.isAxiosError(error)) {
        throw new ApiError('request', error.response?.status, error.message);
      }
      throw new ApiError('request', undefined, error.message);
    }
  }

  async embed(text: string): Promise<number[]> {
    const url = `${env.apiBaseUrl}/embeddings`;
    try {
      const response = await this.http.post(
        url,
        { model: env.embeddingModel, input: text },
        {
          headers: {
            Authorization: `Bearer ${env.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'json',
        }
      );

      if (response.status >= 400) {
        throw new ApiError('status', response.status, JSON.stringify(response.data));
      }

      const embedding = response.data?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new ApiError('parse', undefined, 'Invalid embedding response');
      }
      return embedding;
    } catch (error: any) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('request', undefined, error.message);
    }
  }

  private async processStream(stream: any, onToken: (token: string) => void): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      let finishReason: string | undefined;
      const toolAccumulator = new Map<number, { id?: string; name?: string; args: string }>();
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed: StreamChunk = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.delta?.content) {
              onToken(choice.delta.content);
              fullContent += choice.delta.content;
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;

            for (const tc of choice?.delta?.tool_calls || []) {
              const entry = toolAccumulator.get(tc.index) || { args: '' };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              toolAccumulator.set(tc.index, entry);
            }
          } catch {
            // ignore partial JSON
          }
        }
      });

      stream.on('end', () => {
        const toolCalls: ToolCall[] = Array.from(toolAccumulator.values())
          .filter((entry) => entry.id && entry.name)
          .map((entry) => ({
            id: entry.id!,
            type: 'function',
            function: {
              name: entry.name!,
              arguments: entry.args,
            } as ToolCallFunction,
          }));

        resolve({ content: fullContent, toolCalls, finishReason });
      });

      stream.on('error', (error: Error) => {
        reject(new ApiError('request', undefined, error.message));
      });
    });
  }

  private async getStreamText(stream: any): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      stream.on('data', (chunk: Buffer) => (data += chunk));
      stream.on('end', () => resolve(data));
      stream.on('error', () => resolve(data));
    });
  }
}
