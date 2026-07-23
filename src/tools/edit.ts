import { z } from "zod";
import fs from "node:fs";
import { ToolError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { Tool } from "./base.js";
import { resolveWorkspacePath } from "../utils/workspace-path.js";

const schema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string()
});

export class EditTool extends Tool {
  readonly name = "edit";
  readonly description = "在工作区内对文本文件做精确字符串替换（old_string → new_string）";
  readonly schema = schema;

  constructor(private readonly workspace: string) {
    super();
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    if (!args.old_string) {
      throw new ToolError("old_string 不能为空");
    }
    if (args.old_string === args.new_string) {
      throw new ToolError("old_string 与 new_string 相同，无需编辑");
    }
    const resolved = resolveWorkspacePath(this.workspace, args.path);
    if (!fs.existsSync(resolved)) {
      throw new ToolError(`文件不存在：${resolved}`);
    }
    const content = fs.readFileSync(resolved, "utf8");
    const firstMatch = content.indexOf(args.old_string);
    if (firstMatch < 0) {
      throw new ToolError("未找到 old_string，编辑失败");
    }
    const secondMatch = content.indexOf(args.old_string, firstMatch + args.old_string.length);
    if (secondMatch >= 0) {
      throw new ToolError("old_string 在文件中出现多次，请提供更唯一的匹配片段");
    }
    const updated =
      content.slice(0, firstMatch) +
      args.new_string +
      content.slice(firstMatch + args.old_string.length);
    atomicWriteText(resolved, updated.endsWith("\n") ? updated : `${updated}\n`);
    return `已编辑：${resolved}`;
  }
}
