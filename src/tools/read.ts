// tools/read.ts — 文件读取（含 Office/PDF 提取）
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, isAbsolute, extname, relative } from "node:path";
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
    name: "read",
    description: "读取文件内容。支持纯文本和 Office/PDF 格式（自动提取文本）",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "文件路径（相对工作区）" },
        offset: { type: "number", description: "起始行号（可选）" },
        limit: { type: "number", description: "最大行数（可选）" },
      },
      required: ["path"],
    },
  },
};

const OFFICE_FORMATS: Record<string, string> = {
  xlsx: "xlsx", xlsm: "xlsx",
  docx: "docx", pptx: "pptx", pdf: "pdf",
};

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".html", ".xml", ".yaml", ".yml", ".log",
  ".py", ".ts", ".js", ".tsx", ".jsx", ".css", ".scss", ".sh", ".bat",
  ".cfg", ".ini", ".env", ".gitignore", ".toml", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".rb", ".php", ".sql",
]);

function isOfficeFile(ext: string): boolean {
  return ext in OFFICE_FORMATS;
}

function isTextFile(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export interface ReadResult {
  success: boolean;
  content?: string;
  lines?: number;
  path?: string;
  error?: string;
}

function ensureInWorkspace(filePath: string, workspace: string): string {
  // BUG-MVP-004: 去除 workspace/ 前缀
  let cleanPath = filePath.replace(/^(\.?[\\/])?workspace[\\/]/, "");

  // SEC-019: UNC 路径优先拦截
  if (cleanPath.startsWith("\\\\") || cleanPath.startsWith("//")) {
    throw new Error(`UNC 路径被拒绝: ${cleanPath}`);
  }

  // 转为绝对路径
  const resolved = resolve(workspace, cleanPath);

  // 跨盘符检测 (Windows)
  if (workspace[0] !== undefined && resolved[0] !== undefined) {
    const wsDrive = workspace[0].toUpperCase();
    const resDrive = resolved[0].toUpperCase();
    if (wsDrive !== resDrive) {
      throw new Error(`跨盘符路径被拒绝: ${cleanPath}`);
    }
  }

  // 路径遍历检测
  try {
    const rel = relative(workspace, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`路径遍历被拒绝: ${cleanPath}`);
    }
  } catch {
    throw new Error(`无效路径: ${cleanPath}`);
  }

  // 绝对路径检查
  if (isAbsolute(cleanPath.replace(/^[A-Za-z]:[\\/]/, ""))
    && !resolved.startsWith(workspace)) {
    throw new Error(`绝对路径被拒绝: ${cleanPath}`);
  }

  return resolved;
}

export async function execute(args: Record<string, unknown>): Promise<ReadResult> {
  const filePath = args["path"] as string;
  if (!filePath) return { success: false, error: "缺少参数: path" };

  const workspace = getWorkspace();

  try {
    const resolvedPath = ensureInWorkspace(filePath, workspace);
    const ext = extname(resolvedPath).toLowerCase().slice(1);

    if (isOfficeFile(ext)) {
      return await readOfficeFile(resolvedPath, ext);
    }

    return readTextFile(resolvedPath, args);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

function readTextFile(resolvedPath: string, args: Record<string, unknown>): ReadResult {
  if (!existsSync(resolvedPath)) {
    return { success: false, error: `文件不存在: ${resolvedPath}` };
  }

  const stat = statSync(resolvedPath);
  if (stat.size > 1024 * 1024) {
    return { success: false, error: `文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB（限制 1MB）` };
  }

  const content = readFileSync(resolvedPath, "utf-8");
  const allLines = content.split("\n");
  const offset = (args["offset"] as number) ? (args["offset"] as number) - 1 : 0;
  const limit = args["limit"] as number | undefined;

  const lines = limit
    ? allLines.slice(offset, offset + limit)
    : allLines.slice(offset);

  return {
    success: true,
    content: lines.join("\n"),
    lines: lines.length,
    path: resolvedPath,
  };
}

async function readOfficeFile(resolvedPath: string, format: string): Promise<ReadResult> {
  // 通过 Python 子进程提取 Office 文件文本
  const { execSync } = await import("node:child_process");
  try {
    let script: string;
    switch (format) {
      case "xlsx":
        script = `
import sys
try:
    import openpyxl
except ImportError:
    import subprocess; subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import openpyxl
wb = openpyxl.load_workbook(r"${resolvedPath}", data_only=True)
for sn in wb.sheetnames:
    ws = wb[sn]
    print(f"[Sheet: {sn}]")
    for row in ws.iter_rows(values_only=True):
        print("\\t".join(str(c) if c is not None else "" for c in row))
`;
        break;
      case "docx":
        script = `
import sys
try:
    import docx as mod
except ImportError:
    import subprocess; subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import docx as mod
doc = mod.Document(r"${resolvedPath}")
for p in doc.paragraphs:
    if p.text.strip(): print(p.text)
for t in doc.tables:
    for row in t.rows:
        print("\\t".join(c.text for c in row.cells))
`;
        break;
      case "pptx":
        script = `
import sys
try:
    import pptx as mod
except ImportError:
    import subprocess; subprocess.check_call([sys.executable, "-m", "pip", "install", "python-pptx", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import pptx as mod
prs = mod.Presentation(r"${resolvedPath}")
for i, slide in enumerate(prs.slides, 1):
    print(f"[Slide {i}]")
    for shape in slide.shapes:
        if shape.has_text_frame:
            for pa in shape.text_frame.paragraphs:
                t = pa.text.strip()
                if t: print(t)
`;
        break;
      case "pdf":
        script = `
import sys
try:
    import pdfplumber
    with pdfplumber.open(r"${resolvedPath}") as pdf:
        for i, page in enumerate(pdf.pages, 1):
            t = page.extract_text()
            if t:
                print(f"[Page {i}]")
                print(t)
except ImportError:
    import subprocess; subprocess.check_call([sys.executable, "-m", "pip", "install", "pdfplumber", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import pdfplumber
    with pdfplumber.open(r"${resolvedPath}") as pdf:
        for i, page in enumerate(pdf.pages, 1):
            t = page.extract_text()
            if t:
                print(f"[Page {i}]")
                print(t)
except Exception as e1:
    try:
        import PyPDF2
        with open(r"${resolvedPath}", "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for i, page in enumerate(reader.pages, 1):
                t = page.extract_text()
                if t:
                    print(f"[Page {i}]")
                    print(t)
    except ImportError:
        import subprocess; subprocess.check_call([sys.executable, "-m", "pip", "install", "PyPDF2", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import PyPDF2
        with open(r"${resolvedPath}", "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for i, page in enumerate(reader.pages, 1):
                t = page.extract_text()
                if (t):
                    print(f"[Page {i}]")
                    print(t)
`;
        break;
      default:
        return { success: false, error: `不支持的格式: ${format}` };
    }

    const result = execSync(`python -c "${script.replace(/"/g, '\\"')}"`, {
      encoding: "buffer",
      timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    const text = decodeBuffer(result);
    const lines = text.split("\n").filter(l => l.trim());

    return { success: true, content: text, lines: lines.length, path: resolvedPath };
  } catch (e) {
    return { success: false, error: `Office/PDF 读取失败: ${(e as Error).message}` };
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
