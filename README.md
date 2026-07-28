# mimiclaw

本地优先的个人 AI 助手。当前 `mimi` 命令入口提供 CLI 交互模式；QQ 和飞书适配器代码仍在仓库中，但当前入口未开放远程平台启动命令。

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
- 腾讯 `@tencent-connect/qqbot-nodejs` 与飞书官方 SDK 适配器（远程平台入口暂未开放）
- 模型切换仅在 CLI 中提供；QQ 不再处理 `/model` 专用命令
- CLI 斜杠命令候选：输入 `/` 查看命令，支持前缀过滤、方向键选择和 Esc 关闭
- `init` 命令；直接执行 `mimi` 进入 CLI 交互模式

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
npm run dev
```

`npm run dev -- init` 会在项目根目录创建以下内容，已存在的文件不会覆盖：

- `config.toml`：运行配置
- `mcp.json`：MCP 配置
- `data/SOUL.md`、`data/USER.md`、`data/MEMORY.md`：记忆与人格模板

`mimi` 默认进入 CLI 交互模式，`mimi init` 与 `npm run dev -- init` 等价。

生产构建：

```powershell
npm run build
npm start
```

构建后也可以通过 npm 全局链接使用 `mimi`：

```powershell
npm run build
npm link
mimi --help
mimi init
mimi
```

## CLI 命令

直接运行 `npm run dev`、`npm start` 或已链接的 `mimi` 后进入交互模式：

- 输入 `/` 查看 `/model`、`/exit` 和 `/quit` 候选
- 输入部分前缀可过滤候选；使用 ↑↓ 选择，Enter 执行，Esc 关闭候选面板
- `/model` 选择厂商和模型；切换成功后会直接更新 `config.toml` 的 `model.current_model`，并从下一轮对话开始生效
- `/exit` 或 `/quit` 退出当前对话
- 输入普通文本后按 Enter，发送给当前模型

## 配置

参考项目根目录的 `config.example.toml`。首次运行前至少需要填写：

- `model.current_model`：当前模型名，必须出现在某个 `model.vendors.<厂商>.models` 中
- `model.vendors.<厂商>.api_key`：模型服务 API Key
- `model.vendors.<厂商>.base_url`：模型服务地址
- `model.vendors.<厂商>.models`：该厂商提供的模型名列表

当前配置加载会校验所有已声明厂商的 `api_key`；如果暂时不用某个厂商，也应先移除对应配置段，不能只留下空密钥。

可以在同一个配置中添加多个厂商。模型名在所有厂商之间必须全局唯一，`model.current_model` 只填写模型名：

```toml
[model]
current_model = "deepseek-v4-pro"

[model.vendors.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
api_key = "DeepSeek API Key"
models = ["deepseek-v4-pro"]
enable_thinking = true

[model.vendors.bailian]
name = "阿里百炼"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
api_key = "阿里百炼 API Key"
models = ["qwen3.7-max", "qwen3.7-plus"]
enable_thinking = false
```

当前模型客户端统一使用 OpenAI Chat Completions 兼容协议。阿里百炼应使用兼容模式地址；示例关闭了思考参数，因为不同厂商的思考字段名称可能不同。需要启用阿里百炼专用的思考参数时，还需要在模型请求层增加对应的协议适配。

路径规则：`data_dir` 与 MCP 配置文件路径相对项目根；`tools.workspace = "."` 以启动命令时的当前目录为工作区。

`config.toml`、`mcp.json` 和 `data/` 下的运行时记忆及日志文件属于本地配置或运行时数据；模型切换会直接写回 `config.toml`，不要提交这些文件到 Git。

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
data/                 SOUL.md、USER.md、MEMORY.md、recent.json 与 runtime.log
```
