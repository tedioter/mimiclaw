import { pathToFileURL } from "node:url";
import { MimiError, errorMessage } from "../types/errors.js";
import type { CliPlatformOptions } from "../platforms/cli.js";
import { initializeProject } from "../init/index.js";
import { type PlatformName, servePlatforms } from "./bootstrap.js";

export const HELP_TEXT = "用法：mimi <init|chat|ask|serve|qq|feishu> [文本]";

type ParsedCommand =
  | { kind: "help"; showHelp: boolean }
  | { kind: "init" }
  | {
      kind: "platform";
      platforms: PlatformName[];
      cli?: CliPlatformOptions;
    };

export function parseCommand(args: readonly string[]): ParsedCommand {
  const [command, ...rest] = args;
  if (!command || command === "-h" || command === "--help") {
    return { kind: "help", showHelp: Boolean(command) };
  }
  if (command === "init") {
    return { kind: "init" };
  }
  if (command === "chat") {
    return { kind: "platform", platforms: ["cli"], cli: { mode: "chat" } };
  }
  if (command === "ask") {
    if (!rest.length) {
      throw new MimiError("ask 命令需要文本参数");
    }
    return {
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "ask", text: rest.join(" ") }
    };
  }
  if (command === "serve") {
    return { kind: "platform", platforms: ["qq", "feishu"] };
  }
  if (command === "qq" || command === "feishu") {
    return { kind: "platform", platforms: [command] };
  }
  throw new MimiError(`未知命令：${command}`);
}

export async function run(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseCommand(args);
  if (parsed.kind === "help") {
    console.log(HELP_TEXT);
    return parsed.showHelp ? 0 : 1;
  }
  if (parsed.kind === "init") {
    initializeProject();
    return 0;
  }
  return servePlatforms(parsed.platforms, parsed.cli ? { cli: parsed.cli } : undefined);
}

async function runMain(): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    if (error instanceof MimiError) {
      console.error(`错误：${error.message}`);
    } else {
      console.error(`系统错误：${errorMessage(error)}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  // 长生命周期 CLI 不使用顶层 await，避免输入流结束时出现未收敛警告。
  void runMain();
}
