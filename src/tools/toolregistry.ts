import { toJSONSchema } from "zod";
import type { AppConfig } from "../config/types.js";
import { memoryFilePath } from "../memory/memory-file.js";
import type { DeclaredToolSchema } from "../model/model.js";
import { McpToolHub } from "../mcp/hub.js";
import { ToolError } from "../types/errors.js";
import { writeLog } from "../utils/log.js";
import { Tool } from "./base.js";
import { BashTool } from "./bash.js";
import { EditTool } from "./edit.js";
import { FindTool } from "./find.js";
import { GrepTool } from "./grep.js";
import { ReadTool } from "./read.js";
import { RememberTool } from "./remember.js";
import { WebFetchTool } from "./web-fetch.js";
import { WriteTool } from "./write.js";

type CreatedToolRegistry = {
  registry: ToolRegistry;
  hub?: McpToolHub;
};

function buildToolSchema(tool: Tool): DeclaredToolSchema {
  const baseSchema =
    tool.parameters ?? (toJSONSchema(tool.schema as never) as Record<string, unknown>);
  const properties = (baseSchema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(baseSchema.required) ? baseSchema.required : [];
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {
          ...properties,
          intent: { type: "string", description: "展示给用户的简短中文调用意图，不包含敏感参数" }
        },
        required: [...new Set([...required.map(String), "intent"])],
        additionalProperties: false
      }
    }
  };
}

/** 运行时工具查找表：按名称取工具，并在构造时生成发给模型的 schema。 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool>;
  private readonly toolSchemas: DeclaredToolSchema[];

  constructor(tools: Tool[]) {
    this.tools = new Map();
    for (const tool of tools) {
      if (!tool.name.trim()) {
        throw new ToolError("工具名称不能为空");
      }
      if (this.tools.has(tool.name)) {
        throw new ToolError(`工具名称重复："${tool.name}"`);
      }
      this.tools.set(tool.name, tool);
    }
    this.toolSchemas = [...this.tools.values()].map((tool) => buildToolSchema(tool));
  }

  /** 返回发给模型的工具 schema 快照；深拷贝避免调用方改动污染实例内的 toolSchemas。 */
  schemas(): DeclaredToolSchema[] {
    return structuredClone(this.toolSchemas);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

/** 根据配置组装全部内置工具。新增工具：import class + 在数组中加一行 new。 */
export function createTools(config: AppConfig): Tool[] {
  const tools = config.tools;
  return [
    new ReadTool(tools.workspace, tools.maxFileChars, tools.maxFileBytes),
    new WriteTool(tools.workspace),
    new EditTool(tools.workspace),
    new BashTool(tools.workspace, tools.bashTimeoutSeconds, tools.bashMaxOutputChars),
    new GrepTool(tools.workspace, tools.grepMaxMatches),
    new FindTool(tools.workspace, tools.findMaxResults),
    new WebFetchTool(tools.maxWebChars, tools.webFetchTimeoutSeconds),
    new RememberTool(memoryFilePath(config.dataDir), config.memory.maxMemoryChars)
  ];
}

/** 组装内置工具，并按需连接 MCP。 */
export async function createToolRegistry(config: AppConfig): Promise<CreatedToolRegistry> {
  const tools = createTools(config);
  if (!config.mcp.enabled || !config.mcp.servers.length) {
    return { registry: new ToolRegistry(tools) };
  }
  const hub = new McpToolHub(config.mcp.callTimeoutSeconds, config.mcp.connectTimeoutSeconds);
  const { tools: mcpTools, errors } = await hub.connect(config.mcp.servers);
  for (const error of errors) {
    writeLog("error", "system", { type: "mcp_connect_error", content: error });
  }
  tools.push(...mcpTools);
  return { registry: new ToolRegistry(tools), hub };
}
