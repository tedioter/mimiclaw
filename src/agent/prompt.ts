import type { Memory } from "../memory/memory.js";
import type { ModelMessage } from "../model/index.js";

function buildSystemPrompt(
  soul: string,
  user: string,
  memory: string,
  contextSummary: string
): string {
  const systemPrompt = [
    "你是用户唯一且持续存在的本地私人助手 Mimi。不同平台只是入口，你的身份和记忆完全共享。",
    "以下资料由用户控制，用于定义你的人格、用户上下文和长期记忆：",
    `<soul>\n${soul}\n</soul>`,
    `<user>\n${user}\n</user>`,
    `<long_term_memory>\n${memory}\n</long_term_memory>`
  ];
  if (contextSummary.trim()) {
    systemPrompt.push(`<context_summary>\n${contextSummary.trim()}\n</context_summary>`);
  }
  systemPrompt.push(
    [
      "工作原则：",
      "- 能直接回答时简洁、准确地回答；需要实际操作时必须调用工具，不得虚构已经执行或成功的结果。",
      "- 工具失败时如实说明问题，并根据结果调整后续操作。",
      "- 面向用户的回复使用中文；不要向用户展示英文推理草稿或内部链式思考原文。"
    ].join("\n"),
    [
      "工具规则：",
      "- 文件工作区是配置的工作区目录。操作文件时先用 find 定位、read 确认；精确替换用 edit，创建或整文件覆盖用 write。",
      "- 内容搜索用 grep，执行命令用 bash，获取公开网页内容用 web_fetch。",
      "- 每次工具调用必须填写简短、清晰的中文 intent，且不得包含密钥、完整文件内容等敏感参数。"
    ].join("\n"),
    [
      "记忆规则：",
      "- 仅当用户明确要求长期记住稳定偏好或事实时，调用 remember。",
      "- 临时任务、过程信息和流水账不要写入长期记忆。"
    ].join("\n")
  );
  return systemPrompt.join("\n\n");
}

export type PromptContext = Readonly<{
  prompt: string;
  messages: ModelMessage[];
}>;

export function buildPromptContext(memory: Memory): PromptContext {
  const state = memory.shortTerm.loadState();
  return {
    prompt: buildSystemPrompt(
      memory.longTerm.readSoul(),
      memory.longTerm.readUser(),
      memory.longTerm.readMemory(),
      state.summary
    ),
    messages: memory.shortTerm.asMessages(state)
  };
}

export function buildPrompt(memory: Memory, userText: string): ModelMessage[] {
  const context = buildPromptContext(memory);
  return [
    {
      role: "system",
      content: context.prompt
    },
    ...context.messages,
    { role: "user", content: userText }
  ];
}
