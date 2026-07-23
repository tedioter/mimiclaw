import { z } from "zod";
import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ToolError } from "../types/errors.js";
import { Tool } from "./base.js";

const executeCommand = promisify(exec);

const schema = z.object({
  command: z.string(),
  description: z.string().optional()
});

export class BashTool extends Tool {
  readonly name = "bash";
  readonly description = "在工作区目录下执行 shell 命令；输出过长时会截断";
  readonly schema = schema;

  constructor(
    private readonly workspace: string,
    private readonly bashTimeoutSeconds: number,
    private readonly bashMaxOutputChars: number
  ) {
    super();
    if (!Number.isFinite(bashTimeoutSeconds) || bashTimeoutSeconds <= 0) {
      throw new ToolError("bash 超时时间必须是大于 0 的有限数字");
    }
    if (!Number.isSafeInteger(bashMaxOutputChars) || bashMaxOutputChars <= 0) {
      throw new ToolError("bash 输出字符上限必须是正整数");
    }
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    if (!fs.existsSync(this.workspace)) {
      throw new ToolError(`工作区不存在：${this.workspace}`);
    }
    const args = schema.parse(arguments_);
    try {
      const result = await executeCommand(args.command, {
        cwd: this.workspace,
        timeout: this.bashTimeoutSeconds * 1000,
        maxBuffer: this.bashMaxOutputChars * 4,
        shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh"
      });
      let output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (output.length > this.bashMaxOutputChars) {
        output = `${output.slice(0, this.bashMaxOutputChars)}\n\n[输出已截断]`;
      }
      return output || "(命令无输出)";
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      const parts = [
        execError.stdout?.toString().trim(),
        execError.stderr?.toString().trim()
      ].filter(Boolean);
      let output = parts.join("\n").trim();
      if (execError.code !== undefined) {
        output = `${output}\n\nexit_code=${execError.code}`.trim();
      }
      if (output.length > this.bashMaxOutputChars) {
        output = `${output.slice(0, this.bashMaxOutputChars)}\n\n[输出已截断]`;
      }
      return output || `命令失败：${execError.message}`;
    }
  }
}
