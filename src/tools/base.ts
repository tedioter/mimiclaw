import type { z } from "zod";

type ToolSchema = z.ZodTypeAny;

/** 内置工具与 MCP 工具共同遵守的运行时契约。 */
export abstract class Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schema: ToolSchema;
  readonly parameters?: Record<string, unknown>;

  abstract execute(arguments_: Record<string, unknown>): Promise<string>;
}

export type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function isToolFailureResult(result: string): boolean {
  return (
    result.startsWith("工具执行失败：") ||
    result.startsWith("MCP 工具执行失败：") ||
    /(?:^|\n)exit_code=[1-9]\d*(?:,|\n|$)/.test(result)
  );
}

export function parseToolArguments(
  tool: Tool,
  arguments_: Record<string, unknown>
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const result = tool.schema.safeParse(arguments_);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "";
    const label = path ? `参数 "${path}" ` : "参数";
    return { success: false, error: `${label}${issue?.message ?? "无效"}` };
  }
  return { success: true, data: result.data as Record<string, unknown> };
}
