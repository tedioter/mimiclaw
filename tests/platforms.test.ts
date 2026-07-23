import { afterEach, describe, expect, it } from "vitest";
import { createAgentLoopControl, runAgentLoop } from "../src/app/agent-runner.js";
import { MessageBus } from "../src/bus/message-bus.js";
import { MessageDeduper, finalAnswerSuffix } from "../src/platforms/base.js";
import { FeishuCardBuffer, FeishuStreamComposer } from "../src/platforms/feishu.js";
import type { AgentEvent, InboundMessage } from "../src/types/events.js";
import { createDeferred } from "../src/utils/async.js";
import { splitText } from "../src/utils/message-splitter.js";
import {
  QQAdapter,
  QQStreamSession,
  type QQClientLike,
  type QQInboundMessage,
  type QQStreamLike
} from "../src/platforms/qq.js";
import { cleanupTemporaryDirectories, makeConfig, temporaryDirectory } from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

async function driveBusTurn(
  bus: MessageBus,
  adapter: QQAdapter,
  message: QQInboundMessage,
  respond: (inbound: InboundMessage) => AsyncIterable<AgentEvent>
): Promise<void> {
  const done = createDeferred<void>();
  const unroute = bus.registerHandler("qq", async (outbound) => {
    if (outbound.event.type === "turn_done" || outbound.event.type === "turn_error") {
      done.resolve(undefined);
    }
  });
  const loopControl = createAgentLoopControl();
  const agentLoop = runAgentLoop({ respond }, bus, loopControl);
  const dispatchLoop = bus.dispatchHandlers();
  try {
    adapter.bindSendLoop();
    await adapter.receiveMessage(message);
    await done.promise;
  } finally {
    loopControl.stop();
    await adapter.stop();
    bus.close();
    unroute();
    await Promise.allSettled([agentLoop, dispatchLoop]);
  }
}

describe("平台通用行为", () => {
  it("长消息分段不丢内容", () => {
    const text = `第一段。\n${"甲".repeat(120)}\n最后一段。`;
    const chunks = splitText(text, 40);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("不会把 Unicode 代理项拆到不同消息", () => {
    const chunks = splitText("😀a", 1);
    expect(chunks).toEqual(["😀", "a"]);
    expect(chunks.join("")).toBe("😀a");
  });

  it("分段上限处的换行不会产生超长片段", () => {
    const chunks = splitText(`${"甲".repeat(39)}\n乙`, 40);
    expect(chunks).toEqual([`${"甲".repeat(39)}\n`, "乙"]);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  });

  it("优先在段落边界分段且避开代码围栏内部", () => {
    const code = ["```ts", "const a = 1;", "const b = 2;", "```"].join("\n");
    const text = `${"段落一。".repeat(8)}\n\n${code}\n\n${"段落二。".repeat(8)}`;
    const chunks = splitText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.match(/^```/gm) ?? [];
      expect(fences.length % 2).toBe(0);
    }
    const withoutRepair = chunks.join("").includes("```ts\nconst a");
    expect(withoutRepair || chunks.some((chunk) => chunk.includes("```ts"))).toBe(true);
  });

  it("切在代码围栏内时会闭合并在下一段重开", () => {
    const body = "x".repeat(30);
    const text = `\`\`\`js\n${body}\n\`\`\``;
    const chunks = splitText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith("\n```")).toBe(true);
    expect(chunks[1]?.startsWith("```js\n")).toBe(true);
    for (const chunk of chunks) {
      const opens = chunk.match(/^```/gm) ?? [];
      expect(opens.length % 2).toBe(0);
    }
  });

  it("切在行内加粗或代码中时会闭合并在下一段重开", () => {
    const bold = `说明：**${"重要内容".repeat(20)}**。`;
    const boldChunks = splitText(bold, 30);
    expect(boldChunks[0]).toMatch(/\*\*$/);
    expect(boldChunks[1]).toMatch(/^\*\*/);

    const code = `执行：\`${"node --version ".repeat(10)}\`。`;
    const codeChunks = splitText(code, 30);
    expect(codeChunks[0]).toMatch(/`$/);
    expect(codeChunks[1]).toMatch(/^`/);
  });

  it("流式正文只补齐缺失的最终内容", () => {
    expect(finalAnswerSuffix("已有", "已有补充")).toBe("补充");
    expect(finalAnswerSuffix("旧正文", "新正文")).toBe("\n\n**最终回答**\n新正文");
    expect(finalAnswerSuffix("完整", "完整")).toBe("");
  });

  it("拒绝无效的消息分段上限", () => {
    expect(() => splitText("内容", 0)).toThrow("消息分段上限必须是正整数");
    expect(() => splitText("内容", 1.5)).toThrow("消息分段上限必须是正整数");
  });

  it("消息编号按容量去重", () => {
    const deduplicator = new MessageDeduper(2);
    expect(deduplicator.accept("1")).toBe(true);
    expect(deduplicator.accept("1")).toBe(false);
    deduplicator.accept("2");
    deduplicator.accept("3");
    expect(deduplicator.accept("1")).toBe(true);
  });

  it("拒绝无效的消息去重容量", () => {
    expect(() => new MessageDeduper(-1)).toThrow("消息去重容量必须是正整数");
    expect(() => new MessageDeduper(Number.NaN)).toThrow("消息去重容量必须是正整数");
  });

  it("拒绝无效的 QQ 流式参数", () => {
    const send = async (): Promise<void> => undefined;
    expect(() => new QQStreamSession(send, send, 0)).toThrow("QQ 消息长度上限必须是正整数");
    expect(() => new QQStreamSession(send, send, 100, -1)).toThrow(
      "QQ 流式发送间隔必须是非负有限数字"
    );
  });

  it("飞书卡片保留最新快照", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const buffer = new FeishuCardBuffer(0);
    buffer.publish(() => ({ version: 1 }));
    buffer.publish(() => ({ version: 2 }));
    buffer.finish();
    await buffer.produce({
      update: async (card) => {
        updates.push(card);
      }
    });
    expect(updates).toEqual([{ version: 2 }]);
  });

  it("拒绝无效的飞书卡片更新间隔", () => {
    expect(() => new FeishuCardBuffer(-1)).toThrow("飞书卡片更新间隔必须是非负有限数字");
  });

  it("飞书正文不会重复最终回答", () => {
    const composer = new FeishuStreamComposer();
    composer.consume({ type: "text_delta", text: "最终" });
    composer.consume({ type: "text_delta", text: "回答" });
    composer.consume({ type: "turn_done", text: "最终回答" });
    expect(composer.text).toBe("最终回答");
  });
});

class FakeQQClient implements QQClientLike {
  readonly sent: string[] = [];
  readonly streams: Array<{ updates: string[]; completed: boolean }> = [];
  private updateCount = 0;

  constructor(
    private readonly failStream = false,
    private readonly failAfterUpdates = Number.POSITIVE_INFINITY
  ) {}

  async start(_onMessage: (message: QQInboundMessage) => Promise<void>): Promise<void> {}

  async stop(): Promise<void> {}

  async sendMessage(_target: QQInboundMessage["replyTarget"], content: string): Promise<void> {
    this.sent.push(content);
  }

  openStream(_target: QQInboundMessage["replyTarget"]): QQStreamLike {
    const record = { updates: [] as string[], completed: false };
    this.streams.push(record);
    return {
      update: async (fullText) => {
        if (this.failStream || this.updateCount >= this.failAfterUpdates) {
          throw new Error("模拟流式发送失败");
        }
        this.updateCount += 1;
        record.updates.push(fullText);
      },
      complete: async () => {
        record.completed = true;
      },
      cancel: () => undefined
    };
  }
}

function qqMessage(): QQInboundMessage {
  return {
    kind: "c2c",
    senderId: "openid",
    content: "你好",
    messageId: "message-1",
    replyTarget: { scope: "c2c", targetId: "openid", msgId: "message-1" }
  };
}

describe("QQ 官方 SDK 适配", () => {
  it("短回复使用 SDK 普通消息接口", async () => {
    const root = temporaryDirectory();
    const client = new FakeQQClient();
    const bus = new MessageBus();
    const adapter = new QQAdapter(bus, makeConfig(root).platform.qq, client);
    await driveBusTurn(bus, adapter, qqMessage(), async function* () {
      yield { type: "text_delta", text: "官方 SDK 回复" };
      yield { type: "turn_done", text: "官方 SDK 回复" };
    });
    expect(client.sent).toEqual(["官方 SDK 回复"]);
    expect(client.streams).toHaveLength(0);
  });

  it("长回复通过 SDK 流会话发送累计全文并完成", async () => {
    const root = temporaryDirectory();
    const client = new FakeQQClient();
    const config = makeConfig(root).platform.qq;
    const longText = "甲".repeat(80);
    const bus = new MessageBus();
    const adapter = new QQAdapter(bus, config, client);
    await driveBusTurn(bus, adapter, qqMessage(), async function* () {
      yield { type: "text_delta", text: longText };
      yield { type: "tool_intent", toolName: "read", intent: "读取文件" };
      yield { type: "text_delta", text: "最终回答" };
      yield { type: "turn_done", text: `${longText}最终回答` };
    });
    expect(client.sent).toHaveLength(0);
    expect(client.streams.length).toBeGreaterThan(0);
    expect(client.streams.every((stream) => stream.completed)).toBe(true);
    const updates = client.streams.flatMap((stream) => stream.updates);
    expect(updates.some((text) => text.includes("> 工具调用：read：读取文件"))).toBe(true);
    expect(updates.at(-1)).toContain("最终回答");
  });

  it("思考内容使用独立样式展示", async () => {
    const root = temporaryDirectory();
    const client = new FakeQQClient();
    const config = makeConfig(root).platform.qq;
    const bus = new MessageBus();
    const adapter = new QQAdapter(bus, config, client);
    await driveBusTurn(bus, adapter, qqMessage(), async function* () {
      yield { type: "thinking_delta", text: "先分析需求。" };
      yield { type: "tool_intent", toolName: "read", intent: "读取文件" };
      yield { type: "text_delta", text: "最终回答" };
      yield { type: "turn_done", text: "最终回答" };
    });
    const updates = client.streams.flatMap((stream) => stream.updates);
    expect(
      updates.some(
        (text) => text.includes("```text") && text.includes("🤔") && text.includes("先分析需求。")
      )
    ).toBe(true);
    expect(updates.some((text) => text.includes("> 工具调用：read：读取文件"))).toBe(true);
    expect(updates.some((text) => text.includes("---"))).toBe(false);
  });

  it("流式发送失败后继续消费并发送完整回复降级", async () => {
    const root = temporaryDirectory();
    const client = new FakeQQClient(true);
    const longText = "甲".repeat(80);
    const bus = new MessageBus();
    const adapter = new QQAdapter(bus, makeConfig(root).platform.qq, client);

    await driveBusTurn(bus, adapter, qqMessage(), async function* () {
      yield { type: "text_delta", text: longText };
      yield { type: "turn_done", text: `${longText}最终回答` };
    });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toContain("流式回复中断");
    expect(client.sent[0]).toContain("最终回答");
  });

  it("流式发送中途失败后只发送尚未发送的回答", async () => {
    const root = temporaryDirectory();
    const client = new FakeQQClient(false, 1);
    const first = "甲".repeat(80);
    const second = "乙".repeat(80);
    const bus = new MessageBus();
    const adapter = new QQAdapter(bus, makeConfig(root).platform.qq, client);

    await driveBusTurn(bus, adapter, qqMessage(), async function* () {
      yield { type: "text_delta", text: first };
      yield { type: "text_delta", text: second };
      yield { type: "turn_done", text: `${first}${second}` };
    });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toContain(second);
    expect(client.sent[0]).not.toContain(first);
  });
});
