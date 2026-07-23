export type InboundMessage = {
  platform: string;
  text: string;
  messageId?: string;
};

export type OutboundMessage = {
  platform: string;
  text: string;
  replyTo?: string;
  final?: boolean;
};

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_intent"; toolName: string; intent: string }
  | { type: "turn_error"; message: string }
  | { type: "turn_done"; text: string };

export type ToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};
