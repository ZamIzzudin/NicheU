import { Message } from './types';
import { Client } from './client';
import { ToolRegistry } from '../domain/tools/registry';

const MAX_ITERATIONS = 12;

export async function runAgentTurn(
  client: Client,
  tools: ToolRegistry,
  history: Message[],
  onToken: (token: string) => void,
  context?: { userId?: string }
): Promise<string> {
  const toolDefs = tools.definitions();
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const result = await client.chatStream(history, toolDefs, (token) => {
      finalText += token;
      onToken(token);
    });

    if (result.toolCalls.length === 0) {
      if (result.content) {
        history.push({ role: 'assistant', content: result.content });
        finalText = result.content;
      }
      return finalText.trim();
    }

    // Reset streaming accumulation for this tool-using turn
    finalText = result.content || '';

    history.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.toolCalls,
    });

    const batch = result.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      argumentsStr: tc.function.arguments,
    }));

    for (const { name, argumentsStr } of batch) {
      const displayArgs =
        argumentsStr.length > 180 ? argumentsStr.slice(0, 177) + '...' : argumentsStr;
      console.log(`  [tool] ${name}(${displayArgs})`);
    }

    const results = await tools.executeBatch(batch, context);

    for (const { id, output } of results) {
      const preview = output.length > 400 ? output.slice(0, 397) + '...' : output;
      console.log(`  [result] ${preview}`);
      history.push({ role: 'tool', content: output, tool_call_id: id });
    }

    // After tools, wait for final natural language response in next iteration
    finalText = '';
  }

  console.warn(`[agent] Reached max iterations (${MAX_ITERATIONS})`);
  return finalText.trim() || 'Aku masih proses, coba ulangi sebentar ya.';
}
