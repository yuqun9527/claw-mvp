// tools/exec.ts — Shell 命令执行（跨平台 + 编码修复 + 安全）
import { exec } from "node:child_process";
import { platform } from "node:os";
import { resolve, isAbsolute, relative } from "node:path";
import type { ClawConfig } from "../config.ts";

let _config: ClawConfig | null = null;

export function setConfig(c: ClawConfig): void {
  _config = c;
}

function getWorkspace(): string {
  if (_config) return _config.workspace;
  return process.cwd();
}

export const definition = {
  type: "function" as const,
  function: {
    name: "exec",
    description: "执行 Shell 命令。Windows 使用 PowerShell，其他平台使用 bash",
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout: { type: "number", description: "超时秒数（默认 30，最大 300）" },
      },
      required: ["command"],
    },
  },
};

export interface ExecResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

// 危险命令黑名单（平台感知）
function getBlacklist(): RegExp[] {
  const common: RegExp[] = [
    /^rm\s+-rf\s+\/\s*$/,
    /^rm\s+-rf\s+\/\*$/,
    /^chmod\s+-[rR]\s+777\s+\//,
    /^mkfs\.[a-z0-9]+\s+/,
    /^dd\s+if=/,
  ];

  if (platform() === "win32") {
    return [
      ...common,
      /^del\s+\/f(\s+\/s)?/,
      /^format\s+/,
      /^diskpart(\s+|$)/,
      /^reg\s+delete\s+/,
      /^taskkill\s+\/f\s+/,
      /^shutdown\s+/,
      /^sudo\s+/,                 // BUG-MVP-010: Windows 11 sudo
      /-(EncodedCommand|Enc|ec)\s+/i,       // SEC-002: PowerShell 编码命令
      /^iex\s+/i,                // SEC-003: Invoke-Expression
      /^iwr\s+/i,                // SEC-003: Invoke-WebRequest
      /^irm\s+/i,                // SEC-003: Invoke-RestMethod
      /Invoke-(Expression|WebRequest|RestMethod)/i,
      /Get-ChildItem\s+env:/i,   // SEC-006: 环境变量泄露
      /gci\s+env:/i,
      /ls\s+env:/i,
      /dir\s+env:/i,
      /^schtasks\s+/i,           // SEC-009: 计划任务
      /^netsh\s+/i,              // SEC-009: 网络配置
      /^net\s+(user|localgroup|share)\s+/i,  // SEC-011
      /^icacls\s+/i,             // 权限修改
      /^cacls\s+/i,
      /^takeown\s+/i,
      /^reg\s+add\s+/i,
      /^attrib\s+/i,
    ];
  }

  return [
    ...common,
    /^sudo\s+/,
    /^shutdown/,
    /^reboot/,
    /^init\s+[06]/,
    /curl\s+.*\|\s*(ba)?sh/i,    // SEC-003: 下载执行链
    /wget\s+.*\|\s*(ba)?sh/i,
  ];
}

function isDangerous(command: string): boolean {
  const lower = command.toLowerCase().trim();
  const blacklist = getBlacklist();
  for (const pattern of blacklist) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

// SEC-010: 文件操作沙箱检测
function checkFileOperationSandbox(command: string): string | null {
  const workspace = getWorkspace();
  const lower = command.toLowerCase().trim();

  // PowerShell: Copy-Item/Move-Item -Destination
  const psDestination = /-(?:Destination|FilePath|Path)\s+([^\s;|&]+)/i;
  let match = psDestination.exec(command);
  if (match) {
    const target = expandEnvVars(match[1]);
    if (isOutsideWorkspace(target, workspace)) {
      return `文件操作目标在工作区外: ${target}`;
    }
  }

  // CMD: copy/move/xcopy/robocopy
  const cmdCopy = /(?:copy|move|xcopy|robocopy)\s+.+\s+([^\s;|&]+)$/im;
  match = cmdCopy.exec(lower);
  if (match) {
    const target = expandEnvVars(match[1]);
    if (isOutsideWorkspace(target, workspace)) {
      return `文件操作目标在工作区外: ${target}`;
    }
  }

  // 重定向 > >>
  const redirect = /[>]{1,2}\s*([^\s;|&]+)/;
  match = redirect.exec(command);
  if (match) {
    const target = expandEnvVars(match[1]);
    if (isOutsideWorkspace(target, workspace)) {
      return `重定向目标在工作区外: ${target}`;
    }
  }

  return null;
}

function expandEnvVars(path: string): string {
  let expanded = path;
  // 展开 $env:VAR 或 $VAR
  expanded = expanded.replace(/\$env:(\w+)/gi, (_, name) => process.env[name] || "");
  expanded = expanded.replace(/\$(\w+)/g, (_, name) => process.env[name] || "");
  // 展开 %VAR%
  expanded = expanded.replace(/%(\w+)%/g, (_, name) => process.env[name] || "");
  // 展开 ~
  expanded = expanded.replace(/^~\//, process.env.HOME || "");
  return expanded;
}

function isOutsideWorkspace(targetPath: string, workspace: string): boolean {
  try {
    const resolved = resolve(targetPath);
    const rel = relative(workspace, resolved);
    return rel.startsWith("..") || isAbsolute(rel);
  } catch {
    return true;
  }
}

function getShell(): string {
  return platform() === "win32" ? "powershell.exe" : "/bin/bash";
}

// BUG-MVP-005/007: Buffer 解码（UTF-8 优先，失败回退 GBK）
function decodeBuffer(buf: Buffer): string {
  if (buf.length === 0) return "";
  const utf8 = buf.toString("utf-8");
  // 如果 UTF-8 解码不含替换字符，说明是合法 UTF-8
  if (!utf8.includes("\ufffd")) return utf8;
  // 尝试 GBK
  try {
    const td = new TextDecoder("gbk", { fatal: false });
    return td.decode(buf);
  } catch {
    return utf8;
  }
}

export async function execute(args: Record<string, unknown>): Promise<ExecResult> {
  const command = args["command"] as string;
  let timeout = (args["timeout"] as number) || 30;
  timeout = Math.min(Math.max(timeout, 1), 300);

  if (!command) return { success: false, error: "缺少参数: command" };

  // 安全检查
  if (isDangerous(command)) {
    return { success: false, error: "危险命令已被拦截（安全策略）" };
  }

  const sandboxError = checkFileOperationSandbox(command);
  if (sandboxError) {
    return { success: false, error: `文件操作沙箱拦截: ${sandboxError}` };
  }

  return new Promise((resolve_) => {
    const child = exec(
      command,
      {
        shell: getShell(),
        timeout: timeout * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "buffer" as BufferEncoding,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          LANG: "en_US.UTF-8",
        },
      },
      (error, stdout, stderr) => {
        const decodedStdout = decodeBuffer(stdout);
        const decodedStderr = decodeBuffer(stderr);

        if (error) {
          resolve_({
            success: false,
            stdout: decodedStdout.slice(0, 5000),
            stderr: decodedStderr.slice(0, 5000),
            exitCode: (error as NodeJS.ErrnoException).code ? 1 : 0,
            error: decodedStderr || error.message,
          });
          return;
        }

        resolve_({
          success: true,
          stdout: decodedStdout.slice(0, 5000),
          stderr: decodedStderr.slice(0, 5000),
          exitCode: 0,
        });
      }
    );
  });
}
