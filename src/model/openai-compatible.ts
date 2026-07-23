import OpenAI, { APIConnectionError, APIError } from "openai";
import type { ModelConfig } from "../config/types.js";
import { ModelError } from "../types/errors.js";
import { sleep } from "../utils/async.js";
import { isRecord } from "../utils/type-guards.js";
import type { Model, ModelEvent, ModelMessage, DeclaredToolSchema } from "./model.js";

export class OpenAICompatibleModel implements Model {
  private readonly client: OpenAI;

  constructor(readonly config: ModelConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: config.timeoutSeconds * 1000,
      maxRetries: 0
    });
  }

  async close(): Promise<void> {
    /* OpenAI Node 客户端没有需要主动释放的持久连接 */
  }

  async *streamChat(
    messages: ModelMessage[],
    tools: DeclaredToolSchema[]
  ): AsyncIterable<ModelEvent> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      let emitted = false;
      try {
        for await (const event of this.streamOnce(messages, tools)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (emitted || attempt >= this.config.maxRetries || !this.isRetryable(error)) {
          throw this.wrapError(error);
        }
        await sleep(Math.min(2 ** attempt, 4) * 1000);
      }
    }
  }

  private async *streamOnce(
    messages: ModelMessage[],
    tools: DeclaredToolSchema[]
  ): AsyncIterable<ModelEvent> {
    let stream: AsyncIterable<unknown>;
    try {
      // 内部消息保持供应商无关，只在 SDK 边界转换为 OpenAI 的请求类型。
      stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: true,
        ...(this.config.enableThinking
          ? { extra_body: { thinking: { type: "enabled" as const } } }
          : { temperature: this.config.temperature }),
        ...(tools.length
          ? {
              tools: tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
              tool_choice: "auto" as const
            }
          : {})
      });
    } catch (error) {
      throw this.wrapSdkError(error) ?? error;
    }
    let sawEvent = false;
    for await (const chunk of stream) {
      for (const event of OpenAICompatibleModel.parseChunk(chunk)) {
        sawEvent = true;
        yield event;
      }
    }
    if (!sawEvent) {
      throw new ModelError("模型服务未返回可解析的流式内容");
    }
  }

  private wrapError(error: unknown): ModelError {
    return (
      (error instanceof ModelError ? error : this.wrapSdkError(error)) ??
      new ModelError(`模型请求失败：${String(error)}`, { cause: error })
    );
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof ModelError
      ? error.retryable
      : (this.wrapSdkError(error)?.retryable ?? false);
  }

  private wrapSdkError(error: unknown): ModelError | undefined {
    if (error instanceof APIConnectionError) {
      return new ModelError(`无法连接模型服务：${error.message}`, {
        cause: error,
        retryable: true
      });
    }
    if (error instanceof APIError) {
      const retryable = error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
      return new ModelError(
        `模型服务返回 HTTP ${error.status ?? "未知"}：${String(error.message).slice(0, 2000)}`,
        { cause: error, retryable }
      );
    }
    return undefined;
  }

  static parseChunk(chunk: unknown): ModelEvent[] {
    if (!isRecord(chunk)) {
      return [];
    }
    if (chunk.error) {
      throw new ModelError(`模型服务返回错误：${JSON.stringify(chunk.error).slice(0, 2000)}`);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isRecord(choice)) {
      return [];
    }
    const deltaValue = choice.delta;
    if (!isRecord(deltaValue)) {
      return [];
    }
    const events: ModelEvent[] = [];
    const reasoning = deltaValue.reasoning_content ?? deltaValue.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      events.push({ type: "model_thinking_delta", text: reasoning });
    }
    if (typeof deltaValue.content === "string" && deltaValue.content) {
      events.push({ type: "model_text_delta", text: deltaValue.content });
    }
    if (Array.isArray(deltaValue.tool_calls)) {
      for (const rawCall of deltaValue.tool_calls) {
        if (!isRecord(rawCall)) {
          continue;
        }
        const index = Number(rawCall.index ?? 0);
        if (!Number.isSafeInteger(index) || index < 0) {
          continue;
        }
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        events.push({
          type: "model_tool_call_delta",
          index,
          ...(rawCall.id ? { callId: String(rawCall.id) } : {}),
          ...(fn.name ? { name: String(fn.name) } : {}),
          arguments: String(fn.arguments ?? "")
        });
      }
    }
    return events;
  }
}
