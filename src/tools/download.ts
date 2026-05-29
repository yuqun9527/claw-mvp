// tools/download.ts — 文件下载工具（支持 PDF、图片等任意文件类型）
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pipeline } from "node:stream/promises";
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
    name: "download",
    description: "下载文件到工作区。支持 PDF、图片、文档等任意文件类型。仅 HTTP/HTTPS，SSRF 已防护",
    parameters: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "文件下载 URL（HTTP/HTTPS）" },
        filename: { type: "string", description: "保存的文件名（可选，默认从 URL 或 Content-Disposition 提取）" },
      },
      required: ["url"],
    },
  },
};

export interface DownloadResult {
  success: boolean;
  path?: string;
  filename?: string;
  size?: number;
  contentType?: string;
  error?: string;
}

// SSRF 防护：内网 IP 前缀黑名单
const BLOCKED_PREFIXES = [
  "0.", "10.", "100.", "127.",
  "169.254.",
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.", "198.18.", "198.19.",
];

function isBlockedHost(hostname: string): boolean {
  if (hostname.startsWith("[::ffff:") && hostname.endsWith("]")) {
    return isBlockedHost(hostname.slice(8, -1));
  }
  if (/^\d+$/.test(hostname)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(hostname)) return true;
  for (const prefix of BLOCKED_PREFIXES) {
    if (hostname.startsWith(prefix)) return true;
  }
  return false;
}

function extractFilename(url: string, contentDisposition: string | null): string {
  // Content-Disposition 优先
  if (contentDisposition) {
    const fnMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|"?)([^";\s]+)/i);
    if (fnMatch) return decodeURIComponent(fnMatch[1].replace(/"/g, ""));
  }

  // URL 路径提取
  try {
    const pathname = new URL(url).pathname;
    const name = basename(pathname);
    if (name && name.length > 1) return name;
  } catch { /* ignore */ }

  // 回退
  return `download_${Date.now()}`;
}

function ensureUnique(filepath: string): string {
  if (!existsSync(filepath)) return filepath;

  const extIdx = filepath.lastIndexOf(".");
  const base = extIdx > 0 ? filepath.slice(0, extIdx) : filepath;
  const ext = extIdx > 0 ? filepath.slice(extIdx) : "";

  let counter = 1;
  let candidate: string;
  do {
    candidate = `${base}_(${counter})${ext}`;
    counter++;
  } while (existsSync(candidate));

  return candidate;
}

export async function execute(args: Record<string, unknown>): Promise<DownloadResult> {
  const url = args["url"] as string;
  const filenameHint = args["filename"] as string | undefined;

  if (!url) return { success: false, error: "缺少参数: url" };

  // 协议检查
  if (url.startsWith("file://")) {
    return { success: false, error: "file:// 协议被拒绝" };
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { success: false, error: "仅支持 HTTP/HTTPS 协议" };
  }

  // URL 解析 + SSRF
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { success: false, error: `无效的 URL: ${url}` };
  }
  if (isBlockedHost(hostname)) {
    return { success: false, error: `内网地址被拦截: ${hostname}` };
  }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60000); // 下载超时 60s

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(tid);

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const contentDisposition = resp.headers.get("content-disposition");

    // 确定文件名
    const filename = filenameHint || extractFilename(url, contentDisposition);
    const workspace = getWorkspace();
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

    const savePath = ensureUnique(resolve(workspace, filename));

    // 流式写入
    if (!resp.body) {
      // 无 body（极端情况），直接读 buffer
      const buf = Buffer.from(await resp.arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      writeFileSync(savePath, buf);
      return {
        success: true,
        path: savePath,
        filename: basename(savePath),
        size: buf.length,
        contentType,
      };
    }

    // 创建写入流（Node.js ReadableStream → WritableStream 需要适配）
    const { statSync } = await import("node:fs");
    const dest = createWriteStream(savePath);

    // Node.js fetch 返回的 body 是 ReadableStream<Uint8Array>，需要用 Readable.fromWeb 转
    const { Readable } = await import("node:stream");
    const nodeStream = Readable.fromWeb(resp.body as any);
    await pipeline(nodeStream, dest);

    const stats = statSync(savePath);
    return {
      success: true,
      path: savePath,
      filename: basename(savePath),
      size: stats.size,
      contentType,
    };
  } catch (e) {
    clearTimeout(tid);
    return { success: false, error: `下载失败: ${(e as Error).message}` };
  }
}
