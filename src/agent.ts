// agent.ts — Agent 主循环：consumeStream + 反空话 + 搜索限制
import { LLMClient, type Message, type LLMChunk, type LLMFinalResult, type ToolCall } from "./llm.ts";
import { ToolRegistry } from "./tools/index.ts";
import type { ClawConfig } from "./config.ts";

export interface AgentCallbacks {
  onStream?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onError?: (msg: string) => void;
}

const SEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

// BUG-MVP-014: 反空话阈值 ≤ 30 字符，精确前缀匹配
const CHATTER_PATTERNS: RegExp[] = [
  /^(我来|我马上|我准备|let me |I will |I'll )/i,
  /^(我.{0,3}(来|马上|准备|开始))$/,
];

const CHATTER_MAX_LENGTH = 30;

interface ToolCallAccumulator {
  id: string;
  functionName: string;
  functionArgs: string;
}

export class Agent {
  private messages: Message[] = [];
  private config: ClawConfig;
  private tools: ToolRegistry;
  private llmClient: LLMClient;
  private searchRoundCount = 0;
  private chatterRetryCount = 0;
  private callbacks: AgentCallbacks;
  public abortRequested = false;
  public generating = false;

  constructor(config: ClawConfig, callbacks?: AgentCallbacks) {
    this.config = config;
    this.tools = new ToolRegistry(config);

    // 解析 provider/model
    const parts = config.model.split("/");
    const providerName = parts.length > 1 ? parts[0] : "deepseek";
    const modelName = parts.length > 1 ? parts.slice(1).join("/") : config.model;
    const providerConfig = config.providers[providerName] || config.providers["deepseek"];
    this.llmClient = new LLMClient(providerConfig, modelName);

    // BUG-MVP-012: 默认 callbacks 输出到 stdout
    this.callbacks = callbacks && Object.keys(callbacks).length > 0
      ? callbacks
      : {
          onStream: (text: string) => process.stdout.write(text),
          onToolCall: (name: string, args: Record<string, unknown>) => {
            const argStr = JSON.stringify(args).slice(0, 60);
            process.stderr.write(`\n🔧 ${name}: ${argStr}\n`);
          },
          onToolResult: (name: string, result: unknown) => {
            const resStr = JSON.stringify(result).slice(0, 120);
            process.stderr.write(`📋 ${name} result: ${resStr}\n`);
          },
          onError: (msg: string) => {
            process.stderr.write(`❌ ${msg}\n`);
          },
        };
  }

  async run(userInput: string): Promise<void> {
    this.messages.push({ role: "user", content: userInput });
    let iteration = 0;
    this.abortRequested = false;
    this.searchRoundCount = 0;
    this.chatterRetryCount = 0;

    while (iteration < this.config.maxIterations && !this.abortRequested) {
      iteration++;
      this.generating = true;

      try {
        // BUG-MVP-001/003: 传入 tools 定义
        const generator = this.llmClient.chat(
          this.buildMessages(),
          undefined,  // signal
          this.tools.getDefinitions() as any
        );

        const result = await this.consumeStream(generator);
        this.generating = false;

        if (this.abortRequested) break;

        // 文本响应 → 反空话检测
        if (result.type === "text") {
          const textContent = (result.content || "").trim();

          // BUG-MVP-014: 反空话检测
          if (textContent.length === 0 || this.looksLikeChatter(textContent)) {
            this.chatterRetryCount++;
            if (this.chatterRetryCount > 3) {
              this.messages.push({
                role: "assistant",
                content: textContent || "(no response)",
                reasoning_content: result.reasoning_content,
              });
              break;
            }
            this.messages.push({
              role: "user",
              content: "[SYSTEM] 你的上一条回复是空话。请直接简洁回应用户，1-3句话。",
            });
            continue;
          }

          this.chatterRetryCount = 0;
          this.messages.push({
            role: "assistant",
            content: textContent,
            reasoning_content: result.reasoning_content,
          });
          break;
        }

        // tool_calls → 搜索限制 + 执行
        if (result.type === "tool_calls" && result.toolCalls) {
          this.chatterRetryCount = 0;
          const toolCalls = [...result.toolCalls];

          // 检查是否有搜索工具调用
          const hasSearchTools = toolCalls.some(tc => SEARCH_TOOLS.has(tc.function.name));
          if (hasSearchTools) {
            this.searchRoundCount++;
          }

          // BUG-MVP-008/006: 先存储 assistant(tool_calls) 再存储 tool 结果
          this.messages.push({
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map(tc => ({ ...tc })),
            reasoning_content: result.reasoning_content,
          });

          // 搜索超限处理
          if (this.searchRoundCount > this.config.maxSearchRounds) {
            for (const tc of toolCalls) {
              if (SEARCH_TOOLS.has(tc.function.name)) {
                this.messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: JSON.stringify({
                    success: false,
                    error: `搜索预算已耗尽（${this.config.maxSearchRounds}轮上限），请基于已有信息综合回答`,
                  }),
                });
              } else {
                // 非搜索工具正常执行
                await this.executeToolAndStore(tc);
              }
            }
            continue;
          }

          // 正常执行所有工具
          for (const tc of toolCalls) {
            await this.executeToolAndStore(tc);
          }
        }
      } catch (e) {
        this.generating = false;
        this.callbacks.onError?.(`LLM Error: ${(e as Error).message}`);
        // 在出错时也保存 assistant 消息以避免循环
        break;
      }
    }

    if (iteration >= this.config.maxIterations) {
      console.log("\n⚠ 达到最大迭代次数");
    }
  }

  private async executeToolAndStore(tc: ToolCall): Promise<void> {
    let tcArgs: Record<string, unknown>;
    try {
      tcArgs = JSON.parse(tc.function.arguments);
    } catch {
      tcArgs = {};
    }

    this.callbacks.onToolCall?.(tc.function.name, tcArgs);

    const execResult = await this.tools.execute(tc.function.name, tcArgs);

    this.callbacks.onToolResult?.(tc.function.name, execResult);

    this.messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(execResult),
    });
  }

  private looksLikeChatter(text: string): boolean {
    // BUG-MVP-014: 阈值 ≤ 30 字符
    if (text.length > CHATTER_MAX_LENGTH) return false;

    for (const pattern of CHATTER_PATTERNS) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  private buildMessages(): Message[] {
    const systemMsg: Message = {
      role: "system",
      content: this.config.systemPrompt,
    };

    const history = [...this.messages];

    // 截断到最近 maxHistoryTurns 条消息
    if (history.length > this.config.maxHistoryTurns) {
      const truncated = history.slice(-this.config.maxHistoryTurns);

      // BUG-MVP-008: 截断保护 — 如果首条是 tool 消息，回溯到 assistant(tool_calls)
      if (truncated.length > 0 && truncated[0].role === "tool") {
        const originalIndex = history.length - this.config.maxHistoryTurns;
        let backIdx = originalIndex - 1;
        while (backIdx >= 0 && history[backIdx].role === "tool") {
          backIdx--;
        }
        if (backIdx >= 0 && history[backIdx].role === "assistant" && history[backIdx].tool_calls) {
          const newStart = backIdx;
          return [systemMsg, ...history.slice(newStart)];
        }
      }

      return [systemMsg, ...truncated];
    }

    return [systemMsg, ...history];
  }

  private async consumeStream(
    generator: AsyncGenerator<LLMChunk>
  ): Promise<LLMFinalResult> {
    let textContent = "";
    let reasoningContent = "";
    const toolCallAcc = new Map<number, ToolCallAccumulator>();

    for await (const chunk of generator) {
      if (this.abortRequested) break;

      switch (chunk.type) {
        case "reasoning_delta":
          reasoningContent += chunk.delta;
          break;
        case "text_delta":
          textContent += chunk.delta;
          this.callbacks.onStream?.(chunk.delta);
          break;
        case "tool_call_delta": {
          const idx = chunk.index;
          if (!toolCallAcc.has(idx)) {
            toolCallAcc.set(idx, {
              id: chunk.delta.id ?? "",
              functionName: chunk.delta.function?.name ?? "",
              functionArgs: chunk.delta.function?.arguments ?? "",
            });
          } else {
            const acc = toolCallAcc.get(idx)!;
            if (chunk.delta.id) acc.id = chunk.delta.id;
            if (chunk.delta.function?.name) acc.functionName += chunk.delta.function.name;
            if (chunk.delta.function?.arguments) acc.functionArgs += chunk.delta.function.arguments;
          }
          break;
        }
        case "done": {
          if (chunk.finish_reason === "tool_calls" && toolCallAcc.size > 0) {
            const toolCalls: ToolCall[] = [];
            const sorted = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
            for (const [, acc] of sorted) {
              toolCalls.push({
                id: acc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: {
                  name: acc.functionName,
                  arguments: acc.functionArgs,
                },
              });
            }
            return {
              type: "tool_calls",
              toolCalls,
              reasoning_content: reasoningContent || undefined,
            };
          }
          return {
            type: "text",
            content: textContent,
            reasoning_content: reasoningContent || undefined,
          };
        }
      }
      // BUG-MVP-006: 不能在 switch 后加 return
    }

    return {
      type: "text",
      content: textContent,
      reasoning_content: reasoningContent || undefined,
    };
  }

  // 公开方法：获取当前消息（用于持久化）
  getMessages(): Message[] {
    return [...this.messages];
  }

  // 公开方法：设置消息（用于恢复会话）
  setMessages(messages: Message[]): void {
    this.messages = messages;
  }

  // 公开方法：清空消息
  clearMessages(): void {
    this.messages = [];
    this.searchRoundCount = 0;
    this.chatterRetryCount = 0;
  }

  // 公开方法：切换模型
  switchModel(model: string): void {
    this.config.model = model;
    const parts = model.split("/");
    const providerName = parts.length > 1 ? parts[0] : "deepseek";
    const modelName = parts.length > 1 ? parts.slice(1).join("/") : model;
    const providerConfig = this.config.providers[providerName] || this.config.providers["deepseek"];
    this.llmClient = new LLMClient(providerConfig, modelName);
  }
}
