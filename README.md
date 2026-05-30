# claw-mvp — 最小的能安全办公的office claw

CLI + Web 双模式 AI Agent，TypeScript (ESM)，零编译。

## 核心主打

**轻量** — 零编译、单依赖（仅 `openai`），16 个源文件，3000行代码，Node.js 直跑。没有 webpack / vite / tsc，clone 下来 `npm install && npm start` 就能用。

**安全** — 工作区沙箱隔离 + exec 危险命令黑名单 + 文件操作沙箱检测 + SSRF 内网 IP 拦截 + 反 LLM 幻觉规则。数据不足时诚实报告，不编造内容。

**办公** — 内置 `.xlsx`、`.docx`、`.pptx`、`.pdf` 自动解析与生成，Python 脚本执行 + 自动 pip install。三引擎并行搜索（Bing + Google + 百度），PDF 一键下载。真正能干活的工作 Agent。

## 与 OpenClaw 对比（个人办公场景）

OpenClaw 是生产级多通道 AI 助手平台，但默认信任主 Session 的设计在 LLM 偶尔犯浑时存在风险敞口。claw-mvp 面向个人办公场景，在以下维度更贴合实际：

### 🛡️ 安全更细粒度

- **Exec 黑名单 30+ 条平台感知规则** — `format`、`del /f`、`shutdown`、`reg delete`、`schtasks`、`netsh`、`iex`、`iwr`、`EncodedCommand` 等危险命令直接拒绝，不需要用户手动审批
- **文件操作沙箱防泄密** — `Copy-Item` / `move` / `xcopy` / 重定向 `>` 的目标路径实时检测，LLM 无法通过 exec 把文件搬到工作区外
- **SSRF 内网全覆盖拦截** — 全部 RFC 1918 保留地址段 + 链路本地 + 十六进制/十进制 IP 编码攻击 + `file://` 协议拒绝
- **反幻觉硬约束** — system prompt 明确禁止编造数据 + ≤30 字符空话自动重试（最多 3 次）+ 搜索 4 轮封顶强制综合汇总
- **Python 危险模块黑名单** — `os.system` / `subprocess` / `socket` / `eval` / `requests` 等禁止导入

### 💼 办公文件原生支持

- **Office 格式是核心能力** — `.xlsx` / `.docx` / `.pptx` 开箱即用，不是插件也不是技能
- **Markdown → Office 自动转换** — 一条 `write` 命令把 `# 标题` / `- 列表` 转为 Word 或 PPT
- **PDF 双引擎读取** — `pdfplumber`（优先）+ `PyPDF2`（回退），自动安装
- **三引擎搜索去重** — Bing + Google + 百度并行，结果合并去重
- **Python 开箱即用** — 自动 pip 安装依赖，数据分析一条龙
- **文件下载工具** — `download` 直接拉 URL 到工作区

### ⚡ 极致轻量

- **1 个 npm 依赖** — 只装 `openai` SDK，无 pnpm workspace、无 Docker、无额外运行时
- **3,464 行代码** — 一个下午读完，完全透明
- **零配置文件** — 环境变量搞定一切，无 `openclaw.json`、无 `exec-approvals.json`
- **零编译** — `--experimental-strip-types` 直跑 `.ts`，无 webpack/vite/tsc
- **单进程** — 无 Gateway 守护进程、无 Control UI、无 Sidecar

### 🧠 设计哲学

- **"把 LLM 当实习生管"** — 防御性设计，默认不信任模型输出，5 层纵深防御层层兜底
- **平台感知** — Windows 和 Linux 各有一套黑名单，Windows 版额外 20+ 条规则
- **编码自适应** — UTF-8 → GBK 自动回退解码，Windows 中文环境不乱码

> **一句话**：claw-mvp 在个人办公场景下的优势 = 管得细（30+ 条黑名单）+ 原生支持 Office + 零负担部署 + 代码完全透明。它和 OpenClaw 不是竞争关系，而是刚好补上了 OpenClaw 主 Session 默认放太宽的缺口。

## 快速开始

```bash
npm install
npm start       # CLI 模式
npm run web     # Web 模式（浏览器打开 http://localhost:3456）
```

## 运行模式

### CLI 模式
```
npm start
```

支持的斜杠命令：`/file` `/model` `/clear` `/history` `/save` `/load` `/list` `/delete` `/exit` `/help`

Ctrl+C 一次中断生成，两次退出。

### Web 模式
```
npm run web
npm run web -- --port 8080   # 自定义端口
```

REST API：
- `POST /api/chat` — SSE 流式聊天
- `GET/POST/DELETE /api/sessions` — 会话管理
- `GET /api/config` — 当前配置
- `GET/POST /api/models` — 模型列表

## 工具能力

| 工具 | 功能 |
|------|------|
| `read` | 文件读取（文本 + .xlsx/.docx/.pptx/.pdf） |
| `write` | 文件写入（文本 + Office 自动转换） |
| `edit` | 精确文本替换 |
| `exec` | Shell 命令执行（安全沙箱） |
| `web_search` | 三引擎并行搜索（Bing + Google + 百度），结果合并去重 |
| `web_fetch` | 网页内容抓取（SSRF 防护） |
| `download` | 文件下载到工作区（PDF、图片等任意类型） |
| `python` | Python 脚本执行（auto-pip + 安全检查） |

## 配置

配置文件：`~/.claw/config.json`

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "providers": {
    "deepseek": {
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx"
    }
  },
  "workspace": "./workspace",
  "maxHistoryTurns": 50,
  "maxIterations": 30,
  "maxSearchRounds": 4,
  "proxy": "http://127.0.0.1:7890"
}
```

环境变量覆盖：`CLAW_MODEL` / `CLAW_WORKSPACE` / `DEEPSEEK_API_KEY`

## 目录结构

```
claw-mvp/
├── package.json
├── system-prompt.md
├── README.md
├── public/
│   └── index.html
├── src/
│   ├── index.ts          # CLI 入口
│   ├── server.ts         # Web 服务
│   ├── agent.ts          # Agent 主循环
│   ├── llm.ts            # LLM 客户端
│   ├── config.ts         # 配置管理
│   ├── session.ts        # 会话持久化
│   └── tools/
│       ├── index.ts      # 工具注册中心
│       ├── read.ts
│       ├── write.ts
│       ├── edit.ts
│       ├── exec.ts
│       ├── web_search.ts
│       ├── web_fetch.ts
│       ├── download.ts
│       └── python.ts
└── workspace/
```

## 技术栈

- Node.js 22.6+ (`--experimental-strip-types`)
- TypeScript (ESM)
- OpenAI SDK v4
- 原生 `node:http`（Web 服务器）

## 系统要求

- Node.js >= 22.6
- Python 3（Office 文件处理）
- npm 网络连接（安装 openai 依赖）
