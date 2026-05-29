// tools/index.ts — 工具注册中心
import type { ClawConfig } from "../config.ts";
import * as readTool from "./read.ts";
import * as writeTool from "./write.ts";
import * as editTool from "./edit.ts";
import * as execTool from "./exec.ts";
import * as webSearchTool from "./web_search.ts";
import * as webFetchTool from "./web_fetch.ts";
import * as pythonTool from "./python.ts";
import * as downloadTool from "./download.ts";

export type ToolExecuteFn = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface RegisteredTool {
  definition: { type: "function"; function: Record<string, unknown> };
  execute: ToolExecuteFn;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private config: ClawConfig;

  constructor(config: ClawConfig) {
    this.config = config;

    // BUG-MVP-013: 注册时调用 setConfig 传递 workspace 配置
    this.register(readTool);
    this.register(writeTool);
    this.register(editTool);
    this.register(execTool);
    this.register(webSearchTool);
    this.register(webFetchTool);
    this.register(pythonTool);
    this.register(downloadTool);
  }

  private register(module: {
    definition: { type: "function"; function: { name: string } & Record<string, unknown> };
    execute: ToolExecuteFn;
    setConfig?: (c: ClawConfig) => void;
  }): void {
    // BUG-MVP-013: 注入配置到工具模块
    module.setConfig?.(this.config);
    const name = module.definition.function.name;
    this.tools.set(name, {
      definition: module.definition,
      execute: module.execute,
    });
  }

  getDefinitions(): Array<{ type: "function"; function: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `未知工具: ${name}` };
    }
    try {
      return await tool.execute(args);
    } catch (e) {
      return { success: false, error: `工具执行异常: ${(e as Error).message}` };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
