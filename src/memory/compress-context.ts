import type { RecentTurn } from "./short-term-memory.js";

function formatRecentTurns(turns: RecentTurn[]): string {
  return turns
    .map(
      (turn, index) =>
        `轮次 ${index + 1} (${turn.platform})\n用户：${turn.user}\n助手：${turn.assistant}`
    )
    .join("\n\n");
}

export function buildContextCompressionMessages(
  existingSummary: string,
  turns: RecentTurn[]
): Array<{ role: "system" | "user"; content: string }> {
  const transcript = formatRecentTurns(turns);
  return [
    {
      role: "system",
      content: [
        "你是对话上下文压缩器，负责把较早的对话轮次合并成一段简短摘要。",
        "摘要会写入 <recent_conversation_summary>，供助手在后续轮次延续话题；这是滑动窗口压缩，不是长期记忆或用户画像。",
        "",
        "保留：仍在进行的话题、未完成的请求、用户明确给出的约束，以及已做过的关键操作与结果（如文件/路径、命令结论、报错、待确认事项）。",
        "丢弃：寒暄、重复表述、已解决且不再相关的一次性细节。",
        "",
        "若已有摘要，在其基础上增量合并待压缩轮次；去掉已被近期对话覆盖或已完成的内容，避免重复。",
        "若无摘要，则根据待压缩轮次新建。",
        "",
        "输出要求：只输出摘要正文；使用简洁中文叙述；不要标题、列表、Markdown 或代码块；尽量简短。"
      ].join("\n")
    },
    {
      role: "user",
      content: `<existing_summary>\n${existingSummary.trim() || "(空)"}\n</existing_summary>\n\n<turns_to_compress>\n${transcript}\n</turns_to_compress>`
    }
  ];
}

export function parseContextCompressionResult(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split(/\r?\n/);
    lines.shift();
    if (lines.at(-1)?.trim() === "```") {
      lines.pop();
    }
    cleaned = lines.join("\n").trim();
  }
  return cleaned;
}
