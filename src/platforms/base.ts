import type { OutboundMessage } from "../bus/message-bus.js";
import { sleep } from "../utils/async.js";
import { splitText } from "../utils/message-splitter.js";

export { splitText, takeSplitChunk } from "../utils/message-splitter.js";

function splitOutbound(message: OutboundMessage, limit: number): OutboundMessage[] {
  const chunks = splitText(message.text, limit);
  return chunks.map((text, index) => ({
    ...message,
    text,
    final: Boolean(message.final && index === chunks.length - 1)
  }));
}

export function finalAnswerSuffix(streamedText: string, finalText: string): string {
  if (finalText.startsWith(streamedText)) {
    return finalText.slice(streamedText.length);
  }
  return finalText && finalText !== streamedText ? `\n\n**最终回答**\n${finalText}` : "";
}

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

  static async sendOutbound(
    send: (message: OutboundMessage) => Promise<void>,
    message: OutboundMessage,
    limit: number
  ): Promise<void> {
    for (const chunk of splitOutbound(message, limit)) {
      await PlatformAdapter.sendWithRetry((text) => send({ ...chunk, text }), chunk.text);
    }
  }
}
