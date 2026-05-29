// tools/web_search.ts — 三引擎并行搜索（Bing + Google + 百度），结果合并去重
export const definition = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "搜索网页。Bing、Google、百度三引擎并行搜索，结果合并去重。每任务最多 4 轮搜索",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "搜索关键词" },
        count: { type: "number", description: "结果数量（默认 5，最大 10）" },
      },
      required: ["query"],
    },
  },
};

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  success: boolean;
  results?: SearchResultItem[];
  query?: string;
  engines?: string[];
  error?: string;
}

function makeHeaders(): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
}

function htmlEntityDecode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#183;/g, "·")
    .replace(/&ensp;/g, " ");
}

// ── 域名规范化（用于去重） ──
function normalizeUrl(u: string): string {
  try {
    const p = new URL(u);
    return p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "");
  } catch {
    return u;
  }
}

// ── Bing（cn.bing.com） ──
async function searchBing(query: string, count: number): Promise<SearchResultItem[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-cn`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);

  try {
    const resp = await fetch(url, { headers: makeHeaders(), signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) return [];

    const html = await resp.text();
    const results: SearchResultItem[] = [];
    const blocks = html.split("b_algo");

    for (let i = 1; i < Math.min(blocks.length, count + 1); i++) {
      const h2m = blocks[i].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = h2m ? htmlEntityDecode(h2m[1].replace(/<[^>]+>/g, "").trim()).slice(0, 100) : "";
      if (!title) continue;

      const urlM = [...blocks[i].matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"/gi)]
        .map(m => m[1])
        .find(h => !h.includes("bing.com") && !h.includes("microsoft.com/bing"));
      const link = urlM || `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;

      const pm = blocks[i].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = pm
        ? htmlEntityDecode(pm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).slice(0, 300)
        : "";

      results.push({ title, url: link, snippet: snippet || title });
    }
    return results;
  } catch {
    clearTimeout(tid);
    return [];
  }
}

// ── Google ──
async function searchGoogle(query: string, count: number): Promise<SearchResultItem[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-CN`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);

  try {
    const resp = await fetch(url, { headers: makeHeaders(), signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) return [];

    const html = await resp.text();
    const results: SearchResultItem[] = [];

    const blocks = html.split(/<div[^>]*class="[^"]*g[^"]*"[^>]*>/i);
    if (blocks.length > 1) blocks.shift();

    for (let i = 0; i < Math.min(blocks.length, count); i++) {
      const tm = blocks[i].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const title = tm ? htmlEntityDecode(tm[1].replace(/<[^>]+>/g, "").trim()).slice(0, 100) : "";
      if (!title) continue;

      const um = blocks[i].match(/<a[^>]*href="(\/url\?q=|)(https?:\/\/[^"&]*)/i);
      const link = um?.[2] || `https://www.google.com/search?q=${encodeURIComponent(query)}`;

      const sm = blocks[i].match(/<div[^>]*class="[^"]*(?:VwiC3b|BNeawe|s3v9rd)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        || blocks[i].match(/<span[^>]*class="[^"]*(?:aCOpRe|st)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const snippet = sm ? htmlEntityDecode(sm[1].replace(/<[^>]+>/g, "").trim()).slice(0, 300) : "";

      results.push({ title, url: link, snippet: snippet || title });
    }
    return results;
  } catch {
    clearTimeout(tid);
    return [];
  }
}

// ── 百度 ──
async function searchBaidu(query: string, count: number): Promise<SearchResultItem[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);

  try {
    const resp = await fetch(url, { headers: makeHeaders(), signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) return [];

    const html = await resp.text();
    const results: SearchResultItem[] = [];

    const blocks = html.split(/class="(?:result\s+)?c-container"/);
    if (blocks.length > 1) blocks.shift();

    for (let i = 0; i < Math.min(blocks.length, count); i++) {
      const tm = blocks[i].match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
        || blocks[i].match(/<a[^>]*class="[^"]*t[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const title = tm ? htmlEntityDecode(tm[1].replace(/<[^>]+>/g, "").trim()).slice(0, 100) : "";
      if (!title || title.length < 2) continue;

      const um = blocks[i].match(/<a[^>]*href="(https?:\/\/[^"&]*)/i);
      const link = um?.[1] || `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;

      const sm = blocks[i].match(/<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        || blocks[i].match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        || blocks[i].match(/<span[^>]*class="[^"]*c-color[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const snippet = sm ? htmlEntityDecode(sm[1].replace(/<[^>]+>/g, "").trim()).slice(0, 300) : "";

      results.push({ title, url: link, snippet: snippet || title });
    }
    return results;
  } catch {
    clearTimeout(tid);
    return [];
  }
}

// ── 主入口：三引擎并行 + 合并去重 ──
export async function execute(args: Record<string, unknown>): Promise<SearchResult> {
  const query = args["query"] as string;
  const count = Math.min((args["count"] as number) || 5, 10);

  if (!query) return { success: false, error: "缺少参数: query" };

  // 三引擎同时发起
  const [bingRes, googleRes, baiduRes] = await Promise.allSettled([
    searchBing(query, count),
    searchGoogle(query, count),
    searchBaidu(query, count),
  ]);

  const allResults: SearchResultItem[] = [];
  const usedEngines: string[] = [];

  const addResults = (engine: string, results: SearchResultItem[]) => {
    if (results.length > 0) {
      usedEngines.push(engine);
      allResults.push(...results);
    }
  };

  if (bingRes.status === "fulfilled") addResults("bing", bingRes.value);
  if (googleRes.status === "fulfilled") addResults("google", googleRes.value);
  if (baiduRes.status === "fulfilled") addResults("baidu", baiduRes.value);

  // URL 去重（保留首次出现）
  const seen = new Set<string>();
  const deduped: SearchResultItem[] = [];
  for (const r of allResults) {
    const key = normalizeUrl(r.url);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }

  const final = deduped.slice(0, count * 3); // 三引擎合并后上限扩大

  if (final.length > 0) {
    return { success: true, results: final, query, engines: usedEngines };
  }

  return {
    success: false,
    error: "Bing / Google / 百度 均未获取到结果",
    query,
  };
}
