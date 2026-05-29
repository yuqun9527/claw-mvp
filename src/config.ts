// config.ts — 配置加载：多级优先级 + 占位符替换
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  timeout?: number;
}

export interface ClawConfig {
  model: string;
  providers: Record<string, ProviderConfig>;
  workspace: string;
  maxHistoryTurns: number;
  maxIterations: number;
  maxSearchRounds: number;
  systemPrompt: string;
  proxy?: string;
}

const DEFAULT_CONFIG: ClawConfig = {
  model: "deepseek/deepseek-v4-flash",
  providers: {
    deepseek: {
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "",
      timeout: 60,
    },
  },
  workspace: resolve(process.cwd(), "workspace"),
  maxHistoryTurns: 50,
  maxIterations: 30,
  maxSearchRounds: 4,
  systemPrompt: "You are claw, a CLI + Web AI assistant with tools: read, write, edit, exec, web_search, web_fetch, python.",
  proxy: "http://127.0.0.1:7890",
};

function getClawDir(): string {
  const dir = join(homedir(), ".claw");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigPath(): string {
  return join(getClawDir(), "config.json");
}

function loadUserConfig(): Partial<ClawConfig> | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as Partial<ClawConfig>;
  } catch {
    return null;
  }
}

function loadSystemPrompt(): string {
  // 优先级: config.json systemPrompt > system-prompt.md > 内置回退
  const userConfig = loadUserConfig();
  if (userConfig?.systemPrompt) return userConfig.systemPrompt;

  const spPath = join(PROJECT_ROOT, "system-prompt.md");
  if (existsSync(spPath)) {
    return readFileSync(spPath, "utf-8").trim();
  }

  return DEFAULT_CONFIG.systemPrompt;
}

function replacePlaceholders(template: string, config: ClawConfig): string {
  return template
    .replace(/\{workspace\}/g, config.workspace)
    .replace(/\{platform\}/g, platform())
    .replace(/\{shell\}/g, platform() === "win32" ? "PowerShell" : "bash");
}

export function loadConfig(): ClawConfig {
  const default_ = { ...DEFAULT_CONFIG };
  const userConfig = loadUserConfig();

  // workspace 需要先合并才能 resolve
  let workspace = userConfig?.workspace ?? default_.workspace;
  if (!resolve(workspace).startsWith("/") && !/^[A-Za-z]:/.test(workspace)) {
    workspace = resolve(process.cwd(), workspace);
  }

  const config: ClawConfig = {
    model: userConfig?.model ?? default_.model,
    providers: { ...default_.providers, ...(userConfig?.providers ?? {}) },
    workspace,
    maxHistoryTurns: userConfig?.maxHistoryTurns ?? default_.maxHistoryTurns,
    maxIterations: userConfig?.maxIterations ?? default_.maxIterations,
    maxSearchRounds: userConfig?.maxSearchRounds ?? default_.maxSearchRounds,
    systemPrompt: default_.systemPrompt,
    proxy: userConfig?.proxy ?? default_.proxy,
  };

  // 环境变量覆盖
  if (process.env.CLAW_MODEL) config.model = process.env.CLAW_MODEL;
  if (process.env.CLAW_WORKSPACE) config.workspace = resolve(process.env.CLAW_WORKSPACE);
  if (process.env.DEEPSEEK_API_KEY && config.providers.deepseek) {
    config.providers.deepseek.apiKey = process.env.DEEPSEEK_API_KEY;
  }

  // 设置代理环境变量（Node.js fetch 通过 HTTPS_PROXY/HTTP_PROXY 走代理）
  const proxy = config.proxy || userConfig?.proxy;
  if (proxy) {
    process.env.HTTPS_PROXY = proxy;
    process.env.HTTP_PROXY = proxy;
  }

  // 确保 workspace 存在
  if (!existsSync(config.workspace)) {
    mkdirSync(config.workspace, { recursive: true });
  }

  // 加载带占位符替换的 system prompt
  config.systemPrompt = replacePlaceholders(loadSystemPrompt(), config);

  return config;
}

export function getClawDirPath(): string {
  return getClawDir();
}
