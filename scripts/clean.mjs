import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, "..");
const outputDirectory = path.join(projectRoot, "dist");

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error("构建输出目录校验失败");
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
