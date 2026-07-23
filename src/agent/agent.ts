import type { AppConfig } from "../config/types.js";
import { MimiError, ModelError, errorMessage, errorName } from "../types/errors.js";
import type { AgentEvent, InboundMessage } from "../types/events.js";
import { commitTurn } from "../memory/commit-turn.js";
import { buildPrompt } from "./prompt.js";
import type { Memory } from "../memory/memory.js";
import type { PendingToolCall } from "../tools/base.js";
import type { ToolRegistry } from "../tools/toolregistry.js";
import { AsyncMutexLock } from "../utils/async-mutex-lock.js";
import { formatErrorForLog, summarizeLogText, writeLog } from "../utils/log.js";
import { buildTurnId } from "../utils/turn-id.js";
import type { Model } from "../model/index.js";
import { executeToolCall, formatToolIntent, parsePendingToolCalls } from "./tool-executor.js";

export class Agent {
  private readonly turnLock = new AsyncMutexLock();
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly model: Model,
    private readonly memory: Memory,
    private readonly tools: ToolRegistry
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
        try {
          await commitTurn(
            this.config.memory,
            this.model,
            this.memory,
            inbound,
            assistantReply,
            turnId
          );
        } catch (error) {
          writeLog("error", "memory", {
            turnId,
            type: "memory_commit_error",
            errorName: errorName(error),
            content: summarizeLogText(errorMessage(error))
          });
        }
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
    const messages = buildPrompt(this.memory, inbound.text);
    while (true) {
      const pendingToolCalls = new Map<number, PendingToolCall>();
      const responseText: string[] = [];
      const reasoningText: string[] = [];
      for await (const event of this.model.streamChat(messages, this.tools.schemas())) {
        if (event.type === "model_thinking_delta" && this.config.model.enableThinking) {
          reasoningText.push(event.text);
          if (this.config.display.showThinking) {
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
        ...(this.config.model.enableThinking && reasoningText.length
          ? { reasoning_content: reasoningText.join("") }
          : {}),
        tool_calls: calls.map(({ call, rawArguments }) => ({
          id: call.callId,
          type: "function" as const,
          function: { name: call.name, arguments: rawArguments }
        }))
      });
      for (const { call, argumentError } of calls) {
        if (this.config.display.showToolCalls) {
          yield { type: "tool_intent", toolName: call.name, intent: formatToolIntent(call) };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.callId,
          content: await executeToolCall(this.tools, call, turnId, argumentError)
        });
      }
    }
  }
}
