import { MessageBus, MessageBusClosedError } from "../bus/message-bus.js";
import type { AgentEvent, InboundMessage } from "../types/events.js";

export type AgentLoopControl = {
  isActive(): boolean;
  stop(): void;
};

export type AgentResponder = {
  respond(inbound: InboundMessage): AsyncIterable<AgentEvent>;
};

export function createAgentLoopControl(): AgentLoopControl {
  let active = true;
  return {
    isActive: () => active,
    stop: () => {
      active = false;
    }
  };
}

export async function runAgentLoop(
  agent: AgentResponder,
  bus: MessageBus,
  control: AgentLoopControl
): Promise<void> {
  while (control.isActive()) {
    let inbound;
    try {
      inbound = await bus.consumeInbound();
    } catch (error) {
      if (error instanceof MessageBusClosedError) {
        return;
      }
      throw error;
    }
    for await (const event of agent.respond(inbound)) {
      bus.publishOutbound({
        platform: inbound.platform,
        event,
        ...(inbound.messageId ? { messageId: inbound.messageId } : {})
      });
    }
  }
}
