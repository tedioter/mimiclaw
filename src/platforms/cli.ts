import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { BusOutboundMessage } from "../bus/message-bus.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { AgentEvent } from "../types/events.js";
import { PlatformAdapter } from "./base.js";

export type CliPlatformMode = "chat" | "ask";

export type CliPlatformOptions = { mode: "chat" } | { mode: "ask"; text: string };

type TurnWaiter = {
  resolve: (succeeded: boolean) => void;
};

export class CliAdapter extends PlatformAdapter {
  readonly name = "cli";
  exitCode = 0;

  private stopping = false;
  private unregisterHandler?: () => void;
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private section: "" | "thinking" | "answer" = "";

  constructor(
    private readonly bus: MessageBus,
    private readonly options: CliPlatformOptions = { mode: "chat" }
  ) {
    super();
  }

  bindSendLoop(): void {
    this.unregisterHandler ??= this.bus.registerHandler("cli", (message) =>
      this.handleOutbound(message)
    );
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.bindSendLoop();
    if (this.options.mode === "ask") {
      this.exitCode = (await this.publishTurn(this.options.text)) ? 0 : 1;
      return;
    }
    await this.runChat();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unregisterHandler?.();
    delete this.unregisterHandler;
    for (const waiter of this.turnWaiters.values()) {
      waiter.resolve(false);
    }
    this.turnWaiters.clear();
  }

  private async runChat(): Promise<void> {
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    try {
      console.log("Mimi 已启动。输入 /exit 或 /quit 退出。");
      while (!this.stopping) {
        const text = (await terminal.question("你> ")).trim();
        if (["/exit", "/quit"].includes(text.toLowerCase())) {
          return;
        }
        if (text) {
          await this.publishTurn(text);
        }
      }
    } finally {
      terminal.close();
    }
  }

  private publishTurn(text: string): Promise<boolean> {
    const messageId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.turnWaiters.set(messageId, { resolve });
      this.bus.publishInbound({ platform: "cli", text, messageId });
    });
  }

  private handleOutbound(message: BusOutboundMessage): void {
    this.renderEvent(message.event);
    if (message.event.type !== "turn_done" && message.event.type !== "turn_error") {
      return;
    }
    if (!message.messageId) {
      return;
    }
    const waiter = this.turnWaiters.get(message.messageId);
    if (!waiter) {
      return;
    }
    this.turnWaiters.delete(message.messageId);
    waiter.resolve(message.event.type === "turn_done");
  }

  private renderEvent(event: AgentEvent): void {
    if (event.type === "thinking_delta") {
      if (this.section !== "thinking") {
        stdout.write("\n[思考] ");
        this.section = "thinking";
      }
      stdout.write(event.text);
      return;
    }
    if (event.type === "text_delta") {
      if (this.section !== "answer") {
        stdout.write("\nMimi> ");
        this.section = "answer";
      }
      stdout.write(event.text);
      return;
    }
    if (event.type === "tool_intent") {
      console.log(`\n[工具] ${event.toolName}：${event.intent}`);
      this.section = "";
      return;
    }
    if (event.type === "turn_error") {
      console.log(`\n${event.message}`);
      this.section = "";
      return;
    }
    if (event.type === "turn_done") {
      console.log();
      this.section = "";
    }
  }
}
