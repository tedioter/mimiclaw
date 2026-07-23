import { z } from "zod";
import fs from "node:fs";
import { ToolError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { Tool } from "./base.js";
import { resolveWorkspacePath } from "../utils/workspace-path.js";

const schema = z.object({
  path: z.string(),
  content: z.string()
});

export class WriteTool extends Tool {
  readonly name = "write";
  readonly description = "在工作区内创建或整文件覆写文本文件";
  readonly schema = schema;

  constructor(private readonly workspace: string) {
    super();
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    const resolved = resolveWorkspacePath(this.workspace, args.path);
    const existed = fs.existsSync(resolved);
    if (existed && !fs.statSync(resolved).isFile()) {
      throw new ToolError(`路径不是文件：${resolved}`);
    }
    const content = args.content;
    atomicWriteText(resolved, content.endsWith("\n") ? content : `${content}\n`);
    return `${existed ? "已覆写" : "已创建"}：${resolved}（${content.length} 字符）`;
  }
}
