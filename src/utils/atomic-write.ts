import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let originalMode: number | undefined;
  try {
    originalMode = fs.statSync(filePath).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  try {
    const descriptor = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (originalMode !== undefined) {
      fs.chmodSync(temporary, originalMode & 0o7777);
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* 清理失败不覆盖原始异常 */
    }
    throw error;
  }
}
