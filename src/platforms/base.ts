import { sleep } from "../utils/async.js";
import { splitText } from "../utils/message-splitter.js";

export { splitText, takeSplitChunk } from "../utils/message-splitter.js";

/** 平台对外 API 发送的纯文本（分片、降级等）；不经过 MessageBus。 */
export type PlatformTextMessage = {
  platform: string;
  text: string;
  replyTo?: string;
  final?: boolean;
};

function splitPlatformText(message: PlatformTextMessage, limit: number): PlatformTextMessage[] {
  const chunks = splitText(message.text, limit);
  return chunks.map((text, index) => ({
    ...message,
    text,
    final: Boolean(message.final && index === chunks.length - 1)
  }));
}

/** 流式失败后计算剩余正文：仅按已成功发出的 plain 补差（不用 composed 推断「已展示」）。 */
export function remainingAfterStreamFailure(
  sentPlain: string,
  _composedPlain: string,
  finalText: string
): string {
  return remainingFinalAnswer(sentPlain, finalText);
}

/** 计算 final 中尚未以 plain 形式发出的后缀；前缀不一致时不拼「最终回答」全文。 */
export function remainingFinalAnswer(streamedPlain: string, finalText: string): string {
  if (!finalText) {
    return "";
  }
  if (finalText.startsWith(streamedPlain)) {
    return finalText.slice(streamedPlain.length);
  }
  if (!streamedPlain) {
    return finalText;
  }
  return "";
}

/** 有界消息 ID 去重：Set 按插入顺序淘汰最早项（FIFO），重复命中不会 touch。 */
export class MessageDeduper {
  private readonly seen = new Set<string>();

  constructor(readonly capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("消息去重容量必须是正整数");
    }
  }

  accept(messageId: string): boolean {
    if (this.seen.has(messageId)) {
      return false;
    }
    this.seen.add(messageId);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }
}

export function isActorAllowed(actorId: string, allowedIds: ReadonlySet<string>): boolean {
  return !allowedIds.size || allowedIds.has(actorId);
}

export abstract class PlatformAdapter {
  abstract readonly name: string;

  abstract start(): Promise<void>;

  abstract stop(): Promise<void>;

  protected static async sendWithRetry(
    send: (text: string) => Promise<void>,
    text: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await send(text);
        return;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await sleep(2 ** attempt * 1000);
      }
    }
  }

  static async sendPlatformText(
    send: (message: PlatformTextMessage) => Promise<void>,
    message: PlatformTextMessage,
    limit: number
  ): Promise<void> {
    for (const chunk of splitPlatformText(message, limit)) {
      await PlatformAdapter.sendWithRetry((text) => send({ ...chunk, text }), chunk.text);
    }
  }
}
