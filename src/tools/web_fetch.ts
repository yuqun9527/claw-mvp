// tools/web_fetch.ts — 网页抓取（SSRF 防护）
export const definition = {
  type: "function" as const,
  function: {
    name: "web_fetch",
    description: "抓取网页内容，提取纯文本。仅支持 HTTP/HTTPS。SSRF 已防护",
    parameters: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "网页 URL（HTTP/HTTPS）" },
        maxChars: { type: "number", description: "最大返回字符数（默认 5000）" },
      },
      required: ["url"],
    },
  },
};

export interface FetchResult {
  success: boolean;
  content?: string;
  title?: string;
  url?: string;
  error?: string;
}

// 内网/IP 前缀拦截
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
  // IPv6 mapped IPv4
  if (hostname.startsWith("[::ffff:") && hostname.endsWith("]")) {
    const inner = hostname.slice(8, -1);
    return isBlockedHost(inner);
  }

  // 纯数字 hostname（十进制/十六进制 IP）
  if (/^\d+$/.test(hostname)) {
    return true;
  }
  if (/^0x[0-9a-fA-F]+$/.test(hostname)) {
    return true;
  }

  for (const prefix of BLOCKED_PREFIXES) {
    if (hostname.startsWith(prefix)) return true;
  }

  return false;
}

function stripHtml(html: string): { title: string; text: string } {
  let title = "";
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) title = titleMatch[1].trim();

  // 移除 script/style
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text };
}

export async function execute(args: Record<string, unknown>): Promise<FetchResult> {
  const url = args["url"] as string;
  const maxChars = (args["maxChars"] as number) || 5000;

  if (!url) return { success: false, error: "缺少参数: url" };

  // file:// 协议拒绝
  if (url.startsWith("file://")) {
    return { success: false, error: "file:// 协议被拒绝" };
  }

  // 仅允许 HTTP/HTTPS
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { success: false, error: "仅支持 HTTP/HTTPS 协议" };
  }

  // URL 解析
  let hostname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
  } catch {
    return { success: false, error: `无效的 URL: ${url}` };
  }

  // SSRF 防护
  if (isBlockedHost(hostname)) {
    return { success: false, error: `内网地址被拦截: ${hostname}` };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { success: false, error: `不支持的 Content-Type: ${contentType}` };
    }

    const html = await response.text();
    const { title, text } = stripHtml(html);

    return {
      success: true,
      content: text.slice(0, maxChars),
      title: title || undefined,
      url,
    };
  } catch (e) {
    return { success: false, error: `抓取失败: ${(e as Error).message}` };
  }
}
