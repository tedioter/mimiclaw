import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MimiError, TimeoutError, errorMessage } from "../types/errors.js";
import { withTimeout } from "../utils/async.js";
import { isRecord } from "../utils/type-guards.js";
import type { Tool } from "../tools/base.js";
import type { McpServerConfig } from "../config/types.js";
import { mcpProxyTool } from "./proxy.js";

export type McpConnectResult = {
  tools: Tool[];
  errors: string[];
};

function base64ByteLength(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "base64") : 0;
}

function formatResult(result: unknown): string {
  if (!isRecord(result)) {
    return String(result ?? "(无内容)");
  }
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) {
        continue;
      }
      if (item.type === "text") {
        parts.push(String(item.text ?? ""));
      } else if (item.type === "image") {
        parts.push(
          `[image ${String(item.mimeType ?? "unknown")}, ${base64ByteLength(item.data)} bytes]`
        );
      } else if (item.type === "audio") {
        parts.push(
          `[audio ${String(item.mimeType ?? "unknown")}, ${base64ByteLength(item.data)} bytes]`
        );
      } else if (item.type === "resource_link") {
        parts.push(`[resource_link ${String(item.uri ?? "unknown")}]`);
      } else if (item.type === "resource") {
        const resource = isRecord(item.resource) ? item.resource : undefined;
        if (typeof resource?.text === "string") {
          parts.push(String(resource.text));
        } else if (typeof resource?.blob === "string") {
          parts.push(
            `[blob ${String(resource.mimeType ?? "unknown")}, ${base64ByteLength(resource.blob)} bytes]`
          );
        } else if (typeof resource?.uri === "string") {
          parts.push(`[resource ${resource.uri}]`);
        }
      }
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.filter(Boolean).join("\n").trim();
  return result.isError ? `MCP 工具执行失败：${text || "(无详情)"}` : text || "(无内容)";
}

function isRetryableMcpError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("closed") ||
    message.includes("disconnect") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("network") ||
    message.includes("transport")
  );
}

function formatConnectError(serverId: string, error: unknown): string {
  if (error instanceof TimeoutError || error instanceof MimiError) {
    return `${serverId}: ${error.message}`;
  }
  return `${serverId}: ${errorMessage(error)}`;
}

export class McpToolHub {
  private readonly clients = new Map<string, Client>();
  private readonly serverConfigs = new Map<string, McpServerConfig>();

  constructor(
    readonly callTimeoutSeconds = 60,
    readonly connectTimeoutSeconds = 30
  ) {
    if (
      !Number.isFinite(callTimeoutSeconds) ||
      callTimeoutSeconds <= 0 ||
      !Number.isFinite(connectTimeoutSeconds) ||
      connectTimeoutSeconds <= 0
    ) {
      throw new Error("MCP 超时时间必须是大于 0 的有限数字");
    }
  }

  async connect(servers: readonly McpServerConfig[]): Promise<McpConnectResult> {
    const tools: Tool[] = [];
    const errors: string[] = [];
    for (const server of servers) {
      const abortController = new AbortController();
      try {
        const serverTools = await withTimeout(
          this.connectServer(server, abortController.signal),
          this.connectTimeoutSeconds * 1000,
          `MCP Server 连接超时：${server.id}（超过 ${this.connectTimeoutSeconds} 秒）`,
          () => abortController.abort()
        );
        tools.push(...serverTools);
      } catch (error) {
        errors.push(formatConnectError(server.id, error));
      }
    }
    return { tools, errors };
  }

  private createTransport(server: McpServerConfig): Transport {
    if (server.transport === "stdio") {
      return new StdioClientTransport({
        command: server.command ?? "",
        args: [...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length
          ? {
              env: Object.fromEntries(
                Object.entries(server.env).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string"
                )
              )
            }
          : {})
      });
    }
    if (server.transport === "sse") {
      return new SSEClientTransport(new URL(server.url ?? ""), {
        requestInit: server.headers ? { headers: { ...server.headers } } : {}
      });
    }
    // SDK 的 sessionId 可选属性在 exactOptionalPropertyTypes 下与其 Transport 接口不一致。
    return new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
      requestInit: server.headers ? { headers: { ...server.headers } } : {}
    }) as unknown as Transport;
  }

  private async establishClient(server: McpServerConfig, signal: AbortSignal): Promise<Client> {
    if (this.clients.has(server.id)) {
      throw new MimiError(`MCP server 名称重复：${server.id}`);
    }
    const client = new Client({ name: "mimiclaw", version: "0.1.0" });
    const transport = this.createTransport(server);
    const timeout = this.connectTimeoutSeconds * 1000;
    await client.connect(transport, { timeout, signal });
    this.clients.set(server.id, client);
    this.serverConfigs.set(server.id, server);
    return client;
  }

  private async listServerTools(
    server: McpServerConfig,
    client: Client,
    signal: AbortSignal
  ): Promise<Tool[]> {
    const tools: Tool[] = [];
    const timeout = this.connectTimeoutSeconds * 1000;
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 100) {
        throw new MimiError(`MCP server ${server.id} 的工具列表超过分页上限`);
      }
      const listed = await client.listTools(cursor ? { cursor } : {}, { timeout, signal });
      tools.push(
        ...listed.tools.map((tool) =>
          mcpProxyTool(this, server.id, {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema as Record<string, unknown>
          })
        )
      );
      cursor = listed.nextCursor;
      if (!cursor) {
        return tools;
      }
    }
  }

  private async connectServer(server: McpServerConfig, signal: AbortSignal): Promise<Tool[]> {
    const client = await this.establishClient(server, signal);
    try {
      return await this.listServerTools(server, client, signal);
    } catch (error) {
      this.clients.delete(server.id);
      this.serverConfigs.delete(server.id);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async reconnectServer(serverId: string): Promise<boolean> {
    const server = this.serverConfigs.get(serverId);
    if (!server) {
      return false;
    }
    const existing = this.clients.get(serverId);
    if (existing) {
      this.clients.delete(serverId);
      await existing.close().catch(() => undefined);
    }
    const abortController = new AbortController();
    try {
      await withTimeout(
        this.establishClient(server, abortController.signal),
        this.connectTimeoutSeconds * 1000,
        `MCP Server 重连超时：${server.id}（超过 ${this.connectTimeoutSeconds} 秒）`,
        () => abortController.abort()
      );
      return true;
    } catch {
      return false;
    }
  }

  async call(
    serverId: string,
    toolName: string,
    arguments_: Record<string, unknown>
  ): Promise<string> {
    return this.callOnce(serverId, toolName, arguments_, true);
  }

  private async callOnce(
    serverId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
    allowReconnect: boolean
  ): Promise<string> {
    let client = this.clients.get(serverId);
    if (!client) {
      if (allowReconnect && this.serverConfigs.has(serverId)) {
        const reconnected = await this.reconnectServer(serverId);
        if (reconnected) {
          return this.callOnce(serverId, toolName, arguments_, false);
        }
        return `MCP 工具执行失败：无法重连 MCP server ${serverId}`;
      }
      return `工具执行失败：未知 MCP server ${serverId}`;
    }
    try {
      const timeout = this.callTimeoutSeconds * 1000;
      const abortController = new AbortController();
      return formatResult(
        await withTimeout(
          client.callTool({ name: toolName, arguments: arguments_ }, undefined, {
            timeout,
            signal: abortController.signal
          }),
          timeout,
          `MCP 工具执行超时：超过 ${this.callTimeoutSeconds} 秒`,
          () => abortController.abort()
        )
      );
    } catch (error) {
      if (allowReconnect && isRetryableMcpError(error)) {
        const reconnected = await this.reconnectServer(serverId);
        if (reconnected) {
          return this.callOnce(serverId, toolName, arguments_, false);
        }
        return `MCP 工具执行失败：连接已断开且重连失败（${serverId}）`;
      }
      if (error instanceof TimeoutError) {
        return `MCP 工具执行失败：${error.message}`;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.serverConfigs.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}
