import fs from "node:fs";
import TOML from "@iarna/toml";
import { ConfigError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { resolveConfigPath } from "./paths.js";

const tableHeaderPattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const currentModelPattern = /^(\s*current_model\s*=\s*)(.*)$/;

function serializedModelValue(model: string): string {
  const line = TOML.stringify({ current_model: model }).trim();
  return line.slice(line.indexOf("=") + 1).trim();
}

/** 只更新 [model] 段的当前模型，保留配置文件的其余内容和格式。 */
export function updateCurrentModel(configPath: string, model: string): void {
  const resolvedPath = resolveConfigPath(configPath);
  let source: string;
  try {
    source = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new ConfigError(`无法读取模型配置文件：${resolvedPath}`, { cause: error });
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = source.endsWith("\n");
  const lines = source.split(/\r?\n/);
  if (hasTrailingNewline && lines.at(-1) === "") {
    lines.pop();
  }

  let inModelTable = false;
  let modelTableIndex = -1;
  let currentModelIndex = -1;
  for (const [index, line] of lines.entries()) {
    const header = line.match(tableHeaderPattern);
    if (header) {
      inModelTable = header[1]?.trim() === "model";
      if (inModelTable) {
        modelTableIndex = index;
      }
      continue;
    }
    if (inModelTable && currentModelPattern.test(line)) {
      currentModelIndex = index;
    }
  }

  if (modelTableIndex < 0) {
    throw new ConfigError(`配置文件缺少 [model] 段：${resolvedPath}`);
  }

  const value = serializedModelValue(model);
  if (currentModelIndex >= 0) {
    const line = lines[currentModelIndex] ?? "";
    const match = line.match(currentModelPattern);
    if (!match) {
      throw new ConfigError("配置文件中的 model.current_model 格式无效");
    }
    const comment = match[2]?.match(/(\s+#.*)$/)?.[1] ?? "";
    lines[currentModelIndex] = `${match[1]}${value}${comment}`;
  } else {
    lines.splice(modelTableIndex + 1, 0, `current_model = ${value}`);
  }

  const updated = lines.join(newline) + (hasTrailingNewline ? newline : "");
  try {
    TOML.parse(updated);
  } catch (error) {
    throw new ConfigError(`更新模型配置后格式校验失败：${resolvedPath}`, { cause: error });
  }
  atomicWriteText(resolvedPath, updated);
}
