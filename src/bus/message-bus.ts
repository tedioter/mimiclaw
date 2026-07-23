import type { AgentEvent, InboundMessage } from "../types/events.js";

export type BusOutboundMessage = {
  platform: string;
  event: AgentEvent;
  messageId?: string;
};

/** 某条 platform 路由上的出站处理函数。 */
export type OutboundRouteHandler = (message: BusOutboundMessage) => void | Promise<void>;

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
  private readonly outboundQueue: BusOutboundMessage[] = [];
  private readonly outboundWaiters: Array<Waiter<BusOutboundMessage>> = [];
  /** platform → 该平台的出站路由处理函数列表。 */
  private readonly outboundRoutes = new Map<string, OutboundRouteHandler[]>();
  private closed = false;

  publishInbound(message: InboundMessage): void {
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

  consumeInbound(): Promise<InboundMessage> {
    if (this.closed) {
      return Promise.reject(new MessageBusClosedError());
    }
    //.shift()这个方法在数组中移除第一个元素，并返回被移除的元素。
    const queued = this.inboundQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      this.inboundWaiters.push({ resolve, reject });
    });
  }

  publishOutbound(message: BusOutboundMessage): void {
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

  private waitOutbound(): Promise<BusOutboundMessage> {
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
      let message: BusOutboundMessage;
      try {
        message = await this.waitOutbound();
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
