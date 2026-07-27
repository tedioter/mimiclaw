import * as lark from "@larksuiteoapi/node-sdk";
import crypto from "node:crypto";
import type { MessageBus, OutboundMessage } from "../bus/message-bus.js";
import type { FeishuConfig } from "../config/types.js";
import { ConfigError, PlatformError, errorMessage, errorName } from "../types/errors.js";
import type { AgentEvent } from "../types/events.js";
import { createDeferred, withTimeout } from "../utils/async.js";
import { writeLog } from "../utils/log.js";
import { isRecord } from "../utils/type-guards.js";
import {
  MessageDeduper,
  PlatformAdapter,
  remainingAfterStreamFailure,
  remainingFinalAnswer,
  isActorAllowed,
  type PlatformTextMessage
} from "./base.js";

export type FeishuCard = Record<string, unknown>;

export type FeishuCardStream = {
  update(card: FeishuCard): Promise<void>;
};

export type FeishuInboundMessage = {
  chatType: string;
  contentType: string;
  senderId: string;
  messageId: string;
  text: string;
  chatId: string;
};

interface FeishuChannelLike {
  start(handler: (message: FeishuInboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  stream(
    initial: FeishuCard,
    producer: (stream: FeishuCardStream) => Promise<void>,
    replyTo: string
  ): Promise<void>;
  send(chatId: string, message: PlatformTextMessage): Promise<void>;
}

type ToolInvocation = {
  name: string;
  intent: string;
};

type FeishuCardFactory = () => FeishuCard;

export class FeishuCardBuffer {
  private latest: FeishuCardFactory | undefined;
  private done = false;
  private waiter: (() => void) | undefined;

  constructor(readonly minUpdateIntervalMs = 200) {
    if (!Number.isFinite(minUpdateIntervalMs) || minUpdateIntervalMs < 0) {
      throw new RangeError("飞书卡片更新间隔必须是非负有限数字");
    }
  }

  publish(factory: FeishuCardFactory): void {
    this.latest = factory;
    this.waiter?.();
    this.waiter = undefined;
  }

  finish(): void {
    this.done = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  private takeLatest(): FeishuCardFactory | undefined {
    const latest = this.latest;
    this.latest = undefined;
    return latest;
  }

  async produce(stream: FeishuCardStream): Promise<void> {
    let lastUpdate = 0;
    while (true) {
      if (!this.latest && !this.done) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
      const factory = this.takeLatest();
      if (!factory) {
        if (this.done) {
          return;
        }
        continue;
      }
      const wait = this.minUpdateIntervalMs - (Date.now() - lastUpdate);
      if (!this.done && wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      // 等待 minInterval 后再取一次：吞掉间隔内积压的更新，只发最新卡片，减少 API 调用。
      const newest = this.takeLatest();
      if (newest) {
        await stream.update(newest());
      } else {
        await stream.update(factory());
      }
      lastUpdate = Date.now();
      if (this.done && !this.latest) {
        return;
      }
    }
  }
}

export class FeishuStreamComposer {
  readonly parts: string[] = [];
  readonly answerParts: string[] = [];
  readonly tools: ToolInvocation[] = [];
  private phase?: "thinking" | "answer";
  private publishedPlainAnswer = "";
  finalText = "";

  /** 记录最近一次成功排队发布的最终回答 plain 前缀。 */
  markPublished(): void {
    this.publishedPlainAnswer = this.answerParts.join("");
  }

  getSentPlainAnswer(): string {
    return this.publishedPlainAnswer;
  }

  getComposedPlainAnswer(): string {
    return this.answerParts.join("");
  }

  get text(): string {
    const answer = this.parts.join("");
    if (!this.tools.length) {
      return answer;
    }
    const tools = [
      "**工具调用**",
      ...this.tools.map((tool, index) => `${index + 1}. **${tool.name}**：${tool.intent}`)
    ].join("\n");
    return answer ? `${tools}\n\n---\n\n${answer}` : tools;
  }

  card(): FeishuCard {
    const elements: FeishuCard[] = [];
    if (this.tools.length) {
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: { title: { tag: "plain_text", content: `工具调用（${this.tools.length}）` } },
        elements: [
          {
            tag: "markdown",
            content: this.tools
              .map((tool, index) => `${index + 1}. **${tool.name}**\n${tool.intent}`)
              .join("\n")
          }
        ]
      });
    }
    elements.push({
      tag: "markdown",
      element_id: "answer_markdown",
      content: this.parts.join("") || "正在处理..."
    });
    return {
      schema: "2.0",
      config: { update_multi: true, summary: { content: "" } },
      body: { elements }
    };
  }

  consume(event: AgentEvent): boolean {
    const pieces: string[] = [];
    if (event.type === "thinking_delta") {
      if (this.phase !== "thinking") {
        this.phase = "thinking";
        pieces.push("**思考**\n");
      }
      pieces.push(event.text);
    } else if (event.type === "text_delta") {
      if (this.phase !== "answer") {
        if (this.phase === "thinking") {
          pieces.push("\n\n---\n\n");
        }
        this.phase = "answer";
      }
      pieces.push(event.text);
      this.answerParts.push(event.text);
    } else if (event.type === "tool_intent") {
      // 工具轮旁白不计入最终回答，避免 turn_done 补发时重复拼接。
      this.answerParts.length = 0;
      this.publishedPlainAnswer = "";
      delete this.phase;
      this.tools.push({ name: event.toolName, intent: event.intent });
    } else if (event.type === "turn_error") {
      this.finalText = event.message;
      pieces.push(`\n\n${event.message}`);
    } else if (event.type === "turn_done") {
      this.finalText = event.text;
      const suffix = remainingFinalAnswer(this.answerParts.join(""), event.text);
      if (suffix) {
        pieces.push(suffix);
      }
    }
    this.parts.push(...pieces);
    return Boolean(pieces.length || event.type === "tool_intent");
  }
}

type LarkMessageEvent = {
  message?: {
    chat_type?: string;
    message_type?: string;
    message_id?: string;
    content?: string;
    chat_id?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
    };
  };
};

class FeishuOfficialChannel implements FeishuChannelLike {
  private readonly client: lark.Client;
  private ws: lark.WSClient | undefined;

  constructor(private readonly config: FeishuConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret
    });
  }

  async start(handler: (message: FeishuInboundMessage) => Promise<void>): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event: unknown) => {
        const value = event as LarkMessageEvent;
        let text = "";
        try {
          const content: unknown = JSON.parse(value.message?.content ?? "{}");
          if (!isRecord(content) || typeof content.text !== "string") {
            return;
          }
          text = content.text;
        } catch {
          return;
        }
        await handler({
          chatType: String(value.message?.chat_type ?? ""),
          contentType: String(value.message?.message_type ?? ""),
          senderId: String(
            value.sender?.sender_id?.open_id ?? value.sender?.sender_id?.user_id ?? ""
          ),
          messageId: String(value.message?.message_id ?? ""),
          text,
          chatId: String(value.message?.chat_id ?? "")
        });
      }
    });
    const connectionReady = createDeferred<void>();
    const ws = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      handshakeTimeoutMs: this.config.connectTimeoutSeconds * 1000,
      onReady: () => connectionReady.resolve(undefined),
      onError: (error) => connectionReady.reject(error)
    });
    this.ws = ws;
    try {
      await withTimeout(
        Promise.all([ws.start({ eventDispatcher: dispatcher }), connectionReady.promise]).then(
          () => undefined
        ),
        this.config.connectTimeoutSeconds * 1000,
        "飞书长连接建立超时",
        () => ws.close({ force: true })
      );
    } catch (error) {
      ws.close({ force: true });
      if (this.ws === ws) {
        this.ws = undefined;
      }
      throw new PlatformError(
        `飞书长连接启动失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async stop(): Promise<void> {
    this.ws?.close({ force: true });
    this.ws = undefined;
  }

  async stream(
    initial: FeishuCard,
    producer: (stream: FeishuCardStream) => Promise<void>,
    replyTo: string
  ): Promise<void> {
    const result = await this.client.im.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: "interactive", content: JSON.stringify(initial) }
    });
    if (result.code && result.code !== 0) {
      throw new PlatformError(`飞书卡片发送失败：${result.msg ?? result.code}`);
    }
    const messageId = result.data?.message_id;
    if (!messageId) {
      throw new PlatformError("飞书卡片发送失败：响应缺少 message_id");
    }
    await producer({
      update: async (card) => {
        const patched = await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) }
        });
        if (patched.code && patched.code !== 0) {
          throw new PlatformError(`飞书卡片更新失败：${patched.msg ?? patched.code}`);
        }
      }
    });
  }

  async send(chatId: string, message: PlatformTextMessage): Promise<void> {
    const content = JSON.stringify({ text: message.text });
    const result = message.replyTo
      ? await this.client.im.message.reply({
          path: { message_id: message.replyTo },
          data: { msg_type: "text", content }
        })
      : await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content,
            uuid: crypto.randomUUID()
          }
        });
    if (result.code && result.code !== 0) {
      throw new PlatformError(`飞书消息发送失败：${result.msg ?? result.code}`);
    }
  }
}

export class FeishuAdapter extends PlatformAdapter {
  readonly name = "feishu";
  readonly deduplicator = new MessageDeduper();
  private channel?: FeishuChannelLike;
  private stopping = false;
  private unregisterHandler?: () => void;
  private readonly sendContexts = new Map<
    string,
    {
      chatId: string;
      composer: FeishuStreamComposer;
      buffer: FeishuCardBuffer;
      streamTask: Promise<void>;
      terminalKind?: "turn_done" | "turn_error";
      streamError?: unknown;
    }
  >();

  constructor(
    private readonly bus: MessageBus,
    readonly config: FeishuConfig,
    channel?: FeishuChannelLike
  ) {
    super();
    if (channel) {
      this.channel = channel;
    }
  }

  bindSendLoop(): void {
    this.unregisterHandler ??= this.bus.registerHandler("feishu", (message) =>
      this.handleOutbound(message)
    );
  }

  async start(): Promise<void> {
    if (!this.config.appId.trim() || !this.config.appSecret.trim()) {
      throw new ConfigError("飞书平台缺少 app_id 或 app_secret");
    }
    this.stopping = false;
    this.bindSendLoop();
    this.channel ??= new FeishuOfficialChannel(this.config);
    await this.channel.start((message) => this.receiveMessage(message));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unregisterHandler?.();
    delete this.unregisterHandler;
    this.sendContexts.clear();
    await this.channel?.stop();
    this.stopping = false;
  }

  async receiveMessage(message: FeishuInboundMessage): Promise<void> {
    if (this.stopping) {
      return;
    }
    if (message.chatType !== "p2p" || message.contentType !== "text") {
      return;
    }
    if (!isActorAllowed(message.senderId, this.config.allowedSenderIds)) {
      return;
    }
    if (message.messageId && !this.deduplicator.accept(message.messageId)) {
      return;
    }
    const text = message.text.trim();
    const channel = this.channel;
    if (!text || !message.chatId || !channel || !message.messageId) {
      return;
    }

    const composer = new FeishuStreamComposer();
    const buffer = new FeishuCardBuffer();
    const context = {
      chatId: message.chatId,
      composer,
      buffer,
      streamTask: Promise.resolve() as Promise<void>,
      streamError: undefined as unknown
    };
    context.streamTask = channel
      .stream(composer.card(), (stream) => buffer.produce(stream), message.messageId)
      .catch((error: unknown) => {
        context.streamError = error;
      });
    this.sendContexts.set(message.messageId, context);
    this.bus.publishInboundMessage({
      platform: "feishu",
      text,
      messageId: message.messageId
    });
  }

  private async handleOutbound(message: OutboundMessage): Promise<void> {
    if (!message.messageId) {
      return;
    }
    const context = this.sendContexts.get(message.messageId);
    if (!context) {
      return;
    }
    if (message.event.type === "turn_done") {
      context.terminalKind = "turn_done";
    } else if (message.event.type === "turn_error") {
      context.terminalKind = "turn_error";
    }
    if (context.composer.consume(message.event)) {
      context.composer.markPublished();
      context.buffer.publish(() => context.composer.card());
    }
    if (message.event.type !== "turn_done" && message.event.type !== "turn_error") {
      return;
    }
    await this.finishSend(message.messageId, context);
  }

  private async finishSend(
    messageId: string,
    context: {
      chatId: string;
      composer: FeishuStreamComposer;
      buffer: FeishuCardBuffer;
      streamTask: Promise<void>;
      terminalKind?: "turn_done" | "turn_error";
      streamError?: unknown;
    }
  ): Promise<void> {
    this.sendContexts.delete(messageId);
    context.buffer.finish();
    await context.streamTask;
    const streamError = context.streamError;
    if (!streamError || context.terminalKind !== "turn_done") {
      return;
    }
    const channel = this.channel;
    if (!channel) {
      return;
    }
    writeLog("error", "platform", {
      platform: this.name,
      type: "feishu_stream_error",
      messageId,
      errorName: errorName(streamError),
      content: errorMessage(streamError)
    });
    const remainingAnswer = remainingAfterStreamFailure(
      context.composer.getSentPlainAnswer(),
      context.composer.getComposedPlainAnswer(),
      context.composer.finalText || context.composer.getComposedPlainAnswer()
    );
    if (!remainingAnswer.trim()) {
      return;
    }
    const fallback: PlatformTextMessage = {
      platform: this.name,
      text: `[流式回复中断，以下为剩余回复]\n\n${remainingAnswer}`,
      replyTo: messageId,
      final: true
    };
    try {
      await PlatformAdapter.sendPlatformText(
        (outbound) => channel.send(context.chatId, outbound),
        fallback,
        this.config.maxMessageLength
      );
    } catch (error) {
      writeLog("error", "platform", {
        platform: this.name,
        type: "feishu_fallback_error",
        messageId,
        errorName: errorName(error),
        content: errorMessage(error)
      });
    }
  }
}
