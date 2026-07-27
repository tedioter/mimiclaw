import type { AgentEvent } from "../types/events.js";

/** 平台 → Agent */
export type InboundMessage = {
  platform: string;
  text: string;
  messageId?: string;
};

/** Agent → 平台（Agent 事件流） */
export type OutboundMessage = {
  platform: string;
  event: AgentEvent;
  messageId?: string;
};

/** 某条 platform 路由上的出站处理函数。 */
type OutboundRouteHandler = (message: OutboundMessage) => void | Promise<void>;

export class MessageBusClosedError extends Error {
  constructor() {
    super("MessageBus 已关闭");
    this.name = "MessageBusClosedError";
  }
}

type Waiter<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export class MessageBus {
  private readonly inboundQueue: InboundMessage[] = [];
  private readonly inboundWaiters: Array<Waiter<InboundMessage>> = [];
  private readonly outboundQueue: OutboundMessage[] = [];
  private readonly outboundWaiters: Array<Waiter<OutboundMessage>> = [];
  /** platform → 该平台的出站路由处理函数列表。 */
  private readonly outboundRoutes = new Map<string, OutboundRouteHandler[]>();
  private closed = false;

  publishInboundMessage(message: InboundMessage): void {
    if (this.closed) {
      return;
    }
    const waiter = this.inboundWaiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.inboundQueue.push(message);
  }

  consumeInboundMessage(): Promise<InboundMessage> {
    if (this.closed) {
      return Promise.reject(new MessageBusClosedError());
    }
    const queued = this.inboundQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      this.inboundWaiters.push({ resolve, reject });
    });
  }

  publishOutboundMessage(message: OutboundMessage): void {
    if (this.closed) {
      return;
    }
    const waiter = this.outboundWaiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.outboundQueue.push(message);
  }

  private waitOutboundMessage(): Promise<OutboundMessage> {
    if (this.closed) {
      return Promise.reject(new MessageBusClosedError());
    }
    const queued = this.outboundQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      this.outboundWaiters.push({ resolve, reject });
    });
  }

  /** 注册 platform 的 handler；返回取消注册的函数。 */
  registerHandler(platform: string, handler: OutboundRouteHandler): () => void {
    const handlers = this.outboundRoutes.get(platform) ?? [];
    handlers.push(handler);
    this.outboundRoutes.set(platform, handlers);
    return () => {
      const list = this.outboundRoutes.get(platform);
      if (!list) {
        return;
      }
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
      if (!list.length) {
        this.outboundRoutes.delete(platform);
      }
    };
  }

  async dispatchHandlers(): Promise<void> {
    while (!this.closed) {
      let message: OutboundMessage;
      try {
        message = await this.waitOutboundMessage();
      } catch (error) {
        if (error instanceof MessageBusClosedError) {
          return;
        }
        throw error;
      }
      const handlers = this.outboundRoutes.get(message.platform) ?? [];
      await Promise.all(handlers.map((handler) => handler(message)));
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const closedError = new MessageBusClosedError();
    for (const waiter of this.inboundWaiters.splice(0)) {
      waiter.reject(closedError);
    }
    for (const waiter of this.outboundWaiters.splice(0)) {
      waiter.reject(closedError);
    }
  }
}
