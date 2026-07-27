import { MimiError, ModelError } from "../types/errors.js";
import type { InboundMessage } from "../bus/message-bus.js";
import type { AgentEvent } from "../types/events.js";
import type { PendingToolCall } from "../tools/base.js";
import type { ToolRegistry } from "../tools/toolregistry.js";
import type { Memory } from "../memory/memory.js";
import { AsyncMutexLock } from "../utils/async-mutex-lock.js";
import {
  formatErrorForLog,
  summarizeAssistantReplyLog,
  summarizeLogText,
  writeLog
} from "../utils/log.js";
import { buildTurnId } from "../utils/turn-id.js";
import type { Model, ModelMessage } from "../model/index.js";
import { ModelRuntime } from "../model/runtime.js";
import { buildPromptContext } from "./prompt.js";
import { turnDoneHandler } from "./turn-done-handler.js";
import { executeToolCall, formatToolIntent, parsePendingToolCalls } from "./tool-executor.js";

export class Agent {
  private readonly turnLock = new AsyncMutexLock();
  private closePromise?: Promise<void>;
  /** 当前轮次绑定的对话模型，供 turn_done 压缩复用同一实例。 */
  private lastTurnModel?: Model;

  constructor(
    readonly modelRuntime: ModelRuntime,
    readonly memory: Memory,
    readonly tools: ToolRegistry
  ) {}

  close(): Promise<void> {
    this.closePromise ??= Promise.all([this.tools.close(), this.modelRuntime.close()]).then(
      () => {}
    );
    return this.closePromise;
  }

  async handleTurnDone(inbound: InboundMessage, assistantReply: string): Promise<void> {
    const model = this.lastTurnModel ?? this.modelRuntime.getActive();
    await turnDoneHandler(model, this.memory, inbound, assistantReply);
  }

  async *respond(inbound: InboundMessage): AsyncIterable<AgentEvent> {
    const model = this.modelRuntime.getActive();
    this.lastTurnModel = model;
    const turnId = buildTurnId(inbound);
    writeLog("info", "user", {
      turnId,
      content: summarizeLogText(inbound.text)
    });
    const release = await this.turnLock.acquire();
    const responseText: string[] = [];
    const reasoningText: string[] = [];
    try {
      try {
        const promptContext = buildPromptContext(this.memory);
        const messages: ModelMessage[] = [
          { role: "system", content: promptContext.prompt },
          ...promptContext.messages,
          { role: "user", content: inbound.text }
        ];
        while (true) {
          responseText.length = 0;
          reasoningText.length = 0;
          const pendingToolCalls = new Map<number, PendingToolCall>();
          for await (const event of model.streamChat(messages, this.tools.schemas())) {
            if (event.type === "model_thinking_delta") {
              reasoningText.push(event.text);
              yield { type: "thinking_delta", text: event.text };
            } else if (event.type === "model_text_delta") {
              responseText.push(event.text);
              yield { type: "text_delta", text: event.text };
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
            const assistantReply = responseText.join("").trim();
            if (!assistantReply) {
              throw new ModelError("模型未返回可显示的回复，请稍后重试。");
            }
            writeLog("info", "assistant", {
              turnId,
              content: summarizeAssistantReplyLog(assistantReply)
            });
            yield { type: "turn_done", text: assistantReply };
            return;
          }
          const calls = parsePendingToolCalls(pendingToolCalls);
          const reasoning = reasoningText.join("");
          messages.push({
            role: "assistant",
            content: responseText.join("") || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            tool_calls: calls.map(({ call, rawArguments }) => ({
              id: call.callId,
              type: "function" as const,
              function: { name: call.name, arguments: rawArguments }
            }))
          });
          for (const { call, argumentError, rawArguments } of calls) {
            yield { type: "tool_intent", toolName: call.name, intent: formatToolIntent(call) };
            messages.push({
              role: "tool",
              tool_call_id: call.callId,
              content: await executeToolCall(this.tools, call, turnId, argumentError, rawArguments)
            });
          }
        }
      } catch (error) {
        writeLog("error", "error", {
          turnId,
          type: "agent_error",
          ...formatErrorForLog(error)
        });
        const partialReply = responseText.join("").trim();
        if (partialReply) {
          writeLog("info", "assistant", {
            turnId,
            content: summarizeAssistantReplyLog(partialReply)
          });
          yield { type: "turn_done", text: partialReply };
          return;
        }
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
}
