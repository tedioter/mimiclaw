# mimiclaw

本地优先的个人 AI 助手：CLI、QQ 私聊和飞书私聊共用同一套 Agent、人格、近期对话与长期记忆。

## 定位

**mimiclaw 是个人私聊助手，不是群聊机器人。**

- QQ 仅处理 C2C 私聊消息，群聊 / 频道 / 群 DM 会被忽略
- 飞书仅处理 `p2p` 私聊文本消息
- 平台适配器与 Agent 通过 `MessageBus` 解耦：适配器负责收发，`AgentRuntime` 驱动 `Agent` 循环；设计前提是个人单会话串行使用

## 功能

- OpenAI 兼容的流式模型接口，支持正文、思考和工具调用增量
- `read`、`write`、`edit`、`bash`、`grep`、`find`、`web_fetch`、`remember` 八个内置工具
- 工具参数 Zod 校验、工作区真实路径隔离、网页 SSRF 防护、命令超时和输出截断
- `SOUL.md` 人格、`USER.md` 用户资料、`MEMORY.md` 长期记忆（仅 `remember` 工具写入）与 `recent.json` 滑动窗口上下文压缩
- MCP stdio、SSE 和 Streamable HTTP 客户端
- 腾讯 `@tencent-connect/qqbot-nodejs` SDK（Gateway、自动重连、C2C 流式消息）与飞书官方 SDK（长连接、卡片更新）
- `init`、`chat`、`ask`、`serve`、`qq`、`feishu` 命令

## 环境要求

- Node.js 20 或更高版本

## 安装与运行

```powershell
cd mimiclaw
npm install
npm run dev -- init
```

填写 `config.toml` 中对应厂商的 `model.vendors.<厂商>.api_key`，然后运行：

```powershell
npm run dev -- chat
npm run dev -- ask "你好"
npm run dev -- qq
npm run dev -- feishu
npm run dev -- serve
```

`chat` / `ask` 走 CLI 平台；`qq` / `feishu` / `serve` 启动对应远程平台（`serve` 同时启动 QQ 与飞书）。

生产构建：

```powershell
npm run build
npm start -- chat
```

## 配置

参考项目根目录的 `config.example.toml`。`data_dir` 与 MCP 配置文件路径相对项目根；`tools.workspace = "."` 以启动命令时的当前目录为工作区。

记忆相关配置：

- `context_turns` — 近期对话保留轮数
- `compress_context` — 是否对超出窗口的对话做摘要压缩
- `compress_batch` — 每次压缩的轮数（默认 `floor(context_turns / 2)`）

MCP 默认关闭。开启 `[mcp] enabled = true` 并在 `mcp.json` 中配置 server 后，工具会以 `mcp_{server}_{tool}` 名称注册。

## 测试

```powershell
npm run typecheck
npm run format:check
npm test
npm run build
```

推送至 GitHub 后，`.github/workflows/ci.yml` 会在 `master` 分支上自动运行相同检查。

架构演进见 [`docs/architecture-changelog.md`](docs/architecture-changelog.md)。

## 目录

```text
src/app/              入口（main）、bootstrap 平台启动与 runtime 组装
src/bus/              MessageBus：平台与 Agent 的消息路由
src/types/            共享事件协议与错误类型
src/config/           配置读取、校验、类型与路径解析
src/model/            模型接口与 provider 实现
src/agent/            Agent 编排与工具执行
src/init/             项目初始化与默认模板
src/tools/            内置工具
src/memory/           SOUL/USER/MEMORY 存储、近期上下文与压缩
src/mcp/              MCP 配置、连接和代理工具
src/platforms/        CLI、QQ、飞书等平台适配器
docs/                 架构迭代记录
data/                 SOUL.md、USER.md、MEMORY.md 与 recent.json
```
