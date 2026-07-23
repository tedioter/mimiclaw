import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { ToolError } from "../types/errors.js";
import { Tool } from "./base.js";
import { resolveWorkspacePath } from "../utils/workspace-path.js";

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index] ?? "";
    if (character === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

async function listSearchFiles(workspace: string, target: string): Promise<string[]> {
  if (fs.statSync(target).isFile()) {
    return [target];
  }
  const files = await fg("**/*", {
    cwd: target,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false
  });
  return files.map((file) => resolveWorkspacePath(workspace, file)).sort();
}

const schema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  context: z.number().int().min(0).optional()
});

export class GrepTool extends Tool {
  readonly name = "grep";
  readonly description = "在工作区内用正则搜索文件内容，返回匹配行及上下文";
  readonly schema = schema;

  constructor(
    private readonly workspace: string,
    private readonly maxMatches: number
  ) {
    super();
    if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0) {
      throw new ToolError("grep 匹配上限必须是正整数");
    }
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      throw new ToolError(`无效的正则表达式：${String(error)}`);
    }
    const target = resolveWorkspacePath(this.workspace, args.path ?? ".");
    if (!fs.existsSync(target)) {
      throw new ToolError(`路径不存在：${target}`);
    }
    const include = args.include ? globToRegExp(args.include) : undefined;
    const contextLines = args.context ?? 0;
    const workspaceRoot = fs.realpathSync.native(path.resolve(this.workspace));
    const files = await listSearchFiles(this.workspace, target);
    const matches: string[] = [];
    for (const file of files) {
      const relativeToWorkspace = path.relative(workspaceRoot, file).replaceAll("\\", "/");
      const relativeToTarget = path.relative(target, file).replaceAll("\\", "/");
      if (include && !include.test(relativeToWorkspace) && !include.test(relativeToTarget)) {
        continue;
      }
      let lines: string[];
      try {
        lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      } catch {
        continue;
      }
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index] ?? "")) {
          continue;
        }
        regex.lastIndex = 0;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        const rendered = [`${file}:${index + 1}`];
        for (let line = start; line < end; line++) {
          rendered.push(
            `${line === index ? ">" : " "}${String(line + 1).padStart(6)}|${lines[line]}`
          );
        }
        matches.push(rendered.join("\n"));
        if (matches.length >= this.maxMatches) {
          break;
        }
      }
      if (matches.length >= this.maxMatches) {
        break;
      }
    }
    if (!matches.length) {
      return `未找到匹配：pattern=${JSON.stringify(args.pattern)}`;
    }
    const limitNotice =
      matches.length >= this.maxMatches ? `（最多显示 ${this.maxMatches} 处）` : "";
    return `找到 ${matches.length} 处匹配${limitNotice}\n\n${matches.join("\n\n")}`;
  }
}
