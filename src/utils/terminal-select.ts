import { clearLine, moveCursor } from "node:readline";
import { stdin, stdout } from "node:process";

export type TerminalSelectItem = {
  value: string;
  label: string;
};

/** 解析方向键等按键；无法识别时返回 null。 */
export function parseTerminalSelectKey(input: string): "up" | "down" | "enter" | "cancel" | null {
  if (input.includes("\u0003")) {
    return "cancel";
  }
  if (input.includes("\r") || input.includes("\n")) {
    return "enter";
  }
  if (/\u001b\[A|\x1b\[A/.test(input)) {
    return "up";
  }
  if (/\u001b\[B|\x1b\[B/.test(input)) {
    return "down";
  }
  if (input === "\u001b" || input === "\x1b") {
    return "cancel";
  }
  return null;
}

/**
 * 终端方向键单选；非 TTY 时回退为当前选中项或首项。
 * ↑↓ 移动，Enter 确认，Esc/Ctrl+C 取消。
 */
export async function terminalSelect(
  items: readonly TerminalSelectItem[],
  title: string,
  hint = "↑↓ 选择，Enter 确认，Esc 取消",
  initialIndex = 0
): Promise<string | undefined> {
  if (!items.length) {
    return undefined;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    return items[Math.min(initialIndex, items.length - 1)]?.value ?? items[0]?.value;
  }

  let index = Math.min(Math.max(initialIndex, 0), items.length - 1);
  let renderedLines = 0;
  let pending = "";
  const previousRawMode = stdin.isTTY ? stdin.isRaw : false;

  const clearRenderedLines = (): void => {
    for (let line = 0; line < renderedLines; line++) {
      moveCursor(stdout, 0, -1);
      clearLine(stdout, 0);
    }
    renderedLines = 0;
  };

  const render = (): void => {
    if (renderedLines > 0) {
      stdout.write(`\x1b[${renderedLines}A\r`);
    }
    const lines = [
      title,
      ...items.map((item, itemIndex) => {
        const pointer = itemIndex === index ? "→ " : "  ";
        return `${pointer}${item.label}`;
      }),
      hint
    ];
    for (const line of lines) {
      stdout.write(`\x1b[2K\r${line}\n`);
    }
    renderedLines = lines.length;
  };

  return new Promise((resolve) => {
    const cleanup = (value: string | undefined): void => {
      stdin.off("data", onData);
      stdin.pause();
      clearRenderedLines();
      if (stdin.isTTY) {
        stdin.setRawMode(previousRawMode);
      }
      resolve(value);
    };

    const onData = (chunk: string): void => {
      pending += chunk;
      const key = parseTerminalSelectKey(pending);
      if (!key) {
        if (pending.length > 8) {
          pending = pending.slice(-4);
        }
        return;
      }
      pending = "";
      if (key === "up") {
        index = (index - 1 + items.length) % items.length;
        render();
        return;
      }
      if (key === "down") {
        index = (index + 1) % items.length;
        render();
        return;
      }
      if (key === "enter") {
        cleanup(items[index]?.value);
        return;
      }
      cleanup(undefined);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    render();
  });
}
