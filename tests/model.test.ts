import { describe, expect, it } from "vitest";
import { OpenAICompatibleModel } from "../src/model/index.js";

describe("模型事件解析", () => {
  it("解析正文、思考和工具增量", () => {
    const events = OpenAICompatibleModel.parseChunk({
      choices: [
        {
          delta: {
            reasoning_content: "思考",
            content: "回答",
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } }
            ]
          }
        }
      ]
    });
    expect(events.map((event) => event.type)).toEqual([
      "model_thinking_delta",
      "model_text_delta",
      "model_tool_call_delta"
    ]);
  });

  it("忽略索引非法的工具调用增量", () => {
    const events = OpenAICompatibleModel.parseChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: "invalid", function: { name: "read", arguments: "{}" } },
              { index: -1, function: { name: "write", arguments: "{}" } }
            ]
          }
        }
      ]
    });
    expect(events).toEqual([]);
  });
});
