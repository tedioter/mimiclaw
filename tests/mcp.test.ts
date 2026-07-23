import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/types/errors.js";
import { McpToolHub } from "../src/mcp/hub.js";
import { parseMcpServerEntry } from "../src/mcp/json-config.js";
import type { McpServerConfig } from "../src/config/types.js";

describe("MCP 配置", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])("拒绝非法超时时间 %s", (timeout) => {
    expect(() => new McpToolHub(timeout, 30)).toThrow("MCP 超时时间必须是大于 0 的有限数字");
  });

  it("解析 stdio 和 HTTP 服务器配置", () => {
    expect(
      parseMcpServerEntry(
        "local",
        { command: "node", args: ["server.js"], env: { MODE: "test" } },
        "mcp.json"
      )
    ).toMatchObject({
      id: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { MODE: "test" }
    });
    expect(
      parseMcpServerEntry(
        "remote",
        { transport: "sse", url: "https://example.com/sse" },
        "mcp.json"
      )
    ).toMatchObject({ transport: "sse", url: "https://example.com/sse" });
  });

  it.each([
    ["command", { command: 123 }, "mcp.json[local].command 必须是字符串"],
    ["args", { command: "node", args: [1] }, "mcp.json[local].args 必须只包含字符串"],
    ["env", { command: "node", env: { MODE: true } }, "mcp.json[local].env 的值必须是字符串"],
    [
      "url",
      { transport: "http", url: "not-a-url" },
      "mcp.json[local].url 必须是有效的 HTTP 或 HTTPS URL"
    ]
  ])("拒绝非法 %s 类型", (_name, value, message) => {
    expect(() => parseMcpServerEntry("local", value, "mcp.json")).toThrow(
      new ConfigError(message as string)
    );
  });

  it("单个 server 连接失败时不影响其他 server", async () => {
    const hub = new McpToolHub(5, 5);
    const servers: McpServerConfig[] = [
      { id: "good", transport: "stdio", command: "node", args: [] },
      { id: "bad", transport: "stdio", command: "node", args: [] }
    ];
    vi.spyOn(
      hub as unknown as { connectServer: (server: McpServerConfig) => Promise<unknown[]> },
      "connectServer"
    ).mockImplementation(async (server) => {
      if (server.id === "bad") {
        throw new Error("connect failed");
      }
      return [{ name: "mock_tool" }];
    });

    const result = await hub.connect(servers);

    expect(result.tools).toHaveLength(1);
    expect(result.errors).toEqual(["bad: connect failed"]);
    await hub.close();
  });
});
