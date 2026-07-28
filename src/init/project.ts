import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATA_PATH,
  DEFAULT_MCP_CONFIG_PATH,
  PROJECT_ROOT
} from "../config/index.js";
import { ConfigError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { MEMORY_TEMPLATE, SOUL_TEMPLATE, USER_TEMPLATE } from "./templates.js";

export type InitializationPaths = {
  projectRoot: string;
  configPath: string;
  dataPath: string;
  mcpConfigPath: string;
};

const DEFAULT_PATHS: InitializationPaths = {
  projectRoot: PROJECT_ROOT,
  configPath: DEFAULT_CONFIG_PATH,
  dataPath: DEFAULT_DATA_PATH,
  mcpConfigPath: DEFAULT_MCP_CONFIG_PATH
};

function copyIfMissing(source: string, destination: string): boolean {
  if (!fs.existsSync(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export function initializeProject(paths: InitializationPaths = DEFAULT_PATHS): void {
  const configExample = path.join(paths.projectRoot, "config.example.toml");
  if (!fs.existsSync(configExample)) {
    throw new ConfigError(`找不到初始化配置模板：${configExample}`);
  }
  if (copyIfMissing(configExample, paths.configPath)) {
    console.log(`已创建配置文件：${paths.configPath}`);
  } else {
    console.log(`配置文件已存在，未覆盖：${paths.configPath}`);
  }

  fs.mkdirSync(paths.dataPath, { recursive: true });
  const templates = new Map([
    [path.join(paths.dataPath, "SOUL.md"), SOUL_TEMPLATE],
    [path.join(paths.dataPath, "USER.md"), USER_TEMPLATE],
    [path.join(paths.dataPath, "MEMORY.md"), MEMORY_TEMPLATE]
  ]);
  for (const [filePath, content] of templates) {
    if (!fs.existsSync(filePath)) {
      atomicWriteText(filePath, content);
      console.log(`已创建：${filePath}`);
    } else {
      console.log(`文件已存在，未覆盖：${filePath}`);
    }
  }

  const mcpExample = path.join(paths.projectRoot, "mcp.json.example");
  if (copyIfMissing(mcpExample, paths.mcpConfigPath)) {
    console.log(`已创建：${paths.mcpConfigPath}`);
  }
  console.log("\n初始化完成。\n下一步：填写 config.toml 中的模型 API Key，然后运行 npm run dev");
}
