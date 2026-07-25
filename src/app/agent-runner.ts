import { MessageBus, MessageBusClosedError, type InboundMessage } from "../bus/message-bus.js";
import type { DisplayConfig } from "../config/types.js";
import type { AgentEvent } from "../types/events.js";

export type AgentLoopControl = {
  isActive(): boolean;
  stop(): void;
};

export type AgentResponder = {
  respond(inbound: InboundMessage): AsyncIterable<AgentEvent>;
};

export type TurnEndHandler = (inbound: InboundMessage, assistantReply: string) => Promise<void>;

export function createAgentLoopControl(): AgentLoopControl {
  let active = true;
  return {
    isActive: () => active,
    stop: () => {
      active = false;
    }
  };
}

/** 按展示配置过滤 Agent 事件；Agent 本身始终产出完整事件流。 */
export function shouldPublishAgentEvent(event: AgentEvent, display: DisplayConfig): boolean {
  if (event.type === "thinking_delta") {
    return display.showThinking;
  }
  if (event.type === "tool_intent") {
    return display.showToolCalls;
  }
  return true;
}

export async function runAgentLoop(
  agent: AgentResponder,
  bus: MessageBus,
  control: AgentLoopControl,
  handleTurnEnd?: TurnEndHandler,
  display?: DisplayConfig
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
    let assistantReply: string | undefined;
    for await (const event of agent.respond(inbound)) {
      if (event.type === "turn_done") {
        assistantReply = event.text;
      }
      if (display && !shouldPublishAgentEvent(event, display)) {
        continue;
      }
      bus.publishOutbound({
        platform: inbound.platform,
        event,
        ...(inbound.messageId ? { messageId: inbound.messageId } : {})
      });
    }
    if (assistantReply !== undefined) {
      await handleTurnEnd?.(inbound, assistantReply);
    }
  }
}
