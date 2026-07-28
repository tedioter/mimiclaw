#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { MimiError, errorMessage } from "../types/errors.js";
import type { CliPlatformOptions } from "../platforms/cli.js";
import { initializeProject } from "../init/index.js";
import { type PlatformName, servePlatforms } from "./bootstrap.js";

export const HELP_TEXT = "\u7528\u6cd5\uff1amimi [init]";

type ParsedCommand =
  | { kind: "help"; showHelp: boolean }
  | { kind: "init" }
  | {
      kind: "platform";
      platforms: PlatformName[];
      cli?: CliPlatformOptions;
    };

export function parseCommand(args: readonly string[]): ParsedCommand {
  const [command] = args;
  if (!command) {
    return { kind: "platform", platforms: ["cli"], cli: { mode: "chat" } };
  }
  if (command === "-h" || command === "--help") {
    return { kind: "help", showHelp: true };
  }
  if (command === "init") {
    return { kind: "init" };
  }
  throw new MimiError(`\u672a\u77e5\u547d\u4ee4\uff1a${command}`);
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

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (typeof entryPath !== "string") {
    return false;
  }
  try {
    // 通过真实路径比较，兼容 npm link 创建的 junction 或符号链接。
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isDirectRun = isMainModule();

if (isDirectRun) {
  // 长生命周期 CLI 不使用顶层 await，避免输入流结束时出现未收敛警告。
  void runMain();
}
