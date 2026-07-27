import crypto from "node:crypto";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import type { OutboundMessage } from "../bus/message-bus.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { AgentEvent } from "../types/events.js";
import { MimiError } from "../types/errors.js";
import { CommandHistory } from "../utils/command-history.js";
import { terminalSelect } from "../utils/terminal-select.js";
import { PlatformAdapter } from "./base.js";
import type { ModelControl } from "./model-control.js";

export type CliModelControl = ModelControl;

export type CliPlatformMode = "chat" | "ask";

export type CliPlatformOptions = { mode: "chat" } | { mode: "ask"; text: string };

type TurnWaiter = {
  resolve: (succeeded: boolean) => void;
};

export class CliAdapter extends PlatformAdapter {
  readonly name = "cli";
  exitCode = 0;

  private stopping = false;
  private chatTerminal?: readline.Interface;
  private unregisterHandler?: () => void;
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  /** 当前轮次的 CLI 渲染状态：思考与正文共用 Mimi> 前缀。 */
  private turnRender = {
    mimiStarted: false,
    thinkingLabelPrinted: false,
    thinkingPrinted: false,
    answerStarted: false
  };

  constructor(
    private readonly bus: MessageBus,
    private readonly options: CliPlatformOptions = { mode: "chat" },
    private readonly modelControl?: ModelControl
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
    this.chatTerminal?.close();
    delete this.chatTerminal;
    this.unregisterHandler?.();
    delete this.unregisterHandler;
    for (const waiter of this.turnWaiters.values()) {
      waiter.resolve(false);
    }
    this.turnWaiters.clear();
  }

  private async runChat(): Promise<void> {
    await new Promise<void>((resolve) => {
      const terminal = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: stdin.isTTY,
        // 历史由下面的 CommandHistory 统一维护，避免和模型选择器切换 raw mode 后的 readline 内置历史状态冲突。
        historySize: 0
      });
      this.chatTerminal = terminal;
      terminal.setPrompt("你> ");

      let processing = false;
      let settled = false;
      const commandHistory = new CommandHistory();
      const onKeypress = (_input: string, key: readline.Key): void => {
        if (processing || this.stopping || settled) {
          return;
        }
        if (key.name === "up" || key.name === "down") {
          const previousLine = commandHistory.navigate(key.name, terminal.line);
          terminal.write(null, { ctrl: true, name: "u" });
          terminal.write(previousLine);
          return;
        }
        commandHistory.reset(terminal.line);
      };
      stdin.on("keypress", onKeypress);
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        stdin.off("keypress", onKeypress);
        delete this.chatTerminal;
        terminal.close();
        resolve();
      };
      const showPrompt = (): void => {
        if (!this.stopping && !processing && !settled) {
          terminal.prompt();
        }
      };

      console.log(
        "Mimi 已启动。输入 /exit 或 /quit 退出；/model 方向键选择模型；↑ 回溯历史命令。结构化日志写入 data/runtime.log。"
      );

      terminal.on("line", (line) => {
        if (processing || this.stopping || settled) {
          showPrompt();
          return;
        }
        void (async () => {
          const text = line.trim();
          if (!text) {
            showPrompt();
            return;
          }
          commandHistory.add(text);
          processing = true;
          try {
            if (["/exit", "/quit"].includes(text.toLowerCase())) {
              finish();
              return;
            }
            const command = text.split(/\s+/, 1)[0]?.toLowerCase();
            if (command === "/model") {
              await this.handleModelCommand(text, terminal);
              return;
            }
            await this.publishTurn(text);
          } finally {
            processing = false;
            showPrompt();
          }
        })();
      });

      terminal.on("close", () => {
        if (!settled) {
          settled = true;
          stdin.off("keypress", onKeypress);
          delete this.chatTerminal;
          resolve();
        }
      });

      showPrompt();
    });
  }

  private async handleModelCommand(text: string, terminal: readline.Interface): Promise<void> {
    if (!this.modelControl) {
      console.log("当前环境不支持切换模型。");
      return;
    }
    const models = this.modelControl.listModels();
    const parts = text.trim().split(/\s+/);
    if (parts.length === 1 || parts[1]?.toLowerCase() === "list") {
      if (models.length <= 1) {
        this.printModelList(models);
        return;
      }
      const defaultIndex = Math.max(
        0,
        models.findIndex((item) => item.active)
      );
      this.clearInputLine(terminal);
      terminal.pause();
      try {
        const selected = await terminalSelect(
          models.map((item) => ({
            value: item.id,
            label: `${item.active ? "* " : "  "}${item.id}: ${item.model} (${item.baseUrl})`
          })),
          "选择对话模型：",
          "↑↓ 选择，Enter 确认，Esc 取消",
          defaultIndex
        );
        if (!selected) {
          console.log("已取消切换。");
          return;
        }
        this.modelControl.switchModel(selected);
        const active = this.modelControl.listModels().find((item) => item.id === selected);
        console.log(
          `已切换为 ${active?.id ?? selected}（${active?.model ?? selected}），下一轮对话生效。`
        );
      } finally {
        this.clearInputLine(terminal);
        terminal.resume();
        if (stdin.isTTY) {
          stdin.setRawMode(true);
        }
      }
      return;
    }
    let index = 1;
    const keyword = parts[index]?.toLowerCase();
    if (keyword === "use" || keyword === "switch") {
      index++;
    }
    let id = parts[index];
    if (!id) {
      console.log("用法：/model [list] | /model <id> | /model switch <id>");
      return;
    }
    if (/^\d+$/.test(id)) {
      const selected = models[Number(id) - 1];
      if (!selected) {
        console.log(`无效序号：${id}，当前共 ${models.length} 个 runtime`);
        return;
      }
      id = selected.id;
    }
    try {
      this.modelControl.switchModel(id);
      console.log("已切换，下一轮对话生效：");
      this.printModelList(this.modelControl.listModels());
    } catch (error) {
      const knownIds = models.map((item) => item.id).join("、");
      console.log(
        error instanceof MimiError ? `${error.message}（可用：${knownIds}）` : "切换失败"
      );
    }
  }

  /** 清除 readline 当前行，避免选择器退出后把已提交的命令重新绘制出来。 */
  private clearInputLine(terminal: readline.Interface): void {
    terminal.write(null, { ctrl: true, name: "u" });
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
  }

  private printModelList(
    models: Array<{ id: string; model: string; baseUrl: string; active: boolean }>
  ): void {
    for (const item of models) {
      const marker = item.active ? "* " : "  ";
      console.log(`${marker}${item.id}: ${item.model} (${item.baseUrl})`);
    }
  }

  private publishTurn(text: string): Promise<boolean> {
    const messageId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.turnWaiters.set(messageId, { resolve });
      this.bus.publishInboundMessage({ platform: "cli", text, messageId });
    });
  }

  private handleOutbound(message: OutboundMessage): void {
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

  private resetTurnRender(): void {
    this.turnRender = {
      mimiStarted: false,
      thinkingLabelPrinted: false,
      thinkingPrinted: false,
      answerStarted: false
    };
  }

  private ensureMimiPrefix(): void {
    if (!this.turnRender.mimiStarted) {
      stdout.write("\nMimi> ");
      this.turnRender.mimiStarted = true;
    }
  }

  private renderEvent(event: AgentEvent): void {
    if (event.type === "thinking_delta") {
      this.ensureMimiPrefix();
      if (!this.turnRender.thinkingLabelPrinted) {
        stdout.write("[思考] ");
        this.turnRender.thinkingLabelPrinted = true;
      }
      this.turnRender.thinkingPrinted = true;
      stdout.write(event.text);
      return;
    }
    if (event.type === "text_delta") {
      this.ensureMimiPrefix();
      if (this.turnRender.thinkingPrinted && !this.turnRender.answerStarted) {
        stdout.write("\n\n[回复] ");
        this.turnRender.answerStarted = true;
      }
      stdout.write(event.text);
      return;
    }
    if (event.type === "tool_intent") {
      console.log(`\n[工具] ${event.toolName}：${event.intent}`);
      this.resetTurnRender();
      return;
    }
    if (event.type === "turn_error") {
      console.log(`\n${event.message}`);
      this.resetTurnRender();
      return;
    }
    if (event.type === "turn_done") {
      console.log();
      this.resetTurnRender();
    }
  }
}
