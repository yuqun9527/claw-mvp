// index.ts — CLI 入口：REPL + 10 斜杠命令 + Ctrl+C + 管道输入 + ASCII Banner
import * as readline from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Agent } from "./agent.ts";
import { saveSession, loadSession, listSessions, deleteSession } from "./session.ts";
import type { Message } from "./llm.ts";

// BUG-MVP-016: ASCII Banner
const BANNER = `
==========================================
  claw-mvp v0.2.0 -- CLI AI Agent
  Type /help for commands, /exit to quit
==========================================
`;

const HELP_TEXT = `
Commands:
  /file <path>    - 读取文件内容注入上下文
  /model <name>   - 切换模型
  /clear          - 清屏并清空消息历史
  /history        - 打印消息历史摘要
  /save [name]    - 保存当前会话
  /load <name>    - 加载历史会话
  /list           - 列出所有已保存会话
  /delete <name>  - 删除指定会话
  /exit           - 退出程序
  /help           - 显示此帮助
`;

async function main(): Promise<void> {
  const config = loadConfig();

  // 确保 workspace 存在
  if (!existsSync(config.workspace)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(config.workspace, { recursive: true });
  }

  console.log(BANNER);
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Model: ${config.model}`);
  console.log();

  const agent = new Agent(config);
  let ctrlCCount = 0;

  // Ctrl+C 处理
  process.on("SIGINT", () => {
    if (agent.generating) {
      agent.abortRequested = true;
      process.stderr.write("\n⏹ 中断生成...\n");
      ctrlCCount = 0;
    } else {
      ctrlCCount++;
      if (ctrlCCount >= 2) {
        console.log("\n再见！");
        process.exit(0);
      }
      console.log('\n按 Ctrl+C 再次退出，或继续输入');
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "claw> ",
    completer: (line: string) => {
      const commands = [
        "/file", "/model", "/clear", "/history",
        "/save", "/load", "/list", "/delete",
        "/exit", "/help",
      ];
      const hits = commands.filter((c) => c.startsWith(line));
      return [hits.length ? hits : commands, line];
    },
  });

  // BUG-MVP-015: 管道输入处理标志
  let processing = false;

  // 管道输入处理
  rl.on("line", async (line: string) => {
    ctrlCCount = 0;
    const input = line.trim();

    if (!input || input.startsWith("#")) {
      rl.prompt();
      return;
    }

    // 斜杠命令路由
    if (input.startsWith("/")) {
      await handleSlashCommand(input, agent, rl);
      return;
    }

    // 自然语言消息
    processing = true;
    try {
      await agent.run(input);
      console.log();
    } catch (e) {
      console.error("\n[ERROR]", (e as Error).message);
    } finally {
      processing = false;
    }
    rl.prompt();
  });

  // BUG-MVP-015: close 事件检查 processing 标志
  rl.on("close", () => {
    if (processing) {
      // 管道输入，等待 Agent 完成
      const maxWait = 60000; // 最长等 60s
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (!processing || Date.now() - startTime > maxWait) {
          clearInterval(checkInterval);
          process.exit(0);
        }
      }, 100);
    } else {
      process.exit(0);
    }
  });

  rl.prompt();
}

async function handleSlashCommand(
  input: string,
  agent: Agent,
  rl: readline.Interface
): Promise<void> {
  const parts = input.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const arg = parts.slice(1).join(" ");

  switch (command) {
    case "/file": {
      if (!arg) {
        console.log("用法: /file <path>");
        break;
      }
      try {
        const filePath = resolve(process.cwd(), arg);
        if (!existsSync(filePath)) {
          console.log(`文件不存在: ${filePath}`);
        } else {
          const content = readFileSync(filePath, "utf-8").slice(0, 5000);
          await agent.run(`[用户通过 /file 注入了文件: ${arg}]\n\n内容:\n${content}`);
          console.log();
        }
      } catch (e) {
        console.log(`读取失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/model": {
      if (!arg) {
        console.log(`当前模型: ${(agent as any).config.model}`);
        break;
      }
      try {
        agent.switchModel(arg);
        console.log(`模型已切换: ${arg}`);
      } catch (e) {
        console.log(`切换失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/clear": {
      agent.clearMessages();
      console.clear();
      console.log(BANNER);
      console.log("上下文已清空");
      break;
    }

    case "/history": {
      const messages = agent.getMessages();
      if (messages.length === 0) {
        console.log("(无历史消息)");
      } else {
        for (const msg of messages) {
          const content = typeof msg.content === "string" ? msg.content.slice(0, 80) : "[tool_calls]";
          console.log(`  [${msg.role}] ${content}`);
        }
        console.log(`共 ${messages.length} 条消息`);
      }
      break;
    }

    case "/save": {
      try {
        const messages = agent.getMessages().filter(m => m.role !== "system");
        const id = await saveSession(arg || undefined, (agent as any).config.model, messages);
        console.log(`会话已保存: ${id}`);
      } catch (e) {
        console.log(`保存失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/load": {
      if (!arg) {
        console.log("用法: /load <name>");
        break;
      }
      try {
        const data = await loadSession(arg);
        if (!data) {
          console.log(`会话不存在: ${arg}`);
        } else {
          agent.setMessages(data.messages);
          if (data.model) agent.switchModel(data.model);
          console.log(`已加载: ${data.name} (${data.messages.length} 条消息)`);
        }
      } catch (e) {
        console.log(`加载失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/list": {
      try {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          console.log("(无已保存会话)");
        } else {
          for (const s of sessions) {
            console.log(`  ${s.name} (${s.messageCount} 条消息, ${s.updatedAt.slice(0, 16)})`);
          }
        }
      } catch (e) {
        console.log(`列表获取失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/delete": {
      if (!arg) {
        console.log("用法: /delete <name>");
        break;
      }
      try {
        const ok = await deleteSession(arg);
        console.log(ok ? `已删除: ${arg}` : `会话不存在: ${arg}`);
      } catch (e) {
        console.log(`删除失败: ${(e as Error).message}`);
      }
      break;
    }

    case "/exit": {
      console.log("再见！");
      process.exit(0);
    }

    case "/help": {
      console.log(HELP_TEXT);
      break;
    }

    default: {
      console.log(`未知命令: ${command}。输入 /help 查看帮助`);
    }
  }

  rl.prompt();
}

main().catch((e) => {
  console.error("启动失败:", e.message);
  process.exit(1);
});
