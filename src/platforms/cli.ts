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
import type { ModelControl, ModelInfo, ModelVendor } from "./model-control.js";

export type CliModelControl = ModelControl;

export type CliPlatformMode = "chat" | "ask";

export type CliPlatformOptions = { mode: "chat" } | { mode: "ask"; text: string };

type TurnWaiter = {
  resolve: (succeeded: boolean) => void;
};

const SLASH_COMMANDS = [
  { command: "/model", description: "选择厂商和模型" },
  { command: "/exit", description: "退出当前对话" },
  { command: "/quit", description: "退出当前对话" }
] as const;

export function resolveSlashSubmission(
  line: string,
  candidates: readonly { command: string }[],
  selectedIndex: number,
  selectionExplicit: boolean
): string {
  if (line.trim() === "/" && !selectionExplicit) {
    return line.trim();
  }
  return (candidates[selectedIndex]?.command ?? candidates[0]?.command ?? line).trim();
}

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
      let commandHintLines = 0;
      let commandHintPrefix = "";
      let commandHintIndex = 0;
      let commandHintSelectionExplicit = false;
      let commandHintRefreshScheduled = false;
      const commandHistory = new CommandHistory();
      const refreshCommandHints = (): void => {
        if (commandHintRefreshScheduled) {
          return;
        }
        commandHintRefreshScheduled = true;
        setImmediate(() => {
          commandHintRefreshScheduled = false;
          if (processing || this.stopping || settled) {
            return;
          }
          const currentLine = terminal.line;
          if (!currentLine.startsWith("/") || /\s/.test(currentLine)) {
            if (commandHintLines > 0) {
              this.clearCommandHints(terminal, commandHintLines);
              commandHintLines = 0;
              commandHintPrefix = "";
              commandHintIndex = 0;
              commandHintSelectionExplicit = false;
            }
            return;
          }
          const candidates = this.getCommandCandidates(currentLine);
          if (!candidates.length) {
            if (commandHintLines > 0) {
              this.clearCommandHints(terminal, commandHintLines);
              commandHintLines = 0;
            }
            commandHintPrefix = currentLine;
            commandHintIndex = 0;
            commandHintSelectionExplicit = false;
            return;
          }
          if (currentLine !== commandHintPrefix) {
            commandHintIndex = 0;
            commandHintSelectionExplicit = false;
          } else {
            commandHintIndex = Math.min(commandHintIndex, candidates.length - 1);
          }
          if (currentLine === commandHintPrefix && commandHintLines > 0) {
            return;
          }
          commandHintLines = this.renderCommandHints(
            terminal,
            currentLine,
            commandHintLines,
            commandHintIndex
          );
          commandHintPrefix = currentLine;
        });
      };
      const onKeypress = (input: string, key: readline.Key): void => {
        if (processing || this.stopping || settled) {
          return;
        }
        if (key.name === "up" || key.name === "down") {
          const candidates = this.getCommandCandidates(terminal.line);
          if ((commandHintLines > 0 || commandHintRefreshScheduled) && candidates.length > 0) {
            const delta = key.name === "up" ? -1 : 1;
            commandHintIndex = (commandHintIndex + delta + candidates.length) % candidates.length;
            commandHintSelectionExplicit = true;
            commandHintLines = this.renderCommandHints(
              terminal,
              terminal.line,
              commandHintLines,
              commandHintIndex
            );
            commandHintPrefix = terminal.line;
            return;
          }
          const previousLine = commandHistory.navigate(key.name, terminal.line);
          terminal.write(null, { ctrl: true, name: "u" });
          terminal.write(previousLine);
          refreshCommandHints();
          return;
        }
        if (key.name === "escape" && commandHintLines > 0) {
          this.clearCommandHints(terminal, commandHintLines);
          commandHintLines = 0;
          commandHintPrefix = "";
          commandHintIndex = 0;
          commandHintSelectionExplicit = false;
          return;
        }
        commandHistory.reset(terminal.line);
        if (terminal.line !== commandHintPrefix) {
          commandHintSelectionExplicit = false;
        }
        if (input === "/" || terminal.line.startsWith("/") || commandHintLines > 0) {
          refreshCommandHints();
        }
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
          const candidates = this.getCommandCandidates(line);
          const hintWasVisible = commandHintLines > 0;
          const selectionExplicit =
            hintWasVisible && commandHintSelectionExplicit && line === commandHintPrefix;
          const text = resolveSlashSubmission(
            line,
            candidates,
            commandHintIndex,
            selectionExplicit
          );
          if (hintWasVisible) {
            this.clearCommandHints(terminal, commandHintLines, true);
            commandHintLines = 0;
            commandHintPrefix = "";
            commandHintIndex = 0;
            commandHintSelectionExplicit = false;
          }
          if (!text) {
            showPrompt();
            return;
          }
          commandHistory.add(text);
          processing = true;
          try {
            if (text === "/") {
              this.printCommandHints();
              return;
            }
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
    const parts = text.trim().split(/\s+/);
    if (parts.length === 1 || parts[1]?.toLowerCase() === "list") {
      const selected = await this.selectModelInteractively(terminal);
      if (!selected) {
        console.log("已取消切换。");
        return;
      }
      this.switchModel(selected.model);
      return;
    }
    const models = this.modelControl.listModels();
    const args = parts.slice(1);
    const keyword = args[0]?.toLowerCase();
    if (keyword === "use" || keyword === "switch") {
      args.shift();
    }
    const vendorArg = args[0];
    const modelArg = args[1];
    if (!vendorArg) {
      console.log("用法：/model | /model <厂商> | /model <厂商> <模型>");
      return;
    }

    if (args.length >= 2) {
      const vendor = this.findVendor(vendorArg);
      const selected = vendor
        ? modelArg
          ? this.findModel(this.modelControl.listModels(vendor.id), modelArg)
          : undefined
        : undefined;
      if (!selected) {
        console.log("未找到对应厂商或模型。用法：/model <厂商> <模型>");
        return;
      }
      this.switchModel(selected.model);
      return;
    }

    const vendor = this.findVendor(vendorArg);
    if (vendor) {
      this.printModelList(this.modelControl.listModels(vendor.id));
      return;
    }
    const selected = this.findModel(models, vendorArg);
    this.switchModel(selected?.model ?? vendorArg);
  }

  private async selectModelInteractively(
    terminal: readline.Interface
  ): Promise<ModelInfo | undefined> {
    if (!this.modelControl) {
      return undefined;
    }
    const vendors = this.modelControl.listVendors();
    if (!vendors.length) {
      console.log("当前未配置模型厂商。");
      return undefined;
    }

    this.clearInputLine(terminal);
    terminal.pause();
    try {
      const selectedVendorId = await terminalSelect(
        vendors.map((item) => ({
          value: item.id,
          label: `${item.current ? "* " : "  "}${item.name} (${item.modelCount} 个模型)`
        })),
        "选择模型厂商：",
        "↑↓ 选择，Enter 确认，Esc 取消",
        Math.max(
          0,
          vendors.findIndex((item) => item.current)
        )
      );
      if (!selectedVendorId) {
        return undefined;
      }

      this.clearInputLine(terminal);
      const models = this.modelControl.listModels(selectedVendorId);
      if (!models.length) {
        console.log("该厂商没有可用模型。");
        return undefined;
      }
      const selectedModelId = await terminalSelect(
        models.map((item) => ({
          value: item.model,
          label: `${item.current ? "* " : "  "}${item.model}`
        })),
        "选择模型：",
        "↑↓ 选择，Enter 确认，Esc 取消",
        Math.max(
          0,
          models.findIndex((item) => item.current)
        )
      );
      return selectedModelId ? this.findModel(models, selectedModelId) : undefined;
    } finally {
      this.clearInputLine(terminal);
      terminal.resume();
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
    }
  }

  private switchModel(model: string): void {
    if (!this.modelControl) {
      return;
    }
    const models = this.modelControl.listModels();
    try {
      this.modelControl.switchModel(model);
      const current = this.modelControl.listModels().find((item) => item.current);
      console.log(
        `已切换为 ${current?.vendorName ?? "未知厂商"} / ${current?.model ?? model}，下一轮对话生效。`
      );
    } catch (error) {
      const knownIds = models.map((item) => `${item.vendorId}/${item.model}`).join("、");
      console.log(
        error instanceof MimiError ? `${error.message}（可用：${knownIds}）` : "切换失败"
      );
    }
  }

  private findVendor(value: string): ModelVendor | undefined {
    if (!this.modelControl) {
      return undefined;
    }
    const vendors = this.modelControl.listVendors();
    if (/^\d+$/.test(value)) {
      return vendors[Number(value) - 1];
    }
    const normalized = value.toLowerCase();
    return vendors.find(
      (item) => item.id.toLowerCase() === normalized || item.name.toLowerCase() === normalized
    );
  }

  private findModel(models: ModelInfo[], value: string): ModelInfo | undefined {
    if (/^\d+$/.test(value)) {
      return models[Number(value) - 1];
    }
    const normalized = value.toLowerCase();
    return models.find(
      (item) =>
        item.model.toLowerCase() === normalized ||
        `${item.vendorId}/${item.model}`.toLowerCase() === normalized
    );
  }

  /** 清除 readline 当前行，避免选择器退出后把已提交的命令重新绘制出来。 */
  private clearInputLine(terminal: readline.Interface): void {
    terminal.write(null, { ctrl: true, name: "u" });
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
  }

  private printModelList(models: ModelInfo[]): void {
    if (!models.length) {
      console.log("该厂商没有可用模型。");
      return;
    }
    console.log(`可用模型（${models[0]?.vendorName ?? "未知厂商"}）：`);
    for (const [index, item] of models.entries()) {
      const marker = item.current ? "* " : "  ";
      console.log(`${marker}${index + 1}. ${item.model}`);
    }
    console.log(`切换用法：/model ${models[0]?.vendorId ?? "<厂商>"} <模型>`);
  }

  private printCommandHints(): void {
    console.log(this.formatCommandHints("/"));
  }

  private getCommandCandidates(prefix: string): Array<(typeof SLASH_COMMANDS)[number]> {
    const normalized = prefix.toLowerCase();
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(normalized));
  }

  private formatCommandHints(prefix: string, selectedIndex = 0): string {
    return this.getCommandCandidates(prefix)
      .map(
        (item, index) =>
          `${index === selectedIndex ? ">" : " "} ${item.command.padEnd(24, " ")} ${item.description}`
      )
      .join("\n");
  }

  private clearCommandHints(
    terminal: readline.Interface,
    _lines: number,
    lineSubmitted = false
  ): void {
    if (lineSubmitted) {
      // 回车后光标位于候选列表第一行，向上清理输入行和候选列表。
      readline.cursorTo(stdout, 0);
      readline.moveCursor(stdout, 0, -1);
      readline.clearScreenDown(stdout);
      return;
    }

    // 只清理输入行下方的候选区域，并用相对移动恢复输入光标。
    const cursor = terminal.getCursorPos();
    readline.cursorTo(stdout, 0);
    readline.moveCursor(stdout, 0, 1);
    readline.clearScreenDown(stdout);
    readline.moveCursor(stdout, 0, -1);
    readline.cursorTo(stdout, cursor.cols);
  }

  private renderCommandHints(
    terminal: readline.Interface,
    prefix: string,
    previousLines: number,
    selectedIndex = 0
  ): number {
    if (previousLines > 0) {
      this.clearCommandHints(terminal, previousLines);
    }
    const text = this.formatCommandHints(prefix, selectedIndex);
    if (!text) {
      return 0;
    }

    // 保持输入行和光标不动，只把候选命令写到下一行开始的位置。
    const cursor = terminal.getCursorPos();
    const lines = text.split("\n").length;
    readline.cursorTo(stdout, 0);
    readline.moveCursor(stdout, 0, 1);
    stdout.write(text);
    readline.moveCursor(stdout, 0, -lines);
    readline.cursorTo(stdout, cursor.cols);
    return lines;
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
