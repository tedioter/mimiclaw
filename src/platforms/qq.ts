import {
  QQBot,
  type QQBotInboundMessage,
  type ReplyTarget,
  type StreamSession
} from "@tencent-connect/qqbot-nodejs";
import type { MessageBus, OutboundMessage } from "../bus/message-bus.js";
import type { QQConfig } from "../config/types.js";
import { ConfigError, MimiError, PlatformError, errorMessage, errorName } from "../types/errors.js";
import type { AgentEvent } from "../types/events.js";
import { createDeferred, withTimeout } from "../utils/async.js";
import { writeLog } from "../utils/log.js";
import { takeSplitChunk } from "../utils/message-splitter.js";
import {
  MessageDeduper,
  PlatformAdapter,
  remainingAfterStreamFailure,
  remainingFinalAnswer,
  isActorAllowed,
  type PlatformTextMessage
} from "./base.js";
import type { ModelControl, ModelInfo } from "./model-control.js";

export type QQInboundMessage = {
  kind: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  content: string;
  messageId: string;
  replyTarget: ReplyTarget;
};

export type QQStreamLike = {
  update(fullText: string): Promise<void>;
  complete(): Promise<unknown>;
  cancel(): void;
};

type QQStreamClientLike = {
  openStream(target: ReplyTarget): QQStreamLike;
};

export interface QQClientLike extends QQStreamClientLike {
  start(onMessage: (message: QQInboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: ReplyTarget, content: string): Promise<void>;
}

export class QQStreamSession {
  private static readonly thinkingOpen = "\n\n```text\n🤔: ";
  private static readonly thinkingClose = "\n```";
  private static readonly answerSeparator = "\n\n---\n\n";

  private pending: string[] = [];
  private pendingAnswerLength = 0;
  private sentPlainAnswer = "";
  private answerParts: string[] = [];
  private phase: "thinking" | "answer" | undefined;
  private started = false;
  private closed = false;
  private lastSentAt = 0;

  constructor(
    private readonly sendStream: (text: string, final: boolean) => Promise<void>,
    private readonly sendStatic: (text: string) => Promise<void>,
    private readonly maxLength: number,
    private readonly minIntervalMs = 800,
    private readonly minChunkChars = 80
  ) {
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
      throw new RangeError("QQ 消息长度上限必须是正整数");
    }
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError("QQ 流式发送间隔必须是非负有限数字");
    }
    if (!Number.isSafeInteger(minChunkChars) || minChunkChars <= 0) {
      throw new RangeError("QQ 流式发送最小片段必须是正整数");
    }
  }

  async consume(event: AgentEvent): Promise<void> {
    if (this.closed) {
      return;
    }
    if (event.type === "thinking_delta") {
      if (this.phase !== "thinking") {
        this.phase = "thinking";
        this.pending.push(QQStreamSession.thinkingOpen);
      }
      this.pending.push(event.text);
      await this.flushDue();
    } else if (event.type === "text_delta") {
      if (this.phase !== "answer") {
        if (this.phase === "thinking") {
          this.pending.push(QQStreamSession.thinkingClose);
          this.pending.push(QQStreamSession.answerSeparator);
        }
        this.phase = "answer";
      }
      this.pending.push(event.text);
      this.pendingAnswerLength += event.text.length;
      this.answerParts.push(event.text);
      await this.flushDue();
    } else if (event.type === "tool_intent") {
      if (this.phase === "thinking") {
        this.pending.push(QQStreamSession.thinkingClose);
        this.pending.push("\n\n");
      }
      // 工具轮旁白不计入最终回答，避免 turn_done 补发时重复拼接。
      this.answerParts = [];
      this.sentPlainAnswer = "";
      this.phase = undefined;
      this.pending.push(`\n\n> 工具调用：${event.toolName}：${event.intent}\n\n`);
      await this.flush();
    } else if (event.type === "turn_error") {
      this.pending.push(`\n\n${event.message}`);
      await this.finish();
    } else if (event.type === "turn_done") {
      const suffix = remainingFinalAnswer(this.answerParts.join(""), event.text);
      if (suffix) {
        this.pending.push(suffix);
        this.pendingAnswerLength += suffix.length;
      }
      await this.finish();
      this.sentPlainAnswer = event.text;
    }
  }

  private async flushDue(): Promise<void> {
    if (
      this.pending.join("").length >= this.minChunkChars &&
      Date.now() - this.lastSentAt >= this.minIntervalMs
    ) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const text = this.pending.join("");
    if (!text) {
      return;
    }
    this.pending = [];
    this.pendingAnswerLength = 0;
    const answerSnapshot = this.answerParts.join("");
    await this.sendStream(text, false);
    this.sentPlainAnswer = answerSnapshot;
    this.started = true;
    this.lastSentAt = Date.now();
  }

  private async finish(): Promise<void> {
    const text = this.pending.join("");
    this.pending = [];
    this.pendingAnswerLength = 0;
    if (!this.started && text.length <= this.maxLength) {
      await this.sendStatic(text || "任务已处理完成。");
      if (this.answerParts.length) {
        this.sentPlainAnswer = this.answerParts.join("");
      }
    } else {
      const answerSnapshot = this.answerParts.join("");
      await this.sendStream(text, true);
      this.sentPlainAnswer = answerSnapshot;
    }
    this.closed = true;
  }

  /** 已通过流式通道成功发出的最终回答 plain 文本（不含思考块与工具行）。 */
  getSentPlainAnswer(): string {
    return this.sentPlainAnswer;
  }

  /** 当前轮已收到的最终回答 plain 文本（text_delta 累计，不含思考块与工具行）。 */
  getComposedPlainAnswer(): string {
    return this.answerParts.join("");
  }
}

type QQSendContext = {
  messageId: string;
  replyTarget: ReplyTarget;
  streamSender: QQSdkStreamSender;
  session: QQStreamSession;
  finalText: string;
  terminalKind?: "turn_done" | "turn_error";
  streamError?: unknown;
};

class QQSdkStreamSender {
  private stream: QQStreamLike | undefined;
  private fullText = "";

  constructor(
    private readonly client: QQStreamClientLike,
    private readonly target: ReplyTarget,
    private readonly maxLength: number
  ) {
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
      throw new RangeError("QQ 流消息长度上限必须是正整数");
    }
  }

  async push(text: string, final: boolean): Promise<void> {
    let remaining = text;
    while (true) {
      const combined = this.fullText + remaining;
      remaining = "";
      if (!combined) {
        if (final) {
          await this.completeCurrent();
        }
        return;
      }
      if (combined.length <= this.maxLength) {
        this.fullText = combined;
        this.stream ??= this.client.openStream(this.target);
        await this.stream.update(this.fullText);
        if (final) {
          await this.completeCurrent();
        }
        return;
      }
      const { chunk, rest } = takeSplitChunk(combined, this.maxLength);
      this.stream ??= this.client.openStream(this.target);
      await this.stream.update(chunk);
      await this.completeCurrent();
      this.fullText = "";
      remaining = rest;
      if (!remaining) {
        return;
      }
    }
  }

  private async completeCurrent(): Promise<void> {
    if (!this.stream) {
      return;
    }
    await this.stream.complete();
    this.stream = undefined;
    this.fullText = "";
  }

  cancel(): void {
    this.stream?.cancel();
    this.stream = undefined;
    this.fullText = "";
  }
}

function isNoisyQQSdkInfoLog(message: string): boolean {
  return /\[qqbot:api\]\s*<<<\s*Status:\s*200\s+OK\b/.test(message);
}

function logQQSdkInfo(message: string, metadata?: Record<string, unknown>): void {
  if (isNoisyQQSdkInfoLog(message)) {
    return;
  }
  console.info(JSON.stringify({ level: "info", platform: "qq", message, ...metadata }));
}

class QQOfficialClient implements QQClientLike {
  private readonly bot: QQBot;
  private readonly abortController = new AbortController();
  private runner: Promise<void> | undefined;

  constructor(private readonly config: QQConfig) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      markdownSupport: config.markdownSupport,
      tokenPrefetch: "sync",
      ...(config.sandbox ? { baseUrl: "https://sandbox.api.sgroup.qq.com" } : {}),
      logger: {
        info: (message, metadata) => logQQSdkInfo(String(message), metadata),
        error: (message, metadata) =>
          console.error(JSON.stringify({ level: "error", platform: "qq", message, ...metadata })),
        warn: (message, metadata) =>
          console.warn(JSON.stringify({ level: "warn", platform: "qq", message, ...metadata }))
      }
    });
  }

  async start(onMessage: (message: QQInboundMessage) => Promise<void>): Promise<void> {
    const connectionReady = createDeferred<void>();
    let ready = false;

    this.bot.on("ready", () => {
      ready = true;
      connectionReady.resolve(undefined);
    });
    this.bot.on("error", (error) => {
      if (!ready) {
        connectionReady.reject(error);
      } else {
        console.error(
          JSON.stringify({
            level: "error",
            platform: "qq",
            message: "QQ SDK 运行异常",
            error: errorMessage(error)
          })
        );
      }
    });
    this.bot.on("message", async (_context, message: QQBotInboundMessage) => {
      await onMessage({
        kind: message.kind,
        senderId: message.senderId,
        content: message.content,
        messageId: message.messageId,
        replyTarget: message.replyTarget
      });
    });

    this.runner = this.bot.start(this.abortController.signal).catch((error: unknown) => {
      if (!ready) {
        connectionReady.reject(error);
      } else {
        console.error(
          JSON.stringify({
            level: "error",
            platform: "qq",
            message: "QQ SDK 连接异常",
            error: errorMessage(error)
          })
        );
      }
    });
    try {
      await withTimeout(
        connectionReady.promise,
        this.config.connectTimeoutSeconds * 1000,
        "QQ 官方机器人连接超时"
      );
    } catch (error) {
      await this.stop();
      throw new PlatformError(errorMessage(error), { cause: error });
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    this.bot.stop();
    await this.runner;
    this.runner = undefined;
  }

  async sendMessage(target: ReplyTarget, content: string): Promise<void> {
    try {
      await this.bot.sendText(target, content);
    } catch (error) {
      throw new PlatformError(`QQ 官方机器人消息发送失败：${errorMessage(error)}`, {
        cause: error
      });
    }
  }

  openStream(target: ReplyTarget): StreamSession {
    return this.bot.openStream({ target });
  }
}

export class QQAdapter extends PlatformAdapter {
  readonly name = "qq";
  readonly deduplicator = new MessageDeduper();
  private client: QQClientLike | undefined;
  private stopping = false;
  private unregisterHandler?: () => void;
  private readonly sendContexts = new Map<string, QQSendContext>();
  private readonly modelControl: ModelControl | undefined;

  constructor(
    private readonly bus: MessageBus,
    readonly config: QQConfig,
    client?: QQClientLike,
    modelControl?: ModelControl
  ) {
    super();
    this.modelControl = modelControl;
    if (client) {
      this.client = client;
    }
  }

  bindSendLoop(): void {
    this.unregisterHandler ??= this.bus.registerHandler("qq", (message) =>
      this.handleOutbound(message)
    );
  }

  async start(): Promise<void> {
    if (!this.config.appId.trim() || !this.config.appSecret.trim()) {
      throw new ConfigError("QQ 平台缺少 app_id 或 app_secret");
    }
    this.stopping = false;
    this.bindSendLoop();
    this.client ??= new QQOfficialClient(this.config);
    await this.client.start((message) => this.receiveMessage(message));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unregisterHandler?.();
    delete this.unregisterHandler;
    this.sendContexts.clear();
    await this.client?.stop();
    this.stopping = false;
  }

  async receiveMessage(message: QQInboundMessage): Promise<void> {
    if (this.stopping) {
      return;
    }
    if (message.kind !== "c2c") {
      return;
    }
    if (!isActorAllowed(message.senderId, this.config.allowedOpenids)) {
      return;
    }
    if (message.messageId && !this.deduplicator.accept(message.messageId)) {
      return;
    }
    const text = message.content.trim();
    const client = this.client;
    if (!text || !client || !message.messageId) {
      return;
    }
    const modelCommand = this.parseModelCommand(text);
    if (modelCommand) {
      await this.handleModelCommand(client, message.replyTarget, modelCommand);
      return;
    }

    const streamSender = new QQSdkStreamSender(
      client,
      message.replyTarget,
      this.config.maxMessageLength
    );
    const context: QQSendContext = {
      messageId: message.messageId,
      replyTarget: message.replyTarget,
      streamSender,
      session: new QQStreamSession(
        (content, final) => streamSender.push(content, final),
        (content) =>
          PlatformAdapter.sendPlatformText(
            (outbound) =>
              QQAdapter.sendWithRetry(
                (current) => client.sendMessage(message.replyTarget, current),
                outbound.text
              ),
            { platform: this.name, text: content },
            this.config.maxMessageLength
          ),
        this.config.maxMessageLength
      ),
      finalText: ""
    };
    this.sendContexts.set(message.messageId, context);
    this.bus.publishInboundMessage({
      platform: "qq",
      text,
      messageId: message.messageId
    });
  }

  private parseModelCommand(text: string): string[] | undefined {
    const parts = text.split(/\s+/);
    const command = parts[0]?.toLowerCase();
    if (command !== "/model") {
      return undefined;
    }
    return parts.slice(1);
  }

  private async handleModelCommand(
    client: QQClientLike,
    replyTarget: ReplyTarget,
    args: string[]
  ): Promise<void> {
    const modelControl = this.modelControl;
    if (!modelControl) {
      await this.sendModelCommandReply(client, replyTarget, "当前未启用模型切换功能。");
      return;
    }

    const models = modelControl.listModels();
    const first = args[0]?.toLowerCase();
    if (!first || first === "list") {
      await this.sendModelCommandReply(client, replyTarget, this.formatModelList(models));
      return;
    }

    let id = args[0];
    if (first === "use" || first === "switch") {
      id = args[1];
    }
    if (!id) {
      await this.sendModelCommandReply(
        client,
        replyTarget,
        "用法：/model [list] | /model <id> | /model switch <id>"
      );
      return;
    }
    if (/^\d+$/.test(id)) {
      const selected = models[Number(id) - 1];
      if (!selected) {
        await this.sendModelCommandReply(
          client,
          replyTarget,
          `无效序号：${id}，当前共 ${models.length} 个模型 runtime。`
        );
        return;
      }
      id = selected.id;
    }

    try {
      modelControl.switchModel(id);
      const active = modelControl.listModels().find((item) => item.active);
      await this.sendModelCommandReply(
        client,
        replyTarget,
        `已切换为 ${active?.id ?? id}（${active?.model ?? id}），下一条私聊消息生效。`
      );
    } catch (error) {
      const knownIds = models.map((item) => item.id).join("、");
      const reason = error instanceof MimiError ? error.message : "切换模型失败";
      await this.sendModelCommandReply(client, replyTarget, `${reason}（可用：${knownIds}）`);
    }
  }

  private formatModelList(models: ModelInfo[]): string {
    if (!models.length) {
      return "当前未配置模型 runtime。";
    }
    const lines = models.map((item) => {
      const marker = item.active ? "* " : "  ";
      return `${marker}${item.id}: ${item.model} (${item.baseUrl})`;
    });
    return `当前模型：\n${lines.join("\n")}\n\n切换用法：/model <id>`;
  }

  private async sendModelCommandReply(
    client: QQClientLike,
    replyTarget: ReplyTarget,
    text: string
  ): Promise<void> {
    try {
      await PlatformAdapter.sendPlatformText(
        (outbound) =>
          QQAdapter.sendWithRetry(
            (current) => client.sendMessage(replyTarget, current),
            outbound.text
          ),
        { platform: this.name, text },
        this.config.maxMessageLength
      );
    } catch (error) {
      writeLog("error", "platform", {
        platform: this.name,
        type: "qq_model_command_error",
        errorName: errorName(error),
        content: errorMessage(error)
      });
    }
  }

  private async handleOutbound(message: OutboundMessage): Promise<void> {
    if (!message.messageId) {
      return;
    }
    const context = this.sendContexts.get(message.messageId);
    if (!context) {
      return;
    }
    const event = message.event;
    if (event.type === "turn_done") {
      context.finalText = event.text;
      context.terminalKind = "turn_done";
    } else if (event.type === "turn_error") {
      context.finalText = event.message;
      context.terminalKind = "turn_error";
    }
    if (!context.streamError) {
      try {
        await context.session.consume(event);
      } catch (error) {
        context.streamError = error;
        context.streamSender.cancel();
      }
    }
    if (event.type !== "turn_done" && event.type !== "turn_error") {
      return;
    }
    await this.finishSend(message.messageId, context);
  }

  private async finishSend(messageId: string, context: QQSendContext): Promise<void> {
    this.sendContexts.delete(messageId);
    if (!context.streamError) {
      return;
    }
    const client = this.client;
    if (!client) {
      return;
    }
    if (context.terminalKind !== "turn_done") {
      return;
    }
    writeLog("error", "platform", {
      platform: this.name,
      type: "qq_stream_error",
      messageId,
      errorName: errorName(context.streamError),
      content: errorMessage(context.streamError)
    });
    const remainingAnswer = remainingAfterStreamFailure(
      context.session.getSentPlainAnswer(),
      context.session.getComposedPlainAnswer(),
      context.finalText
    );
    if (!remainingAnswer.trim()) {
      return;
    }
    const fallback: PlatformTextMessage = {
      platform: this.name,
      text: `[流式回复中断，以下为剩余回复]\n\n${remainingAnswer || "处理失败：没有生成可发送的回复。"}`,
      final: true
    };
    try {
      await PlatformAdapter.sendPlatformText(
        (outbound) => client.sendMessage(context.replyTarget, outbound.text),
        fallback,
        this.config.maxMessageLength
      );
    } catch (error) {
      writeLog("error", "platform", {
        platform: this.name,
        type: "qq_fallback_error",
        messageId,
        errorName: errorName(error),
        content: errorMessage(error)
      });
      throw error;
    }
  }
}
