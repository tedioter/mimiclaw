# 架构迭代记录

本文档记录**已提交**版本之间的架构演进，不记录进行中的未提交改动。

## 记录规则

- **一条记录对应一次 Git 提交**（或一组明确一起合并、且共同构成架构变更的提交）。
- 每条章节描述的是**上一提交 → 当前提交**的架构差异，不是工作区里的临时状态。
- 开发过程中不要提前写入尚未提交的章节；**在创建 Git 提交时**再新增或更新对应章节。
- 普通 bug 修复、样式调整、测试补全若未改变模块职责、依赖关系、数据流或运行流程，不必记录。
- 若某次提交撤销或改写了先前记录，在**新提交**中追加章节说明，不要静默改写旧章节的历史描述（旧章节应仍反映当时已提交的真相）。

## 2026-07-23：Agent 与 App 职责分离

### 变更目标

让 `Agent` 只负责在给定上下文中完成一轮对话，把记忆提交和上下文压缩放到 App 层处理。

### 主要变化

#### 1. Agent 构造方式变化

之前：

```ts
new Agent(config, model, memory, tools);
```

现在：

```ts
new Agent(model, context, options);
```

Agent 不再直接依赖 `AppConfig` 和 `Memory`。

#### 2. 新增 AgentContext

`AgentContext` 位于 `src/agent/context.ts`，包含：

```ts
type AgentContext = {
  prompt: string;
  messages: ModelMessage[];
  readonly tools: ToolRegistry;
};
```

- `prompt`：已经组装好的系统提示，包含 `SOUL.md`、`USER.md`、`MEMORY.md` 和上下文摘要。
- `messages`：已经提交的历史对话。
- `tools`：当前可用的工具。

Agent 只使用这些内容，不再自行读取记忆文件。

#### 3. 记忆提交移到 App 层

原来的 `src/memory/commit-turn.ts` 已移动为：

```text
src/app/turn-coordinator.ts
```

上下文压缩、当前用户消息写入和助手回复写入，现在由 `AgentRuntime` 调用 App 层协调器完成。

#### 4. Agent Runner 增加提交回调

`runAgentLoop()` 收到 Agent 的 `turn_done` 事件后，将最终回复交给 App 层：

```text
收到消息
  -> Agent 回答
  -> 发布 turn_done
  -> App 压缩上下文并提交记忆
  -> App 刷新 AgentContext
  -> 下一轮使用新 prompt 和新历史
```



#### 5. 上下文刷新

App 提交一轮对话后，会重新读取记忆文件并更新同一个 `AgentContext` 对象的：

- `context.prompt`
- `context.messages`

因此，如果工具在本轮修改了 `MEMORY.md`，下一轮会读取到修改后的内容。当前轮已经构造完成的模型请求不会自动刷新。

### 相关文件

- `src/agent/agent.ts`：Agent 对话和工具循环。
- `src/agent/context.ts`：AgentContext 定义。
- `src/agent/prompt.ts`：生成完整 prompt 和历史消息。
- `src/app/bootstrap.ts`：创建 Agent、Runtime 和上下文刷新。
- `src/app/agent-runner.ts`：驱动 Agent 并触发 App 提交。
- `src/app/turn-coordinator.ts`：上下文压缩和记忆提交。
- `tests/agent-runner.test.ts`：验证 App 提交回调。



### 暂未实现

运行时模型切换和思考程度切换暂未实现，当前只完成了后续扩展所需的 Agent 与 App 职责分离。

## 2026-07-25：Agent 依赖 memory 派生上下文，MCP 归入工具层



### 背景

上一版通过 `AgentContext` 在 App 层缓存 prompt 与历史，并在提交后刷新同一对象。边界仍不够清晰：Agent 间接依赖 App 组装的上下文，MCP 生命周期散落在 Runtime，展示过滤混在 Agent 与平台之间。

### 变更



#### 1. Agent 只依赖 model、memory、tools

之前：

```ts
new Agent(model, context, options);
```

现在：

```ts
new Agent(model, memory, tools);
```

- 删除 `src/agent/context.ts`（`AgentContext` 移除）。
- 每轮 `runTurn` 开头调用 `buildPromptContext(memory)` 现读 prompt 与近期对话；`runTurn` 期间不写 memory。
- 调试接口改为 `readPromptContext()`。



#### 2. 轮次结束处理统一到 Agent 层

- 删除 `src/app/turn-coordinator.ts`。
- 新增 `src/agent/turn-end-handler.ts`，导出 `handleTurnEnd()`：先压缩短期记忆，再 append 当前轮。
- `Agent.handleTurnEnd()` 为对外薄封装；`runAgentLoop` 在 `turn_done` 后调用。



#### 3. Memory 承载压缩策略

`Memory` 新增 `compression: { compressBatch, compressContext }`；上下文摘要标签统一为 `<recent_conversation_summary>`。

#### 4. MCP 归入 ToolRegistry

- `createToolRegistry()` 连接 MCP 并将代理工具并入同一注册表；`ToolRegistry.close()` 关闭 hub。
- `AgentRuntime` 精简为 `{ config, agent, bus }`，不再暴露 memory、model、mcpHub。



#### 5. 展示过滤与平台流式修正

- `shouldPublishAgentEvent()` 与 `runAgentLoop(..., display?)` 在 App 层按配置过滤 thinking、tool_intent。
- 飞书/QQ 流式：工具轮旁白不计入最终回答，避免 `turn_done` 补发重复。



#### 6. 其他

- `InboundMessage` / `OutboundMessage` 移至 `bus/message-bus.ts`。
- MCP 远程传输统一 `StreamableHTTPClientTransport`；Zod 4 `looseObject` 替代 `passthrough`。
- 工具失败日志附带完整参数便于排查。



### 影响

- 调用方：`commitTurn` 更名为 `handleTurnEnd`；不再存在 `AgentContext` 与 Runtime 上的 memory/model 访问。
- 数据流：memory 为 prompt 唯一来源；下一轮自动读到最新长期记忆与压缩摘要。
- 配置：`transport: sse` 仅为别名，运行时与 `http` 相同（Streamable HTTP）。



### 暂未解决的问题

- 运行时模型切换与 Anthropic 原生 API 适配仍未实现。
- 仅支持旧版 HTTP+SSE、不支持 Streamable HTTP 的 MCP 服务可能无法连接。



## 2026-07-27：Runtime 内聚 Agent 循环，总线与平台出站分离



### 背景

上一版仍保留独立的 `agent-runner` 与 `loadRuntime`；`MessageBus` 的 `OutboundMessage` 同时承载 Agent 事件与平台纯文本，命名 `turn_end`/`turn_done` 不一致；流式失败降级可能重复或误补全文。

### 变更



#### 1. AgentRuntime 接管循环

- 删除 `src/app/agent-runner.ts`；`AgentRuntime.runLoop()` 消费入站消息、驱动 `agent.respond()`、按 display 过滤出站事件。
- `turn_done` 后调用 `agent.handleTurnDone()`；`createRuntime()` 取代 `loadRuntime()`，运行时组装留在 `src/app/runtime.ts`。
- `shouldShowEvent()` 取代 `shouldPublishAgentEvent()`。



#### 2. turn_done 命名与 handler 统一

- `handleTurnEnd` / `turn-end-handler` 更名为 `handleTurnDone` / `turn-done-handler`。
- 记忆写入与压缩错误在 `turnDoneHandler()` 内记录日志，不向上抛出。



#### 3. MessageBus 出站语义澄清

- `OutboundMessage` 仅表示 Agent → 平台的事件流（含 `AgentEvent`）。
- 平台对外 API 纯文本改为 `PlatformTextMessage`；总线方法统一带 `Message` 后缀（`publishInboundMessage` 等）。
- 删除 `BusOutboundMessage` 导出。



#### 4. 流式降级与 Agent 容错

- 飞书/QQ 用 `remainingFinalAnswer` / `remainingAfterStreamFailure` 按已成功发出的 plain 补差；仅 `turn_done` 终端触发降级补发。
- Agent 推理异常时若已有部分 `text_delta`，仍 yield `turn_done` 以便记忆提交；助手日志单独放宽截断上限（`summarizeAssistantReplyLog`）。



### 影响

- 对外：`loadRuntime` → `createRuntime`；总线与 `handleTurnEnd` → `handleTurnDone`。
- 测试：`agent-runner.test.ts` 迁移为 `runtime.test.ts`。
- `bootstrap.ts` 仅负责平台启动，re-export `createRuntime` 与 `AgentRuntime`。



### 暂未解决的问题

- 运行时模型切换仍未实现。

## 2026-07-27：飞书流式降级修复、CI 与测试补全

### 背景

飞书 `markPublished()` 在卡片 `stream.update` 成功前就执行，导致流式失败降级几乎不会补发；缺少 `createRuntime` 冒烟测试与 CI 门禁；README 未反映 runtime 职责分离。

### 变更

- `FeishuCardBuffer.produce()` 在卡片更新成功后回调 `markPublished()`，与 QQ 的「发送成功后再记 plain」对齐。
- `createRuntime()` 支持可选 `configPath`，便于测试与多配置场景。
- 新增 GitHub Actions CI：`typecheck`、`format:check`、`test`、`build`。
- 补充 `summarizeAssistantReplyLog`、`createRuntime`、飞书流式降级集成测试。

### 影响

- 飞书流式中断时降级补发行为与 QQ 一致，按已成功发出的 plain 补差。
- 推送至 `master` 自动跑 CI；README 测试命令与目录说明更新。

## 2026-07-27：多模型 runtime 与平台切换命令

### 背景

上一版只有单模型配置，Agent 直接持有一个模型实例，CLI 与 QQ 私聊没有运行时模型选择入口。

### 变更

- `[model]` 配置兼容单模型写法，并新增 `active` 与 `runtimes` 多模型写法；`ModelRuntime` 负责按需创建模型实例、维护当前 runtime 并执行切换。
- `Agent` 改为依赖 `ModelRuntime`，每轮开始绑定当前模型；CLI 与 QQ 私聊通过 `ModelControl` 查询和切换 runtime，切换从下一轮对话生效。
- CLI 新增模型选择器与命令历史，QQ 仅在 C2C 私聊中处理模型命令；运行日志改为写入 `data/runtime.log`。

### 影响

- 配置调用方从 `config.model` 单个 `ModelConfig` 调整为 `config.model.active/runtimes`，旧 flat 配置仍自动映射为 `default` runtime。
- 平台启动时向 CLI、QQ 注入运行时模型控制；QQ 群聊、频道等非私聊消息不参与模型切换。
- 新增模型 runtime、配置解析、命令历史与终端选择器测试。

### 暂未解决的问题

- 尚未提供 Web 或其他平台的模型切换入口。

## 2026-07-28：模型厂商分组与选择持久化

### 背景

上一提交已经提供模型 runtime 切换，但模型仍以平面列表暴露，当前选择只存在于进程内；配置也没有表达厂商与模型之间的归属关系。

### 变更

- `[model.vendors.<厂商>]` 维护厂商名称、接口配置和模型列表，配置解析器为每个模型生成 `<厂商>/<模型>` runtime，并校验模型只能归属于一个厂商。
- `ModelRuntime` 新增厂商列表和按厂商查询模型的能力；切换后的 runtime 以原子写入保存到 `data/model-selection.json`，启动时恢复仍然有效的选择。
- `AgentRuntime`、CLI 和 QQ 适配器通过 `ModelControl` 传递厂商与模型查询；CLI 和 QQ 私聊均采用“先选厂商、再选模型”的流程。旧 flat/runtime 配置继续兼容，但统一映射到当前支持的 `DeepSeek` 厂商，不再创建默认厂商。
- CLI 在输入 `/` 时实时显示命令候选和描述，支持前缀过滤、上下键高亮选择、Enter 执行和 Esc 关闭；面板关闭时上下键继续回溯命令历史。终端选择器在输入流关闭时主动清理，CLI 入口不再使用长生命周期顶层 await。

### 影响

- 模型切换仍在下一轮 CLI 对话或下一条 QQ 私聊消息生效，重启后继续使用持久化选择；`data/model-selection.json` 不纳入版本控制。
- 配置示例和 README 改为厂商配置路径；配置、runtime、平台交互和重启恢复测试覆盖新增数据流。

### 暂未解决的问题

- 模型厂商与模型列表仍由本项目配置维护，尚未接入厂商模型发现 API。

## 2026-07-28：以模型名统一运行时身份

### 背景

上一提交已经按厂商组织模型，但内部仍使用厂商前缀和 runtime ID 标识模型。当前约定模型名全局唯一，因此继续保留两套身份会增加配置、持久化和平台切换的转换逻辑。

### 变更

- `ModelSectionConfig` 使用 `currentModel`，模型配置和厂商的模型列表都直接以模型名索引。
- `ModelRuntime` 使用模型名管理实例，公开接口改为 `getCurrentModel()`、`getCurrent()` 和 `switchModel(model)`；模型信息使用 `current` 标记，不再暴露 runtime ID。
- 选择持久化改为 `{ "currentModel": "..." }`。读取时兼容旧的 `active` 字段及旧 runtime 名称，避免升级后丢失用户选择。
- 配置解析支持 `model.current_model` 和 `model.vendors.<vendor>.model_options.<model>`。厂商配置提供公共参数，模型级配置只覆盖有差异的字段。
- Agent、App、CLI 和 QQ 私聊切换链路统一传递模型名，厂商仅负责分组和展示，不参与模型身份生成。

### 影响

- 模型切换、重启恢复和 Agent 每轮取模都围绕模型名运行，下一轮对话继续使用切换后的模型。
- 新配置不再需要拼接 `vendor/model` 作为模型身份；旧 flat 配置和旧 `[model.runtimes.*]` 配置仍可迁移读取。
- `deepseek-v4-flash` 可以通过模型级覆盖保持与公共厂商参数不同的思考设置。

### 暂未解决的问题

- 厂商模型列表仍由项目配置维护，尚未接入厂商模型发现 API。

## 2026-07-28：仅保留 CLI 模型切换并直接持久化配置

### 背景

上一提交同时在 CLI 和 QQ 私聊中提供模型切换，并通过独立的 JSON 文件保存当前模型。实际使用中 QQ 不应承担模型切换职责，独立状态文件也会让当前模型与主配置产生两份来源。

### 变更

- 模型选择改为由 ModelRuntime 通过配置写入器直接更新 config.toml 的 [model] current_model，移除对 data/model-selection.json 的读写和兼容逻辑。
- QQAdapter 移除 ModelControl 依赖及 /model 专用处理；QQ 收到 /model 时按普通消息交给 Agent，模型切换能力仅由 CLI 保留。
- CLI 继续通过 ModelRuntime 切换模型，并修复 / 候选命令的重复渲染、候选面板关闭后上下键误追加候选内容、单独 / 被误执行等输入流问题。
- 配置示例、README、默认初始化配置和相关测试同步调整为新的持久化数据流，并补充 CLI 候选命令与配置写入测试。

### 影响

- 模型切换后，当前模型直接反映在项目 config.toml 中，重启时从同一配置读取；本地配置和密钥仍不纳入版本控制。
- QQ 不再提供模型选择入口，QQ 的 /model 文本会进入普通对话流程；CLI 的 /model 及底层模型 runtime 接口继续可用。
- 模型持久化、CLI 输入交互和 QQ 行为均由测试覆盖，提交前执行完整类型检查、测试、格式检查和构建检查。

### 暂未解决的问题

- 模型厂商和模型列表仍由项目配置维护，尚未接入厂商模型发现 API。

## 2026-07-28：恢复 IM 平台启动命令入口

### 背景

上一提交误将远程平台启动命令从 `main.ts` 的命令解析中移除，只保留无参数 CLI 入口，导致 QQ 和飞书适配器虽然仍在，却无法通过 `mimi qq` 等命令启动。

### 变更

- 保持无参数 `mimi` 默认启动 CLI，同时恢复 `chat`、`ask`、`qq`、`feishu` 和 `serve` 命令的解析与平台路由；`serve` 继续同时启动 QQ 和飞书。
- 更新帮助文本、README 和命令解析测试，明确 CLI 默认入口与 IM 平台入口的边界。
- QQ 适配器仍不依赖模型切换控制，QQ 收到 `/model` 时继续进入普通 Agent 消息流。

### 影响

- `mimi`、`mimi qq`、`mimi feishu` 和 `mimi serve` 恢复可用；模型切换职责仍仅保留在 CLI。
- 命令解析测试覆盖默认 CLI、CLI 快捷命令、QQ、飞书和双平台启动场景；相关平台行为测试继续通过。

### 暂未解决的问题

- 模型厂商和模型列表仍由项目配置维护，尚未接入厂商模型发现 API。

## 2026-08-04：Agent 模型依赖外提与 ModelRegistry 归 App 层

### 背景

上一提交中 `Agent` 直接持有 `ModelRuntime`，模型列举、切换与实例池化能力与推理核绑在一起；`AgentRuntime` 还需通过 `agent.modelRuntime` 访问模型控制，边界不清晰。

### 变更

- `Agent` 恢复只依赖 `Model`、`Memory`、`ToolRegistry`；构造时注入当前 `Model`，通过 `changeModel()` 在轮次之间切换。
- `ModelRuntime` 改由 `AgentRuntime` 以 `modelRegistry` 持有；`listModels()`、`switchModel()` 等控制面留在 App 层，切换时同步更新 registry 与 `agent.changeModel()`。
- `Agent.close()` 仅释放 tools；`modelRegistry.close()` 由 `AgentRuntime.close()` 负责。
- 测试 helper 新增 `createStubModelRegistry()`，补齐 runtime 与 agent 分层相关用例。

### 影响

- Agent 推理路径不再感知多模型 registry，与文档中「Agent 只依赖 model、memory、tools」一致。
- CLI `/model` 切换链路不变，仍经 `AgentRuntime.switchModel()` 持久化并更新 Agent 当前模型。
- 模型切换语义为轮次之间生效；同一轮 `respond()` 与 `handleTurnDone()` 共用同一 `Model` 实例。

### 暂未解决的问题

- 模型厂商和模型列表仍由项目配置维护，尚未接入厂商模型发现 API。

## 后续记录格式

提交架构相关改动时，在**同一次 commit** 中追加章节，结构如下：

```markdown
## YYYY-MM-DD：迭代名称

### 背景

（相对上一提交，为什么要改）

### 变更

（模块职责、依赖、数据流、运行流程的具体差异）

### 影响

（对调用方、测试、部署的影响）

### 暂未解决的问题
```
