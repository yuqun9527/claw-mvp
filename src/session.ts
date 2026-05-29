// session.ts — 会话持久化：CRUD + 向后兼容
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getClawDirPath } from "./config.ts";
import type { Message } from "./llm.ts";

export interface SessionData {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: Message[];
}

interface SessionIndex {
  nameToId: Record<string, string>;
  ids: string[];
}

interface LegacyIndex {
  [name: string]: string;
}

function getSessionsDir(): string {
  const dir = join(getClawDirPath(), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getIndexPath(): string {
  return join(getSessionsDir(), "index.json");
}

function loadIndex(): SessionIndex {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) {
    return { nameToId: {}, ids: [] };
  }
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    // BUG-MVP-009: 向后兼容旧扁平格式 {name: id}
    if (parsed.nameToId && typeof parsed.nameToId === "object" && !Array.isArray(parsed.nameToId)) {
      return {
        nameToId: parsed.nameToId as Record<string, string>,
        ids: (parsed.ids as string[]) ?? Object.values(parsed.nameToId),
      };
    }
    // 旧扁平格式转换
    const nameToId: Record<string, string> = {};
    const ids: string[] = [];
    for (const [key, value] of Object.entries(parsed as LegacyIndex)) {
      if (typeof value === "string") {
        nameToId[key] = value;
        ids.push(value);
      }
    }
    return { nameToId, ids };
  } catch {
    return { nameToId: {}, ids: [] };
  }
}

function saveIndex(index: SessionIndex): void {
  writeFileSync(getIndexPath(), JSON.stringify(index, null, 2), "utf-8");
}

export async function saveSession(
  name?: string,
  model?: string,
  messages?: Message[]
): Promise<string> {
  const index = loadIndex();
  const sessionName = name || `session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  let id = index.nameToId[sessionName] || randomUUID();

  const now = new Date().toISOString();
  const existing: Partial<SessionData> = {};
  if (existsSync(join(getSessionsDir(), `${id}.json`))) {
    try {
      const raw = readFileSync(join(getSessionsDir(), `${id}.json`), "utf-8");
      Object.assign(existing, JSON.parse(raw));
    } catch { /* ignore */ }
  }

  const data: SessionData = {
    id,
    name: sessionName,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    model: model || existing.model || "deepseek/deepseek-v4-flash",
    messages: messages ?? existing.messages ?? [],
  };

  writeFileSync(join(getSessionsDir(), `${id}.json`), JSON.stringify(data, null, 2), "utf-8");

  index.nameToId[sessionName] = id;
  if (!index.ids.includes(id)) index.ids.push(id);
  saveIndex(index);

  return id;
}

export async function loadSession(idOrName: string): Promise<SessionData | null> {
  const index = loadIndex();
  const id = index.nameToId[idOrName] || idOrName;
  const filePath = join(getSessionsDir(), `${id}.json`);

  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<{ name: string; id: string; messageCount: number; updatedAt: string }[]> {
  const index = loadIndex();
  const result: { name: string; id: string; messageCount: number; updatedAt: string }[] = [];

  for (const id of index.ids) {
    const filePath = join(getSessionsDir(), `${id}.json`);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as SessionData;
      result.push({
        name: data.name,
        id: data.id,
        messageCount: data.messages?.length ?? 0,
        updatedAt: data.updatedAt,
      });
    } catch { /* skip corrupt file */ }
  }

  result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

export async function deleteSession(idOrName: string): Promise<boolean> {
  const index = loadIndex();
  const id = index.nameToId[idOrName] || idOrName;
  const filePath = join(getSessionsDir(), `${id}.json`);

  if (!existsSync(filePath)) return false;

  try {
    unlinkSync(filePath);
    // 清理索引
    if (index.nameToId[idOrName]) delete index.nameToId[idOrName];
    index.ids = index.ids.filter(i => i !== id);
    saveIndex(index);
    return true;
  } catch {
    return false;
  }
}
