// server.ts — Web 入口：HTTP + SSE + REST API + 多会话 + 静态文件
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { Agent, type AgentCallbacks } from "./agent.ts";
import { saveSession as saveToDisk, loadSession, listSessions, deleteSession as deleteFromDisk } from "./session.ts";
import type { ClawConfig } from "./config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

interface SessionAgent {
  agent: Agent;
  config: ClawConfig;
  createdAt: number;
}

const sessions = new Map<string, SessionAgent>();

function getOrCreateSession(sessionId: string): SessionAgent {
  if (!sessions.has(sessionId)) {
    const config = loadConfig();
    const agent = new Agent(config);
    sessions.set(sessionId, { agent, config, createdAt: Date.now() });
  }
  return sessions.get(sessionId)!;
}

// SSE 辅助
function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 客户端断开，静默忽略
  }
}

// 读取请求体
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve_) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve_(body));
  });
}

// 静态文件 MIME 映射
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res: ServerResponse, urlPath: string): void {
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  const filePath = join(PUBLIC_DIR, urlPath);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("404 Not Found");
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
}

// 端口解析
function resolvePort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      return parseInt(args[i + 1], 10);
    }
  }
  for (const arg of args) {
    if (/^\d+$/.test(arg)) return parseInt(arg, 10);
  }
  return parseInt(process.env.CLAW_PORT || "3456", 10);
}

// ── 路由处理 ──
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${resolvePort()}`);
  const path = url.pathname;

  // API 路由
  if (path === "/api/chat" && req.method === "POST") {
    await handleChat(req, res);
    return;
  }

  if (path === "/api/sessions" && req.method === "GET") {
    await handleListSessions(res);
    return;
  }

  if (path === "/api/sessions" && req.method === "POST") {
    await handleCreateSession(res);
    return;
  }

  if (path === "/api/sessions/load" && req.method === "POST") {
    await handleLoadSession(req, res);
    return;
  }

  if (path === "/api/sessions/persisted" && req.method === "GET") {
    await handleListPersistedSessions(res);
    return;
  }

  if (path.startsWith("/api/sessions/") && path.endsWith("/save") && req.method === "POST") {
    const sid = path.split("/")[3];
    await handleSaveSession(sid, req, res);
    return;
  }

  if (path.startsWith("/api/sessions/") && req.method === "DELETE") {
    await handleDeleteSession(path, res);
    return;
  }

  if (path === "/api/config" && req.method === "GET") {
    handleConfig(res);
    return;
  }

  if (path === "/api/models" && req.method === "GET") {
    handleModels(res);
    return;
  }

  if (path === "/api/models" && req.method === "POST") {
    await handleSetModel(req, res);
    return;
  }

  if (path === "/api/model" && req.method === "POST") {
    await handleSwitchModel(req, res);
    return;
  }

  // 静态文件
  serveStatic(res, path);
}

// ── API 处理器 ──

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { message?: string; sessionId?: string; model?: string };
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const message = parsed.message?.trim();
  if (!message) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Missing message" }));
    return;
  }

  const sid = parsed.sessionId || "default";
  sseInit(res);

  const sa = getOrCreateSession(sid);
  sseSend(res, "session", { sessionId: sid, model: sa.config.model, workspace: sa.config.workspace });

  // 切换到指定模型
  if (parsed.model && parsed.model !== sa.config.model) {
    try {
      sa.agent.switchModel(parsed.model);
      sa.config.model = parsed.model;
    } catch { /* ignore */ }
  }

  // 并发保护
  if (sa.agent.generating) {
    sa.agent.abortRequested = true;
    await new Promise((r) => setTimeout(r, 300));
  }

  // 注入 Web 回调
  const webCallbacks: AgentCallbacks = {
    onStream(text: string) { sseSend(res, "text", { content: text }); },
    onToolCall(name: string, args: Record<string, unknown>) { sseSend(res, "tool_call", { name, args }); },
    onToolResult(name: string, result: unknown) { sseSend(res, "tool_result", { name, result }); },
    onError(msg: string) { sseSend(res, "error", { message: msg }); },
  };
  (sa.agent as any).callbacks = webCallbacks;

  try {
    await sa.agent.run(message);
  } catch (e) {
    sseSend(res, "error", { message: (e as Error).message });
  }

  sseSend(res, "done", { sessionId: sid });
  if (!res.writableEnded) res.end();
}

async function handleListSessions(res: ServerResponse): Promise<void> {
  const persistedSessions = await listSessions();
  const activeSessions = Array.from(sessions.entries()).map(([id, sa]) => ({
    id,
    name: id === "default" ? "Default" : `会话-${id.slice(0, 8)}`,
    messageCount: sa.agent.getMessages().length,
    updatedAt: new Date(sa.createdAt).toISOString(),
    persisted: false,
  }));

  // 合并：标记已持久化的活跃会话
  const persistedIds = new Set(persistedSessions.map(s => s.id));
  for (const s of activeSessions) {
    if (persistedIds.has(s.id)) s.persisted = true;
  }

  const allSessions = [
    ...persistedSessions.filter(s => !sessions.has(s.id)).map(s => ({
      ...s, persisted: true,
    })),
    ...activeSessions,
  ];

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions: allSessions }));
}

async function handleCreateSession(res: ServerResponse): Promise<void> {
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const config = loadConfig();
  const agent = new Agent(config);
  sessions.set(id, { agent, config, createdAt: Date.now() });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessionId: id }));
}

async function handleLoadSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let name: string;
  try { name = JSON.parse(body).name; } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Missing name" }));
    return;
  }

  const data = await loadSession(name);
  if (!data) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  const id = data.id;
  const config = loadConfig();
  if (data.model) config.model = data.model;
  const agent = new Agent(config);
  agent.setMessages(data.messages);
  sessions.set(id, { agent, config, createdAt: Date.now() });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    sessionId: id,
    name: data.name,
    messageCount: data.messages.length,
    model: data.model,
  }));
}

async function handleListPersistedSessions(res: ServerResponse): Promise<void> {
  const s = await listSessions();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions: s }));
}

async function handleSaveSession(sid: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let name: string | undefined;
  let model: string | undefined;
  try {
    const body = JSON.parse(await readBody(req));
    name = body.name;
    model = body.model;
  } catch { /* ignore */ }

  const sa = sessions.get(sid);
  const messages = sa ? sa.agent.getMessages().filter(m => m.role !== "system") : undefined;

  try {
    const id = await saveToDisk(name || sid, model, messages);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: id, name }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

async function handleDeleteSession(path: string, res: ServerResponse): Promise<void> {
  const sid = path.split("/")[3] || "";
  sessions.delete(sid);
  await deleteFromDisk(sid);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ deleted: true }));
}

function handleConfig(res: ServerResponse): void {
  const config = loadConfig();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model: config.model,
    workspace: config.workspace,
    maxHistoryTurns: config.maxHistoryTurns,
    maxIterations: config.maxIterations,
    maxSearchRounds: config.maxSearchRounds,
  }));
}

function handleModels(res: ServerResponse): void {
  const config = loadConfig();
  const models: { id: string; name: string }[] = [];
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    if (provider === "deepseek") {
      models.push(
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
        { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner" },
      );
    } else {
      models.push({ id: `${provider}/default`, name: `${provider}/default` });
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ models }));
}

async function handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let model: string;
  try { model = JSON.parse(body).model; } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Missing model" }));
    return;
  }
  // Just validate and echo back
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model }));
}

async function handleSwitchModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let model: string;
  let sessionId: string;
  try {
    const parsed = JSON.parse(body);
    model = parsed.model;
    sessionId = parsed.sessionId || "default";
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const sa = getOrCreateSession(sessionId);
  sa.agent.switchModel(model);
  sa.config.model = model;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model }));
}

// ── 启动 ──
const port = resolvePort();
const server = createServer(handleRequest);

server.listen(port, () => {
  // BUG-MVP-016: ASCII Banner
  console.log("\n==========================================");
  console.log("  claw-mvp v0.2.0 -- Web Server");
  console.log(`  Listening on http://localhost:${port}`);
  console.log("==========================================\n");
});
