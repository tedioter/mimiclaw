import { errorMessage } from "../types/errors.js";
import type { ToolCall } from "../types/events.js";
import { isToolFailureResult, parseToolArguments, type PendingToolCall } from "../tools/base.js";
import type { ToolRegistry } from "../tools/toolregistry.js";
import { formatErrorForLog, summarizeLogText, writeLog } from "../utils/log.js";
import { isRecord } from "../utils/type-guards.js";

const MAX_TOOL_RESULT_CHARS = 60_000;

function limitToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[工具结果已截断，原长 ${result.length} 字符]`;
}

/** 失败日志附带完整工具参数，便于排查。 */
function toolFailureLogContext(call: ToolCall, rawArguments?: string): Record<string, unknown> {
  const context: Record<string, unknown> = { arguments: call.arguments };
  if (rawArguments !== undefined) {
    context.rawArguments = rawArguments;
  }
  return context;
}

export function formatToolIntent(call: ToolCall): string {
  const fallback = `执行工具：${call.name}`;
  const intent = String(call.arguments.intent ?? fallback)
    .trim()
    .split(/\s+/)
    .join(" ")
    .slice(0, 120);
  return intent || fallback;
}

type ParsedPendingToolCall = {
  call: ToolCall;
  rawArguments: string;
  argumentError?: string;
};

export function parsePendingToolCalls(
  pendingToolCalls: Map<number, PendingToolCall>
): ParsedPendingToolCall[] {
  return [...pendingToolCalls.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([index, pending]) => {
      let arguments_: Record<string, unknown> = {};
      let argumentError: string | undefined;
      try {
        const parsed: unknown = JSON.parse(pending.arguments || "{}");
        if (!isRecord(parsed)) {
          argumentError = "工具参数必须是 JSON 对象";
        } else {
          arguments_ = parsed;
        }
      } catch {
        argumentError = "工具参数不是有效的 JSON 对象";
      }
      return {
        call: {
          callId: pending.id || `call_${index}`,
          name: pending.name,
          arguments: arguments_
        },
        rawArguments: pending.arguments || "{}",
        ...(argumentError ? { argumentError } : {})
      };
    });
}

export async function executeToolCall(
  tools: ToolRegistry,
  call: ToolCall,
  turnId: string,
  argumentError?: string,
  rawArguments?: string
): Promise<string> {
  const toolName = call.name || "未知工具";
  writeLog("info", "assistant", {
    turnId,
    type: "tool_call",
    callId: call.callId,
    tool: toolName,
    intent: formatToolIntent(call)
  });
  const tool = tools.get(call.name);
  if (!tool) {
    const error = `不存在此工具："${toolName}"`;
    writeLog("error", "tool", {
      turnId,
      type: "tool_resolution_error",
      callId: call.callId,
      tool: toolName,
      content: error,
      ...toolFailureLogContext(call, rawArguments)
    });
    return error;
  }
  if (argumentError) {
    return logArgumentError(turnId, call, toolName, argumentError, rawArguments);
  }
  const parsed = parseToolArguments(tool, call.arguments);
  if (!parsed.success) {
    return logArgumentError(turnId, call, toolName, parsed.error, rawArguments);
  }
  const arguments_ = Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => key !== "intent")
  );
  try {
    const result = await tool.execute(arguments_);
    const failed = isToolFailureResult(result);
    writeLog(failed ? "error" : "info", "tool", {
      turnId,
      type: failed ? "tool_result_error" : "tool_result",
      callId: call.callId,
      tool: toolName,
      content: failed ? result : summarizeLogText(result),
      ...(failed ? toolFailureLogContext(call, rawArguments) : {})
    });
    return limitToolResult(result);
  } catch (error) {
    writeLog("error", "tool", {
      turnId,
      type: "tool_execution_error",
      callId: call.callId,
      tool: toolName,
      ...toolFailureLogContext(call, rawArguments),
      ...formatErrorForLog(error)
    });
    return `工具执行失败：${errorMessage(error)}`;
  }
}

function logArgumentError(
  turnId: string,
  call: ToolCall,
  toolName: string,
  error: string,
  rawArguments?: string
): string {
  writeLog("error", "tool", {
    turnId,
    type: "tool_argument_error",
    callId: call.callId,
    tool: toolName,
    content: error,
    ...toolFailureLogContext(call, rawArguments)
  });
  return `工具参数无效：${error}`;
}
