import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/init/index.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTemporaryDirectories();
});

describe("项目初始化", () => {
  it("配置模板缺失时返回明确错误", () => {
    const projectRoot = temporaryDirectory();
    const outputRoot = temporaryDirectory();
    expect(() =>
      initializeProject({
        projectRoot,
        configPath: path.join(outputRoot, "config.toml"),
        dataPath: path.join(outputRoot, "data"),
        mcpConfigPath: path.join(outputRoot, "mcp.json")
      })
    ).toThrow("找不到初始化配置模板");
  });

  it("创建缺失文件且不覆盖用户内容", () => {
    const projectRoot = temporaryDirectory();
    const outputRoot = temporaryDirectory();
    fs.writeFileSync(path.join(projectRoot, "config.example.toml"), "[model]\n");
    fs.writeFileSync(path.join(projectRoot, "mcp.json.example"), '{"mcpServers": {}}\n');
    const paths = {
      projectRoot,
      configPath: path.join(outputRoot, "config.toml"),
      dataPath: path.join(outputRoot, "data"),
      mcpConfigPath: path.join(outputRoot, "mcp.json")
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    initializeProject(paths);
    const soulPath = path.join(paths.dataPath, "SOUL.md");
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe("[model]\n");
    expect(fs.readFileSync(paths.mcpConfigPath, "utf8")).toContain("mcpServers");
    expect(fs.readFileSync(soulPath, "utf8")).toContain("# Mimi 的人格");
    expect(fs.readFileSync(path.join(paths.dataPath, "USER.md"), "utf8")).toContain("# 用户资料");

    fs.writeFileSync(soulPath, "用户自定义内容\n");
    initializeProject(paths);
    expect(fs.readFileSync(soulPath, "utf8")).toBe("用户自定义内容\n");
  });
});
