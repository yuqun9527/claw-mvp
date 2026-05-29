# claw-mvp

CLI + Web 双模式 AI Agent，TypeScript (ESM)，零编译。

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
| `web_search` | 多引擎搜索（DuckDuckGo + Bing） |
| `web_fetch` | 网页内容抓取（SSRF 防护） |
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
  "maxIterations": 30
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
