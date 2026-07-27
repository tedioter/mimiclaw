# 项目协作工作流

## 基本要求

- 代码注释使用中文。
- 项目文档使用中文。
- 不提交密钥、个人配置、运行时记忆和本地环境文件。
- 修改前先检查工作区状态，保留与当前任务无关的用户改动。

## 新功能与架构改动

完成新功能或架构调整时，按以下顺序执行：

1. 明确改动范围和影响的模块。
2. 完成功能实现，并同步补充或调整测试。
3. 运行与改动相关的检查；常规情况下至少运行：
   - `npm run typecheck`
   - `npm test`
   - `npm run format:check`
   - `npm run build`
4. 检查 `git diff`、`git diff --check` 和 `git status`，确认没有误提交的配置、密钥或无关文件。
5. 验证通过后，**先向用户确认再提交**：说明 staging 范围、commit message（及架构 changelog 是否需更新），**未经用户明确同意不得执行 `git commit`**。若本次提交改变了模块职责、依赖关系、数据流或运行流程，**在同一次 commit 中**更新 [`docs/architecture-changelog.md`](docs/architecture-changelog.md)：新增一章，写清**相对上一提交**的架构差异；开发过程中不要提前写入未提交章节。
6. 提交信息使用中文，并遵循 Conventional Commits 前缀，例如 `feat:`、`fix:`、`refactor:`、`docs:`。标题一行概括「为什么改」，正文补充关键影响；示例：
   ```
   refactor(agent): 从 memory 派生上下文并统一轮次结束处理

   移除 AgentContext，Agent 仅依赖 model、memory、tools；turn_done 后由 turnDoneHandler 写入记忆。
   ```
7. 用户确认并完成提交后，推送到 `origin` 当前分支（`git push`），确保远程与本地一致。

## Agent 相关边界

- `Agent` 只依赖 `model`、`memory`、`tools`；prompt 与近期对话由 `memory` 在运行时派生。
- 记忆提交、上下文压缩在 `turn_done` 时由 `Agent.handleTurnDone()` → `turnDoneHandler()` 完成；`AgentRuntime` 只负责总线、平台与 MCP 生命周期。
- Agent、App 或上下文边界发生变化时，必须在**对应 Git 提交**中更新架构迭代记录，且只描述该提交相对上一提交的差异。
