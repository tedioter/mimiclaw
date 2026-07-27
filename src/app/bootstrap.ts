import { createAgentLoopControl, createRuntime, type AgentRuntime } from "./runtime.js";
import { runShutdownSteps } from "../utils/shutdown.js";
import { MimiError } from "../types/errors.js";
import type { CliPlatformOptions, PlatformAdapter } from "../platforms/index.js";
import { CliAdapter, FeishuAdapter, QQAdapter } from "../platforms/index.js";

export type { AgentLoopControl, AgentRuntime } from "./runtime.js";
export { createAgentLoopControl, createRuntime } from "./runtime.js";

export type PlatformName = "qq" | "feishu" | "cli";

export type ServeOptions = {
  cli?: CliPlatformOptions;
};

function createAdapter(
  runtime: AgentRuntime,
  name: PlatformName,
  options?: ServeOptions
): PlatformAdapter {
  switch (name) {
    case "qq":
      return new QQAdapter(runtime.bus, runtime.config.platform.qq, undefined, runtime);
    case "feishu":
      return new FeishuAdapter(runtime.bus, runtime.config.platform.feishu);
    case "cli":
      return new CliAdapter(runtime.bus, options?.cli ?? { mode: "chat" }, runtime);
    default:
      throw new MimiError(`未知平台：${name satisfies never}`);
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

/** 启动 Agent 与指定平台，阻塞直到 CLI 结束或收到退出信号。 */
export async function servePlatforms(
  platforms: PlatformName[],
  options?: ServeOptions
): Promise<number> {
  if (!platforms.length) {
    throw new MimiError("至少需要指定一个平台");
  }

  const runtime = await createRuntime();
  const started: PlatformAdapter[] = [];
  const loopControl = createAgentLoopControl();
  const agentTask = runtime.runLoop(loopControl);
  const dispatchTask = runtime.bus.dispatchHandlers();
  let cliAdapter: CliAdapter | undefined;

  try {
    const adapters = platforms.map((name) => createAdapter(runtime, name, options));
    const remote = adapters.filter((adapter) => adapter.name !== "cli");
    cliAdapter = adapters.find((adapter): adapter is CliAdapter => adapter.name === "cli");

    for (const adapter of remote) {
      await adapter.start();
      started.push(adapter);
    }

    const cliTask = cliAdapter?.start().then(() => {
      if (cliAdapter) {
        started.push(cliAdapter);
      }
    });

    if (remote.length > 0) {
      await Promise.race([waitForShutdownSignal(), ...(cliTask ? [cliTask] : [])]);
    } else if (cliTask) {
      await cliTask;
    }
  } finally {
    loopControl.stop();
    runtime.bus.close();
    await Promise.allSettled([agentTask, dispatchTask]);
    await runShutdownSteps(
      [
        () =>
          runShutdownSteps(
            [...started].reverse().map((adapter) => () => adapter.stop()),
            "平台适配器关闭失败"
          ),
        () => runtime.close()
      ],
      "平台服务关闭失败"
    );
  }

  return cliAdapter?.exitCode ?? 0;
}
