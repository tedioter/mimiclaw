import type { DisplayConfig } from "../config/types.js";
import { MimiError, ModelError } from "../types/errors.js";
import type { AgentEvent, InboundMessage } from "../types/events.js";
import type { AgentContext } from "./context.js";
import type { PendingToolCall } from "../tools/base.js";
import { AsyncMutexLock } from "../utils/async-mutex-lock.js";
import { formatErrorForLog, summarizeLogText, writeLog } from "../utils/log.js";
import { buildTurnId } from "../utils/turn-id.js";
import type { Model, ModelMessage } from "../model/index.js";
import { executeToolCall, formatToolIntent, parsePendingToolCalls } from "./tool-executor.js";

export type AgentOptions = Readonly<{
  display: DisplayConfig;
  enableThinking: boolean;
}>;

export class Agent {
  private readonly turnLock = new AsyncMutexLock();
  private closePromise?: Promise<void>;

  constructor(
    private readonly model: Model,
    private readonly context: AgentContext,
    private readonly options: AgentOptions
  ) {}

  close(): Promise<void> {
    this.closePromise ??= this.model.close();
    return this.closePromise;
  }

  async *respond(inbound: InboundMessage): AsyncIterable<AgentEvent> {
    const turnId = buildTurnId(inbound);
    writeLog("info", "user", {
      turnId,
      content: summarizeLogText(inbound.text)
    });
    const release = await this.turnLock.acquire();
    try {
      const replyTextChunks: string[] = [];
      try {
        for await (const event of this.runTurn(inbound, turnId)) {
          if (event.type === "text_delta") {
            replyTextChunks.push(event.text);
          }
          yield event;
        }
        const assistantReply = replyTextChunks.join("").trim();
        if (!assistantReply) {
          throw new ModelError("模型未返回可显示的回复，请稍后重试。");
        }
        writeLog("info", "assistant", {
          turnId,
          content: summarizeLogText(assistantReply)
        });
        yield { type: "turn_done", text: assistantReply };
      } catch (error) {
        writeLog("error", "error", {
          turnId,
          type: "agent_error",
          ...formatErrorForLog(error)
        });
        if (error instanceof MimiError) {
          yield { type: "turn_error", message: `处理失败：${error.message}` };
        } else {
          yield { type: "turn_error", message: "处理失败：发生了未预期错误，请稍后重试。" };
        }
      }
    } finally {
      release();
    }
  }

  private async *runTurn(inbound: InboundMessage, turnId: string): AsyncIterable<AgentEvent> {
    const messages: ModelMessage[] = [
      { role: "system", content: this.context.prompt },
      ...this.context.messages,
      { role: "user", content: inbound.text }
    ];
    while (true) {
      const pendingToolCalls = new Map<number, PendingToolCall>();
      const responseText: string[] = [];
      const reasoningText: string[] = [];
      for await (const event of this.model.streamChat(messages, this.context.tools.schemas())) {
        if (event.type === "model_thinking_delta" && this.options.enableThinking) {
          reasoningText.push(event.text);
          if (this.options.display.showThinking) {
            yield { type: "thinking_delta", text: event.text };
          }
        } else if (event.type === "model_text_delta") {
          responseText.push(event.text);
        } else if (event.type === "model_tool_call_delta") {
          const pending = pendingToolCalls.get(event.index) ?? {
            id: "",
            name: "",
            arguments: ""
          };
          if (event.callId) {
            pending.id = event.callId;
          }
          if (event.name) {
            pending.name += event.name;
          }
          pending.arguments += event.arguments;
          pendingToolCalls.set(event.index, pending);
        }
      }
      if (!pendingToolCalls.size) {
        const answerText = responseText.join("");
        if (answerText) {
          yield { type: "text_delta", text: answerText };
        }
        return;
      }
      const calls = parsePendingToolCalls(pendingToolCalls);
      messages.push({
        role: "assistant",
        content: responseText.join("") || null,
        ...(this.options.enableThinking && reasoningText.length
          ? { reasoning_content: reasoningText.join("") }
          : {}),
        tool_calls: calls.map(({ call, rawArguments }) => ({
          id: call.callId,
          type: "function" as const,
          function: { name: call.name, arguments: rawArguments }
        }))
      });
      for (const { call, argumentError } of calls) {
        if (this.options.display.showToolCalls) {
          yield { type: "tool_intent", toolName: call.name, intent: formatToolIntent(call) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.callId,
          content: await executeToolCall(this.context.tools, call, turnId, argumentError)
        });
      }
    }
  }
}
