// llm.ts — LLM 客户端：OpenAI SDK + tools + reasoning_content
import OpenAI from "openai";
import type { ProviderConfig } from "./config.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export type LLMChunk =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; delta: { id?: string; function?: { name?: string; arguments?: string } } }
  | { type: "done"; finish_reason: string };

export interface LLMFinalResult {
  type: "text" | "tool_calls";
  content?: string;
  toolCalls?: ToolCall[];
  reasoning_content?: string;
}

// 内部累积 tool call 数据结构
interface ToolCallAccumulator {
  id: string;
  index: number;
  functionName: string;
  functionArgs: string;
}

function toOpenAIMessages(
  messages: Message[]
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role };

    if (m.role === "assistant") {
      if (m.content !== null) base.content = m.content;
      if (m.tool_calls) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      // BUG-MVP-002: 传回 reasoning_content
      if (m.reasoning_content) {
        (base as Record<string, unknown>).reasoning_content = m.reasoning_content;
      }
    } else {
      if (m.content !== null) base.content = m.content;
    }

    if (m.role === "tool") {
      base.tool_call_id = m.tool_call_id;
    }

    if (m.name) base.name = m.name;

    return base;
  });
}

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(providerConfig: ProviderConfig, model: string) {
    this.model = model;
    this.client = new OpenAI({
      baseURL: providerConfig.baseURL,
      apiKey: providerConfig.apiKey || "sk-placeholder",
      timeout: (providerConfig.timeout || 60) * 1000,
    });
  }

  async *chat(
    messages: Message[],
    signal?: AbortSignal,
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[] // BUG-MVP-001: tools 参数
  ): AsyncGenerator<LLMChunk> {
    const openaiMessages = toOpenAIMessages(messages);

    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      stream: true,
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

    const response = await this.client.chat.completions.create(requestParams);

    const toolCallAcc = new Map<number, ToolCallAccumulator>();

    for await (const chunk of response) {
      if (signal?.aborted) break;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown>;

      // reasoning_content 捕获：双重 fallback
      const rc = (delta.reasoning_content ?? (choice as Record<string, unknown>).reasoning_content) as string | undefined;
      if (typeof rc === "string" && rc) {
        yield { type: "reasoning_delta", delta: rc };
      }

      // 文本内容
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text_delta", delta: delta.content };
      }

      // 工具调用 delta
      if (delta.tool_calls) {
        const toolCalls = delta.tool_calls as Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
        for (const tc of toolCalls) {
          const idx = tc.index ?? 0;
          if (!toolCallAcc.has(idx)) {
            toolCallAcc.set(idx, {
              id: tc.id ?? "",
              index: idx,
              functionName: tc.function?.name ?? "",
              functionArgs: tc.function?.arguments ?? "",
            });
          } else {
            const acc = toolCallAcc.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.functionName += tc.function.name;
            if (tc.function?.arguments) acc.functionArgs += tc.function.arguments;
          }
          yield {
            type: "tool_call_delta",
            index: idx,
            delta: {
              id: tc.id,
              function: tc.function ? { name: tc.function.name, arguments: tc.function.arguments } : undefined,
            },
          };
        }
      }

      // 完成
      if (choice.finish_reason) {
        yield { type: "done", finish_reason: choice.finish_reason };
        return;
      }
    }

    // 如果流结束但没有 done chunk（异常情况）
    yield { type: "done", finish_reason: "stop" };
  }

  parseAccumulatedToolCalls(toolCallAcc: Map<number, ToolCallAccumulator>): ToolCall[] {
    const result: ToolCall[] = [];
    const sorted = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, acc] of sorted) {
      result.push({
        id: acc.id,
        type: "function",
        function: {
          name: acc.functionName,
          arguments: acc.functionArgs,
        },
      });
    }
    return result;
  }
}
