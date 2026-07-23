import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { ToolError } from "../types/errors.js";
import { Tool } from "./base.js";
import { resolveWorkspacePath } from "../utils/workspace-path.js";

function validateFindPattern(pattern: string): void {
  if (path.isAbsolute(pattern) || path.posix.isAbsolute(pattern)) {
    throw new ToolError("pattern 不能是绝对路径");
  }
  if (/(^|[\\/,{])\.\.(?=[\\/},]|$)/.test(pattern)) {
    throw new ToolError("pattern 不能包含工作区外的父目录片段");
  }
}

const schema = z.object({
  pattern: z.string(),
  path: z.string().optional()
});

export class FindTool extends Tool {
  readonly name = "find";
  readonly description = "在工作区内按 glob 模式查找文件";
  readonly schema = schema;

  constructor(
    private readonly workspace: string,
    private readonly maxResults: number
  ) {
    super();
    if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
      throw new ToolError("find 结果上限必须是正整数");
    }
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    const pattern = args.pattern.trim();
    if (!pattern) {
      throw new ToolError("pattern 不能为空");
    }
    validateFindPattern(pattern);
    const workspaceRoot = resolveWorkspacePath(this.workspace, ".");
    const root = resolveWorkspacePath(workspaceRoot, args.path ?? ".");
    if (!fs.existsSync(root)) {
      throw new ToolError(`路径不存在：${root}`);
    }
    if (!fs.statSync(root).isDirectory()) {
      throw new ToolError(`路径不是目录：${root}`);
    }
    let matches: string[];
    try {
      matches = await fg(pattern, {
        cwd: root,
        dot: true,
        onlyFiles: false,
        unique: true,
        followSymbolicLinks: false
      });
    } catch (error) {
      throw new ToolError(
        `无效的 glob 模式：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const safeMatches = matches.map((match) => {
      try {
        return resolveWorkspacePath(workspaceRoot, path.resolve(root, match));
      } catch (error) {
        throw new ToolError(`glob 结果越过工作区边界：${match}`, { cause: error });
      }
    });
    const shown = safeMatches.sort().slice(0, this.maxResults);
    const lines = [
      `搜索：${root} pattern=${JSON.stringify(pattern)}`,
      "",
      ...shown.map((match) => path.relative(workspaceRoot, match).replaceAll("\\", "/"))
    ];
    if (!shown.length) {
      lines.push("(无匹配)");
    }
    if (safeMatches.length > shown.length) {
      lines.push("", `[还有 ${safeMatches.length - shown.length} 个结果未显示]`);
    }
    return lines.join("\n");
  }
}
