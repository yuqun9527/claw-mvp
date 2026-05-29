// tools/write.ts — 文件写入
import { writeFileSync, existsSync, statSync, appendFileSync } from "node:fs";
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
    name: "write",
    description: "写入文件。支持纯文本和 Office 格式（自动转换）",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "文件路径（相对工作区）" },
        content: { type: "string", description: "文件内容" },
        append: { type: "boolean", description: "是否追加模式（默认 false）" },
      },
      required: ["path", "content"],
    },
  },
};

export interface WriteResult {
  success: boolean;
  path?: string;
  action?: string;
  error?: string;
}

const OFFICE_EXTENSIONS: Record<string, string> = {
  ".xlsx": "xlsx",
  ".docx": "docx",
  ".pptx": "pptx",
};

function ensureInWorkspace(filePath: string, workspace: string): string {
  // BUG-MVP-004: 去除 workspace/ 前缀
  let cleanPath = filePath.replace(/^(\.?[\\/])?workspace[\\/]/, "");

  // UNC 路径拦截
  if (cleanPath.startsWith("\\\\") || cleanPath.startsWith("//")) {
    throw new Error(`UNC 路径被拒绝: ${cleanPath}`);
  }

  const resolved = resolve(workspace, cleanPath);

  // 跨盘符检测
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

  return resolved;
}

export async function execute(args: Record<string, unknown>): Promise<WriteResult> {
  const filePath = args["path"] as string;
  const content = args["content"] as string;
  const append = args["append"] as boolean | undefined;

  if (!filePath) return { success: false, error: "缺少参数: path" };
  if (content === undefined || content === null) return { success: false, error: "缺少参数: content" };

  const workspace = getWorkspace();

  try {
    const resolvedPath = ensureInWorkspace(filePath, workspace);
    const ext = extname(resolvedPath).toLowerCase();

    // 确保父目录存在
    const parentDir = dirname(resolvedPath);
    if (!existsSync(parentDir)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(parentDir, { recursive: true });
    }

    // Office 格式写入
    if (ext in OFFICE_EXTENSIONS) {
      if (append) {
        return { success: false, error: "Office 格式不支持追加模式" };
      }
      return await writeOfficeFile(resolvedPath, ext, content);
    }

    // 纯文本写入
    const existed = existsSync(resolvedPath);

    if (append && existed) {
      appendFileSync(resolvedPath, content, "utf-8");
    } else {
      writeFileSync(resolvedPath, content, "utf-8");
    }

    return {
      success: true,
      path: resolvedPath,
      action: existed && !append ? "overwritten" : existed && append ? "appended" : "created",
    };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

async function writeOfficeFile(resolvedPath: string, ext: string, content: string): Promise<WriteResult> {
  const { execSync } = await import("node:child_process");
  const b64 = Buffer.from(content, "utf-8").toString("base64");

  let script: string;
  switch (ext) {
    case ".xlsx":
      script = `
import sys, base64, csv, io
import subprocess
try:
    import openpyxl
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import openpyxl
content = base64.b64decode("${b64}").decode("utf-8")
reader = csv.reader(io.StringIO(content), delimiter="\\t")
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sheet1"
for row in reader:
    ws.append(row)
wb.save(r"${resolvedPath}")
print("OK")
`;
      break;
    case ".docx":
      script = `
import sys, base64
import subprocess
try:
    import docx as mod
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import docx as mod
from docx.shared import Pt
content = base64.b64decode("${b64}").decode("utf-8")
doc = mod.Document()
for line in content.split("\\n"):
    if line.startswith("# "):
        doc.add_heading(line[2:], level=1)
    elif line.startswith("## "):
        doc.add_heading(line[3:], level=2)
    elif line.startswith("### "):
        doc.add_heading(line[4:], level=3)
    elif line.startswith("- "):
        doc.add_paragraph(line[2:], style="List Bullet")
    elif line.strip():
        doc.add_paragraph(line)
doc.save(r"${resolvedPath}")
print("OK")
`;
      break;
    case ".pptx":
      script = `
import sys, base64
import subprocess
try:
    import pptx as mod
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-pptx", "-q", "-q"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import pptx as mod
from pptx.util import Inches, Pt
content = base64.b64decode("${b64}").decode("utf-8")
prs = mod.Presentation()
slide_layout = prs.slide_layouts[1]  # Title and Content
slide = None
for line in content.split("\\n"):
    if line.startswith("# "):
        slide = prs.slides.add_slide(slide_layout)
        if slide.shapes.title:
            slide.shapes.title.text = line[2:]
    elif line.startswith("- ") and slide:
        if slide.placeholders and len(slide.placeholders) > 1:
            tf = slide.placeholders[1].text_frame
            p = tf.add_paragraph()
            p.text = line[2:]
            p.level = 0
prs.save(r"${resolvedPath}")
print("OK")
`;
      break;
    default:
      return { success: false, error: `不支持的 Office 格式: ${ext}` };
  }

  try {
    execSync(`python -c "${script.replace(/"/g, '\\"')}"`, {
      timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    return { success: true, path: resolvedPath, action: "created" };
  } catch (e) {
    return { success: false, error: `Office 写入失败: ${(e as Error).message}` };
  }
}
