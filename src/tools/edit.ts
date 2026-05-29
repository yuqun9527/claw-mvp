// tools/edit.ts — 精确文本编辑
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, extname, relative, dirname } from "node:path";
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
    name: "edit",
    description: "精确替换文件中的文本。oldText 必须在文件中出现恰好一次",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "文件路径（相对工作区）" },
        oldText: { type: "string", description: "要替换的原文本（必须唯一匹配）" },
        newText: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
};

export interface EditResult {
  success: boolean;
  path?: string;
  action?: string;
  error?: string;
}

function ensureInWorkspace(filePath: string, workspace: string): string {
  let cleanPath = filePath.replace(/^(\.?[\\/])?workspace[\\/]/, "");

  if (cleanPath.startsWith("\\\\") || cleanPath.startsWith("//")) {
    throw new Error(`UNC 路径被拒绝: ${cleanPath}`);
  }

  const resolved = resolve(workspace, cleanPath);

  if (workspace[0] !== undefined && resolved[0] !== undefined) {
    if (workspace[0].toUpperCase() !== resolved[0].toUpperCase()) {
      throw new Error(`跨盘符路径被拒绝: ${cleanPath}`);
    }
  }

  try {
    const rel = relative(workspace, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`路径遍历被拒绝: ${cleanPath}`);
    }
  } catch {
    throw new Error(`无效路径: ${cleanPath}`);
  }

  return resolved;
}

export async function execute(args: Record<string, unknown>): Promise<EditResult> {
  const filePath = args["path"] as string;
  const oldText = args["oldText"] as string;
  const newText = args["newText"] as string;

  if (!filePath) return { success: false, error: "缺少参数: path" };
  if (oldText === undefined || oldText === null) return { success: false, error: "缺少参数: oldText" };
  if (newText === undefined || newText === null) return { success: false, error: "缺少参数: newText" };

  const workspace = getWorkspace();

  try {
    const resolvedPath = ensureInWorkspace(filePath, workspace);

    if (!existsSync(resolvedPath)) {
      return { success: false, error: `文件不存在: ${resolvedPath}` };
    }

    // 仅支持纯文本编辑
    const ext = extname(resolvedPath).toLowerCase();
    if (ext === ".xlsx" || ext === ".docx" || ext === ".pptx" || ext === ".pdf") {
      return { success: false, error: `edit 不支持 ${ext} 格式，请使用 write 重新创建` };
    }

    const original = readFileSync(resolvedPath, "utf-8");

    // 查找 oldText 出现次数
    let count = 0;
    let pos = original.indexOf(oldText);
    while (pos !== -1) {
      count++;
      pos = original.indexOf(oldText, pos + 1);
    }

    if (count === 0) {
      return { success: false, error: "未找到匹配的文本（oldText 不存在于文件中）" };
    }

    if (count > 1) {
      return { success: false, error: `匹配到 ${count} 处，请提供更具体的文本以确保唯一匹配` };
    }

    const edited = original.replace(oldText, newText);

    if (Buffer.byteLength(edited, "utf-8") > 5 * 1024 * 1024) {
      return { success: false, error: "编辑后文件超过 5MB 限制" };
    }

    writeFileSync(resolvedPath, edited, "utf-8");

    return { success: true, path: resolvedPath, action: "edited" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
