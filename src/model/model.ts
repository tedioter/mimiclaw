export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCallSchema[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCallSchema = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type DeclaredToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelEvent =
  | { type: "model_text_delta"; text: string }
  | { type: "model_thinking_delta"; text: string }
  | {
      type: "model_tool_call_delta";
      index: number;
      callId?: string;
      name?: string;
      arguments: string;
    };

export interface Model {
  streamChat(messages: ModelMessage[], tools: DeclaredToolSchema[]): AsyncIterable<ModelEvent>;
  close(): Promise<void>;
}
