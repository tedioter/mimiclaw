import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, "..");
const tscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const mainPath = path.join(projectRoot, "dist", "app", "main.js");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(tscPath)) {
  console.error("未找到 TypeScript 编译器，请先在项目根目录执行 npm install。");
  process.exit(1);
}

run(process.execPath, [tscPath, "-p", "tsconfig.build.json"]);
run(process.execPath, [mainPath, ...process.argv.slice(2)]);
