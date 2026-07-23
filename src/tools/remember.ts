import { z } from "zod";
import { rememberToFile } from "../memory/memory-file.js";
import { Tool } from "./base.js";

const schema = z.object({
  content: z.string(),
  category: z.enum(["偏好", "事实"])
});

export class RememberTool extends Tool {
  readonly name = "remember";
  readonly description = "把用户明确要求长期记住的偏好或稳定事实写入 MEMORY.md";
  readonly schema = schema;

  constructor(
    private readonly memoryPath: string,
    private readonly maxMemoryChars: number
  ) {
    super();
  }

  async execute(arguments_: Record<string, unknown>): Promise<string> {
    const args = schema.parse(arguments_);
    const line = await rememberToFile(
      this.memoryPath,
      args.content,
      args.category,
      this.maxMemoryChars
    );
    return `已写入长期记忆：${line}`;
  }
}
