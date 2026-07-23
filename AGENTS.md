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
3. 如果改动影响模块职责、依赖关系、数据流或运行流程，更新 [`docs/architecture-changelog.md`](docs/architecture-changelog.md)。
4. 在迭代记录中新增日期章节，说明背景、变更、影响和暂未解决的问题。
5. 运行与改动相关的检查；常规情况下至少运行：
   - `npm run typecheck`
   - `npm test`
   - `npm run format:check`
   - `npm run build`
6. 检查 `git diff`、`git diff --check` 和 `git status`，确认没有误提交的配置、密钥或无关文件。
7. 验证通过后直接创建 Git 提交，提交信息使用清晰的 Conventional Commits 风格，例如 `feat:`、`fix:`、`refactor:` 或 `docs:`。

## Agent 相关边界

- `Agent` 只负责在给定 `AgentContext` 中完成一轮对话。
- 记忆提交、上下文压缩和上下文刷新由 App 层负责。
- Agent、App 或上下文边界发生变化时，必须更新架构迭代记录。
