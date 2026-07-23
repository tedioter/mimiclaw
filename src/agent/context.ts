import type { ModelMessage } from "../model/index.js";
import type { ToolRegistry } from "../tools/toolregistry.js";

export type AgentContext = {
  prompt: string;
  messages: ModelMessage[];
  readonly tools: ToolRegistry;
};

export function createAgentContext(
  prompt: string,
  messages: ModelMessage[],
  tools: ToolRegistry
): AgentContext {
  return {
    prompt,
    messages,
    tools
  };
}
