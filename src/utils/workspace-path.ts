import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../types/errors.js";

function isInsideWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function resolveFromExistingAncestor(root: string, candidate: string): string {
  let existing = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      fs.lstatSync(existing);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new ToolError(`无法检查工作区路径：${candidate}`, { cause: error });
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new ToolError(`无法找到路径的已有父目录：${candidate}`);
      }
      missingSegments.unshift(path.basename(existing));
      existing = parent;
      continue;
    }

    let canonical: string;
    try {
      canonical = fs.realpathSync.native(existing);
    } catch (error) {
      throw new ToolError(`路径包含无法解析的符号链接或目录联接：${existing}`, {
        cause: error
      });
    }
    if (!isInsideWorkspace(root, canonical)) {
      throw new ToolError("只能访问工作区内的路径，符号链接或目录联接不能指向工作区外");
    }
    if (missingSegments.length && !fs.statSync(canonical).isDirectory()) {
      throw new ToolError(`路径的已有父级不是目录：${existing}`);
    }

    const resolved = path.resolve(canonical, ...missingSegments);
    if (!isInsideWorkspace(root, resolved)) {
      throw new ToolError("只能访问工作区内的路径，路径不能越界");
    }
    return resolved;
  }
}

export function resolveWorkspacePath(workspace: string, rawPath: string): string {
  const root = fs.realpathSync.native(path.resolve(workspace));
  if (!fs.statSync(root).isDirectory()) {
    throw new ToolError(`工作区路径不是目录：${root}`);
  }
  const candidate = path.resolve(root, rawPath.trim() || ".");
  if (!isInsideWorkspace(root, candidate)) {
    throw new ToolError("只能访问工作区内的路径，路径不能越界");
  }
  return resolveFromExistingAncestor(root, candidate);
}
