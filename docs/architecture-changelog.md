# 架构迭代记录

本文档用于记录项目架构的持续演进。每次重要架构调整新增一个带日期的章节，不追求记录所有普通代码修改。

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

## 后续记录格式

后续架构迭代按以下结构追加：

```markdown
## YYYY-MM-DD：迭代名称

### 背景

### 变更

### 影响

### 暂未解决的问题
```
