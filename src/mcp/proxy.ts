import { z } from "zod";
import { Tool } from "../tools/base.js";

export type McpToolDescription = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCaller = {
  call(serverId: string, toolName: string, arguments_: Record<string, unknown>): Promise<string>;
};

function mcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.trim().replace(/[^a-zA-Z0-9_]/g, "_") || "server";
  const safeTool = toolName.trim().replace(/[^a-zA-Z0-9_]/g, "_") || "tool";
  return `mcp_${safeServer}_${safeTool}`;
}

export class McpProxyTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly schema = z.looseObject({});
  readonly parameters: Record<string, unknown>;

  constructor(
    private readonly hub: McpToolCaller,
    private readonly serverId: string,
    private readonly mcpTool: McpToolDescription
  ) {
    super();
    this.name = mcpToolName(serverId, mcpTool.name);
    this.description = mcpTool.description || `MCP 工具 ${mcpTool.name}（${serverId}）`;
    this.parameters =
      mcpTool.inputSchema && Object.keys(mcpTool.inputSchema).length
        ? mcpTool.inputSchema
        : { type: "object", properties: {}, additionalProperties: true };
  }

  execute(arguments_: Record<string, unknown>): Promise<string> {
    return this.hub.call(this.serverId, this.mcpTool.name, arguments_);
  }
}

export function mcpProxyTool(
  hub: McpToolCaller,
  serverId: string,
  mcpTool: McpToolDescription
): Tool {
  return new McpProxyTool(hub, serverId, mcpTool);
}
