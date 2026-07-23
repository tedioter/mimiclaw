import { z } from "zod";
import fs from "node:fs";
import { ToolError } from "../types/errors.js";
import { Tool } from "./base.js";
import { resolveWorkspacePath } from "../utils/workspace-path.js";

const schema = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

export class ReadTool extends Tool {
  readonly name = "read";
  readonly description = "读取工作区内的文本文件；可用 offset/limit 只读指定行范围";
  readonly schema = schema;

  constructor(
    private readonly workspace: string,
    private readonly maxFileChars: number,
    private readonly maxFileBytes: number
  ) {
    super();
    if (!Number.isSafeInteger(maxFileChars) || maxFileChars <= 0) {
      throw new ToolError("读取字符上限必须是正整数");
    }
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new ToolError("读取文件字节上限必须是正整数");
    }
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    const resolved = resolveWorkspacePath(this.workspace, args.path);
    if (!fs.existsSync(resolved)) {
      throw new ToolError(`文件不存在：${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new ToolError(`路径不是文件：${resolved}`);
    }
    if (stat.size > this.maxFileBytes) {
      throw new ToolError(
        `文件过大（${stat.size} 字节，上限 ${this.maxFileBytes} 字节）；可调整 config.toml 中的 tools.max_file_bytes，或用 grep 搜索内容`
      );
    }
    const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") {
      lines.pop();
    }
    const start = Math.max(1, args.offset ?? 1);
    const limit = args.limit;
    if (start > lines.length && lines.length) {
      throw new ToolError(`offset 超出文件行数：${start} > ${lines.length}`);
    }
    const selected = lines.slice(start - 1, limit === undefined ? undefined : start - 1 + limit);
    let body = selected
      .map((line, index) => `${String(start + index).padStart(6)}|${line}`)
      .join("\n");
    if (body.length > this.maxFileChars) {
      body = `${body.slice(0, this.maxFileChars)}\n\n[内容已截断，最多读取 ${this.maxFileChars} 字符]`;
    }
    const range = selected.length ? `lines ${start}-${start + selected.length - 1}` : "empty range";
    return `文件：${resolved}（共 ${lines.length} 行，显示 ${range}）\n\n${body}`;
  }
}
