// tools/python.ts — Python 脚本执行（auto-pip + 安全检查）
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
    name: "python",
    description: "执行 Python 脚本。自动安装依赖（openpyxl/python-docx/python-pptx/pdfplumber/PyPDF2）",
    parameters: {
      type: "object" as const,
      properties: {
        script: { type: "string", description: "Python 脚本代码" },
        timeout: { type: "number", description: "超时秒数（默认 60，最大 300）" },
        packages: { type: "string", description: "额外的 pip 包名（空格分隔），如 'pandas matplotlib'" },
      },
      required: ["script"],
    },
  },
};

export interface PythonResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

// BUG-MVP-011: pip 包名 → Python import 模块名映射表
const PACKAGE_TO_MODULE: Record<string, string> = {
  "python-docx": "docx",
  "python-pptx": "pptx",
  "PyPDF2": "PyPDF2",
  "openpyxl": "openpyxl",
  "pdfplumber": "pdfplumber",
};

const AUTO_PACKAGES = Object.keys(PACKAGE_TO_MODULE);

function buildBootstrap(packages: string[]): string {
  const allPackages = [...new Set([...AUTO_PACKAGES, ...packages])];
  const pkgList = JSON.stringify(allPackages);
  const mapping = JSON.stringify(PACKAGE_TO_MODULE);

  return `
import subprocess, sys, importlib, json
_auto_packages = ${pkgList}
_pkg_to_mod = ${mapping}
for _pkg in _auto_packages:
    _mod_name = _pkg_to_mod.get(_pkg, _pkg.replace("-", "_"))
    try:
        importlib.import_module(_mod_name)
    except ImportError:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", _pkg, "-q", "-q"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
# ---- end bootstrap ----
`;
}

// SEC-042: Python 代码安全检查
const DANGEROUS_IMPORTS = [
  "os.system", "os.popen", "os.execv", "os.execl",
  "subprocess", "socket", "ctypes",
  "eval", "exec(",
  "compile", "__import__",
  "requests", "urllib", "http.client",
  "shutil.rmtree", "shutil.move",
  "os.remove(", "os.rmdir", "os.unlink",
];

function checkScriptSecurity(script: string): string | null {
  // 检查动态导入
  if (script.includes("__import__('os')") || script.includes('__import__("os")')) {
    return "禁止动态导入 os 模块";
  }

  for (const pattern of DANGEROUS_IMPORTS) {
    if (script.includes(pattern)) {
      return `禁止使用: ${pattern}`;
    }
  }

  return null;
}

export async function execute(args: Record<string, unknown>): Promise<PythonResult> {
  const script = args["script"] as string;
  let timeout = (args["timeout"] as number) || 60;
  timeout = Math.min(Math.max(timeout, 1), 300);
  const extraPackages = ((args["packages"] as string) || "").split(/\s+/).filter(Boolean);

  if (!script) return { success: false, error: "缺少参数: script" };

  // 安全检查
  const securityError = checkScriptSecurity(script);
  if (securityError) {
    return { success: false, error: `安全检查拦截: ${securityError}` };
  }

  const workspace = getWorkspace();
  if (!existsSync(workspace)) {
    mkdirSync(workspace, { recursive: true });
  }

  const bootstrap = buildBootstrap(extraPackages);
  const fullScript = bootstrap + "\n" + script;
  const scriptId = randomUUID();
  const scriptPath = join(workspace, `.claw-python-${scriptId}.py`);

  try {
    writeFileSync(scriptPath, fullScript, "utf-8");

    return new Promise((resolve_) => {
      const child = exec(
        `python "${scriptPath}"`,
        {
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024,
          encoding: "buffer" as BufferEncoding,
          env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
        },
        (error, stdout, stderr) => {
          // 清理临时文件
          try { unlinkSync(scriptPath); } catch { /* ignore */ }

          const outStr = decodeBuffer(stdout);
          const errStr = decodeBuffer(stderr);

          if (error) {
            resolve_({
              success: false,
              stdout: outStr.slice(0, 5000),
              stderr: errStr.slice(0, 5000),
              error: errStr || error.message,
            });
            return;
          }

          resolve_({
            success: true,
            stdout: outStr.slice(0, 5000),
            stderr: errStr.slice(0, 5000),
          });
        }
      );
    });
  } catch (e) {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
    return { success: false, error: (e as Error).message };
  }
}

function decodeBuffer(buf: Buffer): string {
  if (buf.length === 0) return "";
  const utf8 = buf.toString("utf-8");
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    const td = new TextDecoder("gbk", { fatal: false });
    return td.decode(buf);
  } catch {
    return utf8;
  }
}
